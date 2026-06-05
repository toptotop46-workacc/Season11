import { formatEther, formatUnits, parseUnits, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import {
  checkMmpPortalProgress,
  MMP_QUEST_DAPP_ID,
  type MmpPortalQuestProgress
} from './mmp-portal-check.js'

/**
 * Контракты Morning Moon Pocket (Soneium production).
 * Источник: cdn.morningmoonpocket.com/.../contract-manifest-soneium-production.json
 *
 * Все 4 SmartFarmerInitializable фермы используют один и тот же ABI.
 * Каждая принимает свой Crop20 токен-семя в качестве stakedToken и выдаёт Crop20 урожай как rewardToken.
 * Контракт MAINTAINER: команда Morning Moon Pocket (deployer 0xfee2c8a3.. и operator 0x5112a3..).
 */
const MMP_CONTRACTS = {
  cornSeed: {
    farm: '0x63bA28fB04b4130557EE7810d829689dF4AC3845',
    token: '0xda1aD7DbB1e84CDF99b046a0b872179250818b20',
    label: 'Corn'
  },
  cabbageSeed: {
    farm: '0x9e5bf4FaD0a26444509d42BBe5482F36066f091c',
    token: '0x41C7180CDD4245F56481F9613B8B9eE0b80E8046',
    label: 'Cabbage'
  },
  carrotSeed: {
    farm: '0x281424b63b38F96A6D5C9D5e869EB1d0CFD82BB2',
    token: '0x062a8648f9F21Df2E9bb18b988C316CCF055247D',
    label: 'Carrot'
  },
  tomatoSeed: {
    farm: '0xe33fF006Ba78797984930bea5bCA607457A58f93',
    token: '0xaeFf687E6D12dff7F715A26E17AF9847B640301B',
    label: 'Tomato'
  }
} as const

type FarmKind = keyof typeof MMP_CONTRACTS

/** Какую ферму использовать. По квесту Soneium Score Season 10 — Corn. */
const FARM_KIND: FarmKind = 'cornSeed'

/**
 * Целевое количество семян для посадки. Квест требует ≥ 3.
 * Можно увеличить если на балансе больше семян и мы хотим зафиксировать большую долю в стейкинге.
 */
const PLANT_TARGET_SEEDS = 3n

const MAX_UINT256 = (1n << 256n) - 1n
const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/** ABI SmartFarmerInitializable (только методы которые мы используем). */
const FARM_ABI = [
  {
    inputs: [{ internalType: 'uint256', name: '_amount', type: 'uint256' }],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'harvest',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
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
  },
  {
    inputs: [{ internalType: 'address', name: '_user', type: 'address' }],
    name: 'pendingReward',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  { inputs: [], name: 'paused', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'startBlock', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'numBlockToWither', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'poolMinPerUser', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'poolLimitPerUser', outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'hasUserLimit', outputs: [{ internalType: 'bool', name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'stakedToken', outputs: [{ internalType: 'address', name: '', type: 'address' }], stateMutability: 'view', type: 'function' }
] as const

/** Минимальный ERC20 ABI — balanceOf, allowance, approve, decimals, symbol. */
const ERC20_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'owner', type: 'address' },
      { internalType: 'address', name: 'spender', type: 'address' }
    ],
    name: 'allowance',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'address', name: 'spender', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' }
    ],
    name: 'approve',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  { inputs: [], name: 'decimals', outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'symbol', outputs: [{ internalType: 'string', name: '', type: 'string' }], stateMutability: 'view', type: 'function' }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

interface FarmReadState {
  farm: Address
  token: Address
  label: string
  paused: boolean
  poolMinPerUser: bigint
  poolLimitPerUser: bigint
  hasUserLimit: boolean
  stakedTokenSymbol: string
  stakedTokenDecimals: number
  userAmount: bigint
  pendingReward: bigint
  walletEthBalance: bigint
  walletSeedBalance: bigint
  allowanceFarm: bigint
}

async function readFarmState (
  walletAddress: Address,
  farm: { farm: string, token: string, label: string }
): Promise<FarmReadState> {
  const farmAddr = farm.farm as Address
  const tokenAddr = farm.token as Address

  const [
    paused,
    poolMinPerUser,
    poolLimitPerUser,
    hasUserLimit,
    decimals,
    symbol,
    seedBalance,
    allowanceFarm,
    userInfo,
    pending,
    ethBalance
  ] = await Promise.all([
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'paused' }),
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'poolMinPerUser' }),
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'poolLimitPerUser' }),
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'hasUserLimit' }),
    publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress] }),
    publicClient.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance', args: [walletAddress, farmAddr] }),
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'userInfo', args: [walletAddress] }),
    publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'pendingReward', args: [walletAddress] }),
    publicClient.getBalance({ address: walletAddress })
  ])

  return {
    farm: farmAddr,
    token: tokenAddr,
    label: farm.label,
    paused: paused as boolean,
    poolMinPerUser: poolMinPerUser as bigint,
    poolLimitPerUser: poolLimitPerUser as bigint,
    hasUserLimit: hasUserLimit as boolean,
    stakedTokenSymbol: symbol as string,
    stakedTokenDecimals: decimals as number,
    userAmount: (userInfo as readonly bigint[])[1] ?? 0n,
    pendingReward: pending as bigint,
    walletSeedBalance: seedBalance as bigint,
    allowanceFarm: allowanceFarm as bigint,
    walletEthBalance: ethBalance
  }
}

