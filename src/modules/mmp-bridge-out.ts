/**
 * MMP Bridge OUT — выводит in-game items в on-chain ERC-20 (по умолчанию CORN_SEED).
 *
 * Полный flow (см. RESEARCH_STATUS.md, раздел "Inventory exports"):
 *   1. Логин в MMP API (signup → login → claimTxQuota).
 *   2. Проверка inventory: достаточно ли items нужного класса/типа.
 *   3. POST /inventory/exports/price → получить fee (wei) для msg.value.
 *   4. On-chain: Escrow.deposit([address(0)], [fee], wallet) с msg.value = fee.
 *   5. Из tx receipt парсим event Deposited → получаем `transaction_id`.
 *   6. POST /inventory/exports {items, nfts, transaction_id} →
 *      сервер ставит таску в очередь, возвращает pending_transaction_id.
 *   7. Polling /inventory/pending-transactions/{id} до status='completed'.
 *      После этого сервер сам выполнил Escrow.release() и заминтил CORN_SEED.
 *
 * Перед запуском у воркера должно быть:
 *   - ETH на газ + fee (>= price + ~0.0002 ETH запас на gas)
 *   - In-game items соответствующего класса/типа (Corn Seeds: class=110, type=2,
 *     по контракту в archive/box; точные class/type зависят от item-а)
 *
 * ENV:
 *   MMP_BRIDGE_OUT_CLASS — class id (default 110)
 *   MMP_BRIDGE_OUT_TYPE  — type id (default 2 для Corn Seed)
 *   MMP_BRIDGE_OUT_AMOUNT — сколько units (default 3, минимум для квеста)
 */
