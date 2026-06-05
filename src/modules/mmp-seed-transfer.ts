import { formatUnits, parseUnits, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { MMP_TOKEN_ADDRESSES, MMP_CONTRACT_ADDRESSES } from '../mmp-api/index.js'

/**
 * MMP Seed Transfer — раздача CORN_SEED-токенов с одного донорского кошелька
 * на N рабочих, чтобы каждый воркер мог потом запустить mmp-farm.
 *
 * Контекст:
 *   - Quest Soneium S10 "plant 3 corn seeds" требует ≥3 CORN_SEED в стейкинге
 *     на ферме `Farm Corn-Seed` (mmp-farm уже это делает on-chain).
 *   - Получить семена через игровой API НЕЛЬЗЯ (anti-cheat валидация
 *     wild-зоны + missing transaction_id endpoint, см. RESEARCH_STATUS.md).
 *   - Поэтому семена надо завести один раз вручную через UI игры на
 *     "донорский" кошелёк, а дальше распределять обычным ERC-20 transfer.
 *
 * Использование (в текущей session-based архитектуре модулей):
 *   1) Перед запуском в env установить MMP_DONOR_PRIVATE_KEY (или MMP_SEED_DONOR_PK).
 *      Это приватник кошелька, на котором лежат CORN_SEED'ы.
 *   2) Запустить `npm run mmp-seed-transfer` (модуль вызывается с воркер-ключом
 *      из keys.txt, как все остальные модули).
 *   3) Модуль сам определит, сколько семян нужно довезти на воркер
 *      (учитывая то, что уже посажено на ферме), и сделает transfer от донора.
 *
 * После прогона модуля:
 *   - На воркере должно быть ≥ MMP_TARGET_SEEDS (по умолчанию 3) CORN_SEED.
 *   - Можно запускать `npm run mmp-farm` чтобы задепозитить.
 */

/** Сколько семян хотим довезти каждому воркеру (минимум для квеста — 3). */
const MMP_TARGET_SEEDS = 3n

const ERC20_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  { inputs: [], name: 'decimals', outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'symbol', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

const FARM_USERINFO_ABI = [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'userInfo',
    outputs: [
      { internalType: 'uint256', name: 'userIndex', type: 'uint256' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'rewardDebt', type: 'uint256' },
      { internalType: 'uint256', name: 'depositBlock', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const CORN_SEED = MMP_TOKEN_ADDRESSES.cornSeed as Address
const FARM_CORN = MMP_CONTRACT_ADDRESSES.farmCornSeed as Address

const publicClient = rpcManager.createPublicClient(soneiumChain)

function getDonorPrivateKey (): `0x${string}` | null {
  const raw = process.env['MMP_DONOR_PRIVATE_KEY'] ?? process.env['MMP_SEED_DONOR_PK']
  if (!raw) return null
  const trimmed = raw.trim()
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  if (!/^0x[a-fA-F0-9]{64}$/.test(withPrefix)) {
    throw new Error('MMP_DONOR_PRIVATE_KEY имеет неверный формат (ожидается 0x + 64 hex)')
  }
  return withPrefix as `0x${string}`
}

interface SeedState {
  walletBalance: bigint
  farmStaked: bigint
  totalAvailable: bigint
  decimals: number
  symbol: string
}

async function readSeedState (account: Address): Promise<SeedState> {
  const [walletBalance, farmInfo, decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: CORN_SEED, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: FARM_CORN, abi: FARM_USERINFO_ABI, functionName: 'userInfo', args: [account] }),
    publicClient.readContract({ address: CORN_SEED, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: CORN_SEED, abi: ERC20_ABI, functionName: 'symbol' })
  ])
  const farmStaked = (farmInfo as readonly bigint[])[1] ?? 0n
  return {
    walletBalance: walletBalance as bigint,
    farmStaked,
    totalAvailable: (walletBalance as bigint) + farmStaked,
    decimals: decimals as number,
    symbol: symbol as string
  }
}

export async function performMmpSeedTransfer (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const workerAccount = privateKeyToAccount(privateKey)
    const workerAddr = workerAccount.address

    const donorPk = getDonorPrivateKey()
    if (!donorPk) {
      const msg = 'MMP_DONOR_PRIVATE_KEY не задан в env. Задайте приватник донорского кошелька (на котором лежит CORN_SEED).'
      logger.warn(msg)
      return { success: false, walletAddress: workerAddr, skipped: true, reason: msg, error: msg, message: msg }
    }

    const donorAccount = privateKeyToAccount(donorPk)
    if (donorAccount.address.toLowerCase() === workerAddr.toLowerCase()) {
      const msg = 'Донорский кошелёк совпадает с воркером — пропуск (донор не должен быть в keys.txt одновременно).'
      logger.info(msg)
      return { success: true, walletAddress: workerAddr, skipped: true, reason: msg, message: msg }
    }

    logger.info(`MMP-Seed-Transfer: воркер ${workerAddr}, донор ${donorAccount.address}`)

    const workerState = await readSeedState(workerAddr)
    const targetRaw = parseUnits(MMP_TARGET_SEEDS.toString(), workerState.decimals)
    const fmt = (v: bigint) => formatUnits(v, workerState.decimals)

    logger.info(`  Воркер ${workerState.symbol}: wallet=${fmt(workerState.walletBalance)}, farm=${fmt(workerState.farmStaked)}, total=${fmt(workerState.totalAvailable)} / target ${MMP_TARGET_SEEDS}`)

    if (workerState.totalAvailable >= targetRaw) {
      const msg = `На воркере достаточно семян (${fmt(workerState.totalAvailable)} ≥ ${MMP_TARGET_SEEDS}). Можно сразу запускать mmp-farm.`
      logger.info(msg)
      return { success: true, walletAddress: workerAddr, skipped: true, reason: msg, message: msg }
    }

    const needRaw = targetRaw - workerState.totalAvailable

    const donorBalance = await publicClient.readContract({
      address: CORN_SEED,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [donorAccount.address]
    })
    logger.info(`  На доноре ${workerState.symbol}: ${fmt(donorBalance as bigint)}`)

    if ((donorBalance as bigint) < needRaw) {
      const msg = `Недостаточно ${workerState.symbol} на доноре. Есть: ${fmt(donorBalance as bigint)}, нужно перевести ${fmt(needRaw)}. Доложите семена на донор через UI игры.`
      logger.error(msg)
      return { success: false, walletAddress: workerAddr, error: msg, message: msg }
    }

    const donorEth = await publicClient.getBalance({ address: donorAccount.address })
    if (donorEth === 0n) {
      const msg = `На доноре 0 ETH — нечем оплатить газ для transfer. Пополните ${donorAccount.address}.`
      logger.error(msg)
      return { success: false, walletAddress: workerAddr, error: msg, message: msg }
    }

    const donorWalletClient = rpcManager.createWalletClient(soneiumChain, donorAccount)
    const txResult = await safeWriteContract(
      publicClient,
      donorWalletClient,
      donorAccount.address,
      {
        chain: soneiumChain,
        account: donorAccount,
        address: CORN_SEED,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [workerAddr, needRaw]
      }
    )
    if (!txResult.success) {
      const msg = `Ошибка transfer ${workerState.symbol} от донора: ${txResult.error}`
      logger.error(msg)
      return { success: false, walletAddress: workerAddr, error: msg, message: msg }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'MMP-SEED-TRANSFER')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      const msg = `Transfer транзакция откатилась: ${hash}`
      logger.error(msg)
      return { success: false, walletAddress: workerAddr, transactionHash: hash, error: msg, message: msg }
    }
    logger.transaction(hash, 'confirmed', 'MMP-SEED-TRANSFER', donorAccount.address)

    const message = `Переведено ${fmt(needRaw)} ${workerState.symbol} с ${donorAccount.address} → ${workerAddr}`
    logger.success(message)
    return {
      success: true,
      walletAddress: workerAddr,
      transactionHash: hash,
      message
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка модуля mmp-seed-transfer', error)
    return { success: false, error: msg, message: msg }
  }
}

export {
  MMP_TARGET_SEEDS,
  CORN_SEED,
  FARM_CORN
}