function formatSeeds (raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals)
}

function logFarmState (state: FarmReadState, walletAddress: string): void {
  logger.info(`MMP-Farm ${state.label}: ${state.farm}`)
  logger.info(`  staked token ${state.stakedTokenSymbol} (decimals=${state.stakedTokenDecimals}): ${state.token}`)
  logger.info(`  paused: ${state.paused}, hasUserLimit: ${state.hasUserLimit}`)
  logger.info(`  poolMinPerUser: ${formatSeeds(state.poolMinPerUser, state.stakedTokenDecimals)}`)
  logger.info(`  poolLimitPerUser: ${formatSeeds(state.poolLimitPerUser, state.stakedTokenDecimals)}`)
  logger.info(`Wallet ${walletAddress}:`)
  logger.info(`  ETH: ${formatEther(state.walletEthBalance)}`)
  logger.info(`  ${state.stakedTokenSymbol}: ${formatSeeds(state.walletSeedBalance, state.stakedTokenDecimals)}`)
  logger.info(`  allowance(farm): ${formatSeeds(state.allowanceFarm, state.stakedTokenDecimals)}`)
  logger.info(`  userInfo.amount (already planted): ${formatSeeds(state.userAmount, state.stakedTokenDecimals)}`)
  logger.info(`  pendingReward: ${formatSeeds(state.pendingReward, state.stakedTokenDecimals)}`)
}

/**
 * Основная функция модуля: проверяет состояние, при необходимости делает approve, затем deposit.
 * Возвращает стандартный результат для системы run-module / parallel-executor.
 */