import { formatEther, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import {
  ESCROW_ABI,
  ESCROW_ADDRESS,
  MmpClient,
  NATIVE_TOKEN_ADDRESS,
  extractTransactionIdFromReceipt,
  isEscrowPaused
} from '../mmp-api/index.js'

interface BridgeOutParams {
  itemClass: number
  itemType: number
  amount: number
}

function getParams (): BridgeOutParams {
  const cls = Number(process.env['MMP_BRIDGE_OUT_CLASS'] ?? 110)
  const type = Number(process.env['MMP_BRIDGE_OUT_TYPE'] ?? 2)
  const amount = Number(process.env['MMP_BRIDGE_OUT_AMOUNT'] ?? 3)
  if (!Number.isInteger(cls) || cls <= 0) throw new Error(`Bad class: ${cls}`)
  if (!Number.isInteger(type) || type <= 0) throw new Error(`Bad type: ${type}`)
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Bad amount: ${amount}`)
  return { itemClass: cls, itemType: type, amount }
}

const publicClient = rpcManager.createPublicClient(soneiumChain)

interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  exportTransactionId?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  [key: string]: unknown
}

export async function performMmpBridgeOut (privateKey: `0x${string}`): Promise<ModuleResult> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const params = getParams()

    logger.info(
      `MMP Bridge-OUT: ${account.address}, class=${params.itemClass}, type=${params.itemType}, amount=${params.amount}`
    )

    // 0. Escrow проверка
    if (await isEscrowPaused(publicClient)) {
      const msg = 'Escrow контракт на паузе — bridge OUT недоступен'
      logger.warn(msg)
      return { success: false, walletAddress: account.address, skipped: true, reason: msg, error: msg, message: msg }
    }

    // 1. Логин в MMP
    const client = new MmpClient(privateKey)
    let loginData
    try {
      loginData = await client.signupAndLogin()
      logger.info(`Logged in to MMP: sessionToken=${client.session.slice(0, 8)}…`)
    } catch (e) {
      const msg = `MMP login failed: ${e instanceof Error ? e.message : e}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }

    // tx-quota: первая попытка может вернуть 500 если subscription не выдана,
    // но это не блокер для bridge — ловим, но не падаем.
    try { await client.claimTxQuota() } catch (e) {
      logger.debug(`claimTxQuota: ${e instanceof Error ? e.message : e}`)
    }

    // 2. Проверка inventory
    let availableAmount = 0
    try {
      const inv = await client.getInventoryItems()
      const items = inv?.data?.items as Array<{ class?: number, type?: number, amount?: number }> | null
      const matched = items?.find(i => i.class === params.itemClass && i.type === params.itemType)
      availableAmount = Number(matched?.amount ?? 0)
    } catch (e) {
      logger.warn(`getInventoryItems: ${e instanceof Error ? e.message : e}`)
    }

    if (availableAmount < params.amount) {
      const msg = `Недостаточно items в in-game inventory: есть ${availableAmount}, нужно ${params.amount} (class=${params.itemClass}, type=${params.itemType})`
      logger.warn(msg)
      return { success: false, walletAddress: account.address, skipped: true, reason: msg, error: msg, message: msg }
    }

    // 3. Цена
    const price = await client.getExportsPrice([
      { class: params.itemClass, type: params.itemType, amount: params.amount }
    ])
    const feeWei = BigInt(price.price)
    logger.info(`Export fee: ${formatEther(feeWei)} ETH (${feeWei} wei)`)

    // 4. ETH balance check
    const ethBalance = await publicClient.getBalance({ address: account.address })
    const gasReserve = 200_000_000_000_000n // 0.0002 ETH запас на газ
    if (ethBalance < feeWei + gasReserve) {
      const msg = `Недостаточно ETH: ${formatEther(ethBalance)}, нужно ≥ ${formatEther(feeWei + gasReserve)} (fee+газ)`
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }

    // 5. Escrow.deposit
    logger.info(`Calling Escrow.deposit on ${ESCROW_ADDRESS}`)
    const depositResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'deposit',
        args: [
          [NATIVE_TOKEN_ADDRESS] as Address[],
          [feeWei] as bigint[],
          account.address as Address
        ],
        value: feeWei
      }
    )
    if (!depositResult.success) {
      const msg = `Escrow.deposit failed: ${depositResult.error}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }

    const depositHash = depositResult.hash
    logger.transaction(depositHash, 'sent', 'MMP-BRIDGE-OUT-DEPOSIT')

    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash })
    if (receipt.status !== 'success') {
      const msg = `Escrow.deposit reverted: ${depositHash}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, transactionHash: depositHash, error: msg, message: msg }
    }
    logger.transaction(depositHash, 'confirmed', 'MMP-BRIDGE-OUT-DEPOSIT', account.address)

    // 6. Извлечь transactionId из event Deposited
    let transactionId: bigint
    try {
      transactionId = extractTransactionIdFromReceipt(receipt)
    } catch (e) {
      const msg = `Не удалось получить transaction_id из event Deposited: ${e instanceof Error ? e.message : e}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, transactionHash: depositHash, error: msg, message: msg }
    }
    const transactionIdStr = transactionId.toString()
    logger.info(`Deposited.transactionId = ${transactionIdStr}`)

    // 7. POST /inventory/exports
    logger.info(`POST /v1/inventory/exports with transaction_id=${transactionIdStr}`)
    const exportResp = await client.inventoryExport(
      transactionIdStr,
      [{ class: params.itemClass, type: params.itemType, amount: params.amount }]
    )

    const queueId = exportResp.pending_transaction_id
      ?? exportResp.tx_queue_id
      ?? exportResp.queue_id
    if (queueId) {
      logger.info(`Bridge-OUT pending queue id: ${queueId}`)
      try {
        const finalStatus = await client.waitForPendingTransaction(queueId, { timeoutMs: 180_000 })
        logger.success(`Bridge-OUT финализировался: ${JSON.stringify(finalStatus)}`)
      } catch (e) {
        const msg = `Polling pending tx упал: ${e instanceof Error ? e.message : e}`
        logger.warn(msg)
        return {
          success: false,
          walletAddress: account.address,
          transactionHash: depositHash,
          exportTransactionId: transactionIdStr,
          error: msg,
          message: msg
        }
      }
    } else {
      logger.warn('Сервер не вернул pending_transaction_id; полагаемся на on-chain release сервером.')
    }

    return {
      success: true,
      walletAddress: account.address,
      transactionHash: depositHash,
      exportTransactionId: transactionIdStr,
      message: `Bridge OUT выполнен: ${params.amount} units (class=${params.itemClass}, type=${params.itemType}) → on-chain (login=${loginData.user.id.slice(0, 6)}…)`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка модуля mmp-bridge-out', error)
    return { success: false, error: msg, message: msg }
  }
}
