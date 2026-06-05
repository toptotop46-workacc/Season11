/**
 * MMP Bridge IN — заносит on-chain ERC-20 (CORN_SEED по умолчанию) в in-game inventory.
 *
 * Полный flow (см. RESEARCH_STATUS.md):
 *   1. Логин в MMP API.
 *   2. ERC-20 approve(token, escrow, amount), если allowance меньше нужного.
 *   3. On-chain: Escrow.deposit([token], [amount], wallet) (без msg.value).
 *   4. Из tx receipt парсим event Deposited → transactionId.
 *   5. POST /inventory/imports {items, nfts, transaction_id}.
 *   6. Polling /inventory/pending-transactions/{id} до status='completed'.
 *
 * ENV (опционально):
 *   MMP_BRIDGE_IN_TOKEN — адрес ERC-20 (default CORN_SEED).
 *   MMP_BRIDGE_IN_AMOUNT — кол-во в "штучных" единицах (default 3).
 *   MMP_BRIDGE_IN_CLASS — class id (default 110).
 *   MMP_BRIDGE_IN_TYPE  — type id (default 2 — Corn Seed).
 *   MMP_BRIDGE_IN_DECIMALS — decimals токена (default из контракта).
 */
import { formatUnits, parseUnits, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import {
  ERC20_MIN_ABI,
  ESCROW_ABI,
  ESCROW_ADDRESS,
  MMP_TOKEN_ADDRESSES,
  MmpClient,
  extractTransactionIdFromReceipt,
  isEscrowPaused
} from '../mmp-api/index.js'

const MAX_UINT256 = (1n << 256n) - 1n

const publicClient = rpcManager.createPublicClient(soneiumChain)

interface BridgeInParams {
  tokenAddress: Address
  amount: number
  itemClass: number
  itemType: number
  decimalsOverride: number | null
}

function getParams (): BridgeInParams {
  const tokenAddress = (process.env['MMP_BRIDGE_IN_TOKEN'] ?? MMP_TOKEN_ADDRESSES.cornSeed) as Address
  const amount = Number(process.env['MMP_BRIDGE_IN_AMOUNT'] ?? 3)
  const itemClass = Number(process.env['MMP_BRIDGE_IN_CLASS'] ?? 110)
  const itemType = Number(process.env['MMP_BRIDGE_IN_TYPE'] ?? 2)
  const decimalsOverrideRaw = process.env['MMP_BRIDGE_IN_DECIMALS']
  const decimalsOverride = decimalsOverrideRaw === undefined
    ? null
    : Number(decimalsOverrideRaw)

  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Bad amount: ${amount}`)
  if (!Number.isInteger(itemClass) || itemClass <= 0) throw new Error(`Bad class: ${itemClass}`)
  if (!Number.isInteger(itemType) || itemType <= 0) throw new Error(`Bad type: ${itemType}`)
  return { tokenAddress, amount, itemClass, itemType, decimalsOverride }
}

interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  approveTransactionHash?: string | undefined
  importTransactionId?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  [key: string]: unknown
}

export async function performMmpBridgeIn (privateKey: `0x${string}`): Promise<ModuleResult> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const params = getParams()

    logger.info(
      `MMP Bridge-IN: ${account.address}, token=${params.tokenAddress}, amount=${params.amount}, class=${params.itemClass}, type=${params.itemType}`
    )

    if (await isEscrowPaused(publicClient)) {
      const msg = 'Escrow контракт на паузе — bridge IN недоступен'
      logger.warn(msg)
      return { success: false, walletAddress: account.address, skipped: true, reason: msg, error: msg, message: msg }
    }

    // Decimals токена
    const decimals = params.decimalsOverride ?? Number(await publicClient.readContract({
      address: params.tokenAddress,
      abi: ERC20_MIN_ABI,
      functionName: 'decimals'
    }) as number)

    const amountRaw = parseUnits(params.amount.toString(), decimals)

    // Balance check
    const tokenBalance = await publicClient.readContract({
      address: params.tokenAddress,
      abi: ERC20_MIN_ABI,
      functionName: 'balanceOf',
      args: [account.address]
    }) as bigint
    if (tokenBalance < amountRaw) {
      const msg = `Недостаточно токена ${params.tokenAddress}: ` +
        `${formatUnits(tokenBalance, decimals)} < ${formatUnits(amountRaw, decimals)}`
      logger.warn(msg)
      return { success: false, walletAddress: account.address, skipped: true, reason: msg, error: msg, message: msg }
    }

    // Логин MMP
    const client = new MmpClient(privateKey)
    try {
      await client.signupAndLogin()
      logger.info(`Logged in to MMP: sessionToken=${client.session.slice(0, 8)}…`)
    } catch (e) {
      const msg = `MMP login failed: ${e instanceof Error ? e.message : e}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }
    try { await client.claimTxQuota() } catch (e) {
      logger.debug(`claimTxQuota: ${e instanceof Error ? e.message : e}`)
    }

    // Approve если нужно
    let approveHash: `0x${string}` | undefined
    const allowance = await publicClient.readContract({
      address: params.tokenAddress,
      abi: ERC20_MIN_ABI,
      functionName: 'allowance',
      args: [account.address, ESCROW_ADDRESS]
    }) as bigint

    if (allowance < amountRaw) {
      logger.info(`Allowance ниже требуемого, делаем approve(escrow, MAX_UINT256)`)
      const approveResult = await safeWriteContract(
        publicClient,
        walletClient,
        account.address,
        {
          chain: soneiumChain,
          account,
          address: params.tokenAddress,
          abi: ERC20_MIN_ABI,
          functionName: 'approve',
          args: [ESCROW_ADDRESS, MAX_UINT256]
        }
      )
      if (!approveResult.success) {
        const msg = `approve failed: ${approveResult.error}`
        logger.error(msg)
        return { success: false, walletAddress: account.address, error: msg, message: msg }
      }
      approveHash = approveResult.hash
      logger.transaction(approveHash, 'sent', 'MMP-BRIDGE-IN-APPROVE')
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (approveReceipt.status !== 'success') {
        const msg = `approve reverted: ${approveHash}`
        logger.error(msg)
        return { success: false, walletAddress: account.address, approveTransactionHash: approveHash, error: msg, message: msg }
      }
      logger.transaction(approveHash, 'confirmed', 'MMP-BRIDGE-IN-APPROVE', account.address)
    } else {
      logger.info('Достаточный allowance — approve не нужен')
    }

    // Escrow.deposit
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
          [params.tokenAddress] as Address[],
          [amountRaw] as bigint[],
          account.address as Address
        ]
      }
    )
    if (!depositResult.success) {
      const msg = `Escrow.deposit failed: ${depositResult.error}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        approveTransactionHash: approveHash,
        error: msg,
        message: msg
      }
    }
    const depositHash = depositResult.hash
    logger.transaction(depositHash, 'sent', 'MMP-BRIDGE-IN-DEPOSIT')

    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash })
    if (receipt.status !== 'success') {
      const msg = `Escrow.deposit reverted: ${depositHash}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        approveTransactionHash: approveHash,
        transactionHash: depositHash,
        error: msg,
        message: msg
      }
    }
    logger.transaction(depositHash, 'confirmed', 'MMP-BRIDGE-IN-DEPOSIT', account.address)

    let transactionId: bigint
    try {
      transactionId = extractTransactionIdFromReceipt(receipt)
    } catch (e) {
      const msg = `Не удалось получить transaction_id: ${e instanceof Error ? e.message : e}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        approveTransactionHash: approveHash,
        transactionHash: depositHash,
        error: msg,
        message: msg
      }
    }
    const transactionIdStr = transactionId.toString()
    logger.info(`Deposited.transactionId = ${transactionIdStr}`)

    const importResp = await client.inventoryImport(
      transactionIdStr,
      [{ class: params.itemClass, type: params.itemType, amount: params.amount }]
    )
    const queueId = importResp.pending_transaction_id
      ?? importResp.tx_queue_id
      ?? importResp.queue_id
    if (queueId) {
      logger.info(`Bridge-IN pending queue id: ${queueId}`)
      try {
        const finalStatus = await client.waitForPendingTransaction(queueId, { timeoutMs: 180_000 })
        logger.success(`Bridge-IN финализировался: ${JSON.stringify(finalStatus)}`)
      } catch (e) {
        const msg = `Polling pending tx упал: ${e instanceof Error ? e.message : e}`
        logger.warn(msg)
        return {
          success: false,
          walletAddress: account.address,
          approveTransactionHash: approveHash,
          transactionHash: depositHash,
          importTransactionId: transactionIdStr,
          error: msg,
          message: msg
        }
      }
    }

    return {
      success: true,
      walletAddress: account.address,
      approveTransactionHash: approveHash,
      transactionHash: depositHash,
      importTransactionId: transactionIdStr,
      message: `Bridge IN выполнен: ${params.amount} units token=${params.tokenAddress} → in-game inventory`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка модуля mmp-bridge-in', error)
    return { success: false, error: msg, message: msg }
  }
}