export async function performMmpFarmPlant (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  approveTransactionHash?: string | undefined
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const farmConfig = MMP_CONTRACTS[FARM_KIND]
    logger.info(`MMP-Farm: посадка ${farmConfig.label} семян для ${account.address}`)

    // ----------------------------------------------------------
    // PORTAL GATE — авторитетная проверка прогресса квеста.
    // На портале counter увеличивается с каждым deposit в Corn Farm.
    // Если completed ≥ required → не делаем второй deposit (он засорит
    // статистику пользователя 2/1, 4/1 и не даст никаких бонусов).
    // ----------------------------------------------------------
    let portalProgress: MmpPortalQuestProgress
    try {
      portalProgress = await checkMmpPortalProgress(account.address)
    } catch (e) {
      const msg = `Portal-check провалился: ${(e as Error).message}`
      logger.error(msg)
      return { success: false, walletAddress: account.address, error: msg, message: msg }
    }
    logger.info(
      `Portal ${MMP_QUEST_DAPP_ID}: completed=${portalProgress.completed}/${portalProgress.required} ` +
      `isDone=${portalProgress.isDone} found=${portalProgress.found}`
    )
    if (!portalProgress.found) {
      const msg = `Quest ${MMP_QUEST_DAPP_ID} не найден в portal — возможно неактивен`
      logger.warn(msg)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: msg,
        message: msg
      }
    }
    if (portalProgress.isDone || portalProgress.completed >= portalProgress.required) {
      const msg = `MMP quest уже выполнен на portal: ${portalProgress.completed}/${portalProgress.required} (isDone=${portalProgress.isDone})`
      logger.success(msg)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: msg,
        message: msg
      }
    }

    const state = await readFarmState(account.address, farmConfig)
    logFarmState(state, account.address)

    if (state.paused) {
      const msg = `Ферма ${state.label} на паузе — посадка невозможна`
      logger.warn(msg)
      return {
        success: false,
        walletAddress: account.address,
        skipped: true,
        reason: msg,
        error: msg,
        message: msg
      }
    }

    if (state.walletEthBalance === 0n) {
      const msg = 'Недостаточно ETH для оплаты газа (0 wei)'
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        error: msg,
        message: msg
      }
    }

    // Целевое количество семян для посадки. Минимум — 3 (квест) или poolMinPerUser, если он больше.
    const wantSeedsRaw = parseUnits(PLANT_TARGET_SEEDS.toString(), state.stakedTokenDecimals)
    const minRequired = state.poolMinPerUser > wantSeedsRaw ? state.poolMinPerUser : wantSeedsRaw
    const willPlantRaw = state.walletSeedBalance < minRequired ? 0n : minRequired

    if (willPlantRaw === 0n) {
      const msg =
        `Недостаточно ${state.stakedTokenSymbol} на балансе. ` +
        `Есть: ${formatSeeds(state.walletSeedBalance, state.stakedTokenDecimals)}, ` +
        `надо ≥ ${formatSeeds(minRequired, state.stakedTokenDecimals)} (квест требует ≥ ${PLANT_TARGET_SEEDS}). ` +
        'Получите семена через игру https://play.morningmoonpocket.com/ или transfer с другого кошелька.'
      logger.warn(msg)
      return {
        success: false,
        walletAddress: account.address,
        skipped: true,
        reason: msg,
        error: msg,
        message: msg
      }
    }

    if (state.hasUserLimit && state.poolLimitPerUser > 0n) {
      const totalAfter = state.userAmount + willPlantRaw
      if (totalAfter > state.poolLimitPerUser) {
        const msg =
          `Посадка превысит poolLimitPerUser (${formatSeeds(state.poolLimitPerUser, state.stakedTokenDecimals)}). ` +
          `Уже посажено ${formatSeeds(state.userAmount, state.stakedTokenDecimals)}, пытаемся добавить ` +
          `${formatSeeds(willPlantRaw, state.stakedTokenDecimals)}.`
        logger.warn(msg)
        return {
          success: false,
          walletAddress: account.address,
          skipped: true,
          reason: msg,
          error: msg,
          message: msg
        }
      }
    }

    // approve если allowance не покрывает планируемую сумму. Используем MAX_UINT256, как в реальных tx игроков.
    let approveTxHash: `0x${string}` | undefined
    if (state.allowanceFarm < willPlantRaw) {
      logger.info(`Allowance ниже требуемого, делаем approve(farm, MAX_UINT256)`)
      const approveResult = await safeWriteContract(
        publicClient,
        walletClient,
        account.address,
        {
          chain: soneiumChain,
          account,
          address: state.token,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [state.farm, MAX_UINT256]
        }
      )
      if (!approveResult.success) {
        const msg = `Ошибка approve: ${approveResult.error}`
        logger.error(msg)
        return {
          success: false,
          walletAddress: account.address,
          error: msg,
          message: msg
        }
      }
      approveTxHash = approveResult.hash
      logger.transaction(approveTxHash, 'sent', 'MMP-FARM-APPROVE')
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
      if (approveReceipt.status !== 'success') {
        const msg = `Approve транзакция откатилась: ${approveTxHash}`
        logger.error(msg)
        return {
          success: false,
          walletAddress: account.address,
          approveTransactionHash: approveTxHash,
          error: msg,
          message: msg
        }
      }
      logger.transaction(approveTxHash, 'confirmed', 'MMP-FARM-APPROVE', account.address)
    } else {
      logger.info('Достаточный allowance — approve не нужен')
    }

    // deposit
    logger.info(`Сажаем ${formatSeeds(willPlantRaw, state.stakedTokenDecimals)} ${state.stakedTokenSymbol} на ферму ${state.label}`)
    const depositResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: state.farm,
        abi: FARM_ABI,
        functionName: 'deposit',
        args: [willPlantRaw]
      }
    )
    if (!depositResult.success) {
      const msg = `Ошибка deposit: ${depositResult.error}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        approveTransactionHash: approveTxHash,
        error: msg,
        message: msg
      }
    }

    const depositHash = depositResult.hash
    logger.transaction(depositHash, 'sent', 'MMP-FARM-DEPOSIT')
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash })
    if (depositReceipt.status !== 'success') {
      const msg = `Deposit транзакция откатилась: ${depositHash}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        approveTransactionHash: approveTxHash,
        transactionHash: depositHash,
        error: msg,
        message: msg
      }
    }
    logger.transaction(depositHash, 'confirmed', 'MMP-FARM-DEPOSIT', account.address)

    return {
      success: true,
      walletAddress: account.address,
      approveTransactionHash: approveTxHash,
      transactionHash: depositHash,
      message: `Посажено ${formatSeeds(willPlantRaw, state.stakedTokenDecimals)} ${state.stakedTokenSymbol} на ферму ${state.label}`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка модуля mmp-farm', error)
    return {
      success: false,
      error: msg,
      message: msg
    }
  }
}

/**
 * Дополнительная функция: harvest. Вызывает harvest() на ферме (если есть pendingReward, заберёт его).
 * Если посаженная сумма "увяла" (numBlockToWither прошёл), деpending=0; harvest() сам сбросит депозит.
 */
export async function performMmpFarmHarvest (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const farmConfig = MMP_CONTRACTS[FARM_KIND]

    logger.info(`MMP-Farm harvest: ${farmConfig.label} для ${account.address}`)

    const farmAddr = farmConfig.farm as Address
    const [userInfo, pending] = await Promise.all([
      publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'userInfo', args: [account.address] }),
      publicClient.readContract({ address: farmAddr, abi: FARM_ABI, functionName: 'pendingReward', args: [account.address] })
    ])
    const userAmount = (userInfo as readonly bigint[])[1] ?? 0n
    const pendingAmount = pending as bigint

    if (userAmount === 0n && pendingAmount === 0n) {
      const msg = `Нечего собирать на ферме ${farmConfig.label}`
      logger.info(msg)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: msg,
        message: msg
      }
    }

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: farmAddr,
        abi: FARM_ABI,
        functionName: 'harvest'
      }
    )
    if (!txResult.success) {
      const msg = `Ошибка harvest: ${txResult.error}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        error: msg,
        message: msg
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'MMP-FARM-HARVEST')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      const msg = `Harvest транзакция откатилась: ${hash}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: msg,
        message: msg
      }
    }
    logger.transaction(hash, 'confirmed', 'MMP-FARM-HARVEST', account.address)

    return {
      success: true,
      walletAddress: account.address,
      transactionHash: hash,
      message: `Harvest выполнен на ${farmConfig.label}`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка mmp-farm harvest', error)
    return {
      success: false,
      error: msg,
      message: msg
    }
  }
}

export {
  MMP_CONTRACTS,
  FARM_KIND,
  PLANT_TARGET_SEEDS,
  PERMIT2_ADDRESS,
  FARM_ABI,
  ERC20_ABI
}
