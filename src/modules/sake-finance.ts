import { formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адреса контрактов Sake Finance
const L2_POOL_INSTANCE = '0x3c3987a310ee13f7b8cbbe21d97d4436ba5e4b5f' // L2PoolInstance контракт
const A_TOKEN_INSTANCE = '0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726' // ATokenInstance контракт
const USDC_E_TOKEN = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' // USDC.e токен

// ABI для ERC20 токена (USDC.e)
const ERC20_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' },
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' }
    ],
    'name': 'allowance',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' }
    ],
    'name': 'approve',
    'outputs': [{ 'internalType': 'bool', 'name': '', 'type': 'bool' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [{ 'internalType': 'address', 'name': 'account', 'type': 'address' }],
    'name': 'balanceOf',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'symbol',
    'outputs': [{ 'internalType': 'string', 'name': '', 'type': 'string' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для L2PoolInstance контракта
const L2_POOL_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'asset', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'onBehalfOf', 'type': 'address' },
      { 'internalType': 'uint16', 'name': 'referralCode', 'type': 'uint16' }
    ],
    'name': 'supply',
    'outputs': [],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'asset', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'to', 'type': 'address' }
    ],
    'name': 'withdraw',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'user', 'type': 'address' }
    ],
    'name': 'getUserAccountData',
    'outputs': [
      { 'internalType': 'uint256', 'name': 'totalCollateralETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'totalDebtETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'availableBorrowsETH', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'currentLiquidationThreshold', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'ltv', 'type': 'uint256' },
      { 'internalType': 'uint256', 'name': 'healthFactor', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для ATokenInstance контракта
const A_TOKEN_ABI = [
  {
    'inputs': [{ 'internalType': 'address', 'name': 'account', 'type': 'address' }],
    'name': 'balanceOf',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'totalSupply',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'user', 'type': 'address' }
    ],
    'name': 'scaledBalanceOf',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Создание публичного клиента
const publicClient = rpcManager.createPublicClient(soneiumChain)
const SAKE_SIMULATION_TIMEOUT_MS = 15000
const SAKE_ACTIVE_BIT = 56n
const SAKE_FROZEN_BIT = 57n
const SAKE_PAUSED_BIT = 60n
const SAKE_SUPPLY_CAP_START_BIT = 116n
const SAKE_SUPPLY_CAP_BIT_LENGTH = 36n
const SAKE_DEFAULT_PROBE_ADDRESS = '0x1111111111111111111111111111111111111111' as const

type SakeRuntimeProbeReason =
  | 'runtime_unauthorized'
  | 'runtime_withdrawals_disabled'
  | 'runtime_revert'
  | 'timeout'
  | 'insufficient_funds'
  | 'unknown_runtime_error'

export type SakeDepositAvailabilityReason =
  | 'available'
  | 'inactive_reserve'
  | 'reserve_frozen'
  | 'reserve_paused'
  | 'supply_cap_reached'
  | SakeRuntimeProbeReason

export type SakeWithdrawProtocolGateReason =
  | 'available'
  | 'inactive_reserve'
  | 'reserve_paused'

export interface SakeDepositAvailabilityPlan {
  status: 'available' | 'unavailable'
  reason: SakeDepositAvailabilityReason
}

export interface SakeWithdrawProtocolGatePlan {
  status: 'available' | 'unavailable'
  reason: SakeWithdrawProtocolGateReason
}

interface SakeReserveStatusSnapshot {
  isActive: boolean
  isFrozen: boolean
  isPaused: boolean
  supplyCapUnits: bigint
  totalSupplyUnits: bigint
  requestedSupplyUnits: bigint
}

interface SakeWithdrawProtocolGateSnapshot {
  isActive: boolean
  isPaused: boolean
}

interface SakePreflightResult {
  ok: boolean
  reason?: string
}

function normalizeSakeSimulationError (message: string): string {
  if (message.includes('Unauthorized')) {
    return 'Операция Sake Finance сейчас недоступна: Unauthorized'
  }
  if (message.includes('Withdrawals disabled')) {
    return 'Операция Sake Finance сейчас недоступна: Withdrawals disabled'
  }
  if (message.includes('revert') || message.includes('execution reverted')) {
    return 'Операция Sake Finance сейчас недоступна: симуляция показывает revert'
  }
  if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
    return 'Недостаточно средств для операции Sake Finance'
  }
  if (message.includes('timeout') || message.includes('Таймаут')) {
    return 'Не удалось проверить операцию Sake Finance: таймаут симуляции'
  }
  return `Не удалось выполнить preflight-проверку Sake Finance: ${message}`
}

function isBitSet (value: bigint, bit: bigint): boolean {
  return ((value >> bit) & 1n) === 1n
}

function decodeSakeSupplyCap (configData: bigint): bigint {
  return (configData >> SAKE_SUPPLY_CAP_START_BIT) & ((1n << SAKE_SUPPLY_CAP_BIT_LENGTH) - 1n)
}

function getSakeRuntimeProbeReason (message: string | undefined): SakeRuntimeProbeReason {
  if (!message) {
    return 'unknown_runtime_error'
  }

  if (message.includes('Unauthorized')) {
    return 'runtime_unauthorized'
  }
  if (message.includes('Withdrawals disabled')) {
    return 'runtime_withdrawals_disabled'
  }
  if (message.includes('таймаут') || message.includes('timeout')) {
    return 'timeout'
  }
  if (message.includes('Недостаточно средств') || message.includes('insufficient')) {
    return 'insufficient_funds'
  }
  if (message.includes('revert')) {
    return 'runtime_revert'
  }

  return 'unknown_runtime_error'
}

export function classifySakeWithdrawRuntimeHandling (message: string):
{ skip: true, reason: SakeRuntimeProbeReason, message: string } | { skip: false } {
  const reason = getSakeRuntimeProbeReason(message)

  if (reason === 'runtime_withdrawals_disabled') {
    return {
      skip: true,
      reason,
      message: 'runtime withdrawals disabled'
    }
  }

  return {
    skip: false
  }
}

export function classifySakeWithdrawErrorLogging (message: string): {
  level: 'warn' | 'error'
  message: string
} {
  const handling = classifySakeWithdrawRuntimeHandling(message)
  if (handling.skip) {
    return {
      level: 'warn',
      message: `Ошибка при выводе ликвидности: ${handling.message}`
    }
  }

  return {
    level: 'error',
    message: 'Ошибка при выводе ликвидности'
  }
}

export function planSakeDepositAvailability (snapshot: SakeReserveStatusSnapshot): SakeDepositAvailabilityPlan {
  if (!snapshot.isActive) {
    return { status: 'unavailable', reason: 'inactive_reserve' }
  }

  if (snapshot.isFrozen) {
    return { status: 'unavailable', reason: 'reserve_frozen' }
  }

  if (snapshot.isPaused) {
    return { status: 'unavailable', reason: 'reserve_paused' }
  }

  if (snapshot.supplyCapUnits > 0n) {
    const projectedSupply = snapshot.totalSupplyUnits + snapshot.requestedSupplyUnits
    if (projectedSupply > snapshot.supplyCapUnits) {
      return { status: 'unavailable', reason: 'supply_cap_reached' }
    }
  }

  return { status: 'available', reason: 'available' }
}

export function planSakeWithdrawProtocolGate (snapshot: SakeWithdrawProtocolGateSnapshot): SakeWithdrawProtocolGatePlan {
  if (!snapshot.isActive) {
    return { status: 'unavailable', reason: 'inactive_reserve' }
  }

  if (snapshot.isPaused) {
    return { status: 'unavailable', reason: 'reserve_paused' }
  }

  return { status: 'available', reason: 'available' }
}

async function getSakeReserveConfiguration (): Promise<{ data: bigint }> {
  return await publicClient.readContract({
    address: L2_POOL_INSTANCE,
    abi: [
      {
        'inputs': [{ 'internalType': 'address', 'name': 'asset', 'type': 'address' }],
        'name': 'getConfiguration',
        'outputs': [
          {
            'components': [{ 'internalType': 'uint256', 'name': 'data', 'type': 'uint256' }],
            'internalType': 'struct DataTypes.ReserveConfigurationMap',
            'name': '',
            'type': 'tuple'
          }
        ],
        'stateMutability': 'view',
        'type': 'function'
      }
    ] as const,
    functionName: 'getConfiguration',
    args: [USDC_E_TOKEN]
  })
}

export async function probeSakeDepositExecution (
  amount: string,
  probeAddress: `0x${string}` = SAKE_DEFAULT_PROBE_ADDRESS
): Promise<SakeDepositAvailabilityPlan> {
  const decimals = await publicClient.readContract({
    address: USDC_E_TOKEN,
    abi: ERC20_ABI,
    functionName: 'decimals'
  })
  const amountWei = parseUnits(amount, decimals)
  const preflight = await simulateSakeContractWrite(probeAddress, {
    chain: soneiumChain,
    account: probeAddress,
    address: L2_POOL_INSTANCE,
    abi: L2_POOL_ABI,
    functionName: 'supply',
    args: [USDC_E_TOKEN, amountWei, probeAddress, 0]
  })

  if (preflight.ok) {
    return { status: 'available', reason: 'available' }
  }

  return {
    status: 'unavailable',
    reason: getSakeRuntimeProbeReason(preflight.reason)
  }
}

export async function probeSakeWithdrawExecution (
  amount: string,
  probeAddress: `0x${string}` = SAKE_DEFAULT_PROBE_ADDRESS
): Promise<SakeDepositAvailabilityPlan> {
  const decimals = await publicClient.readContract({
    address: USDC_E_TOKEN,
    abi: ERC20_ABI,
    functionName: 'decimals'
  })
  const amountWei = parseUnits(amount, decimals)
  const preflight = await simulateSakeContractWrite(probeAddress, {
    chain: soneiumChain,
    account: probeAddress,
    address: L2_POOL_INSTANCE,
    abi: L2_POOL_ABI,
    functionName: 'withdraw',
    args: [USDC_E_TOKEN, amountWei, probeAddress]
  })

  if (preflight.ok) {
    return { status: 'available', reason: 'available' }
  }

  return {
    status: 'unavailable',
    reason: getSakeRuntimeProbeReason(preflight.reason)
  }
}

export async function checkSakeDepositAvailability (amount: string): Promise<SakeDepositAvailabilityPlan> {
  const [decimals, config, totalSupply] = await Promise.all([
    publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    }),
    getSakeReserveConfiguration(),
    publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'totalSupply'
    })
  ])

  const configData = config.data
  const requestedSupplyUnits = parseUnits(amount, decimals)
  const reserveUnit = 10n ** BigInt(decimals)
  const supplyCapTokens = decodeSakeSupplyCap(configData)
  const supplyCapUnits = supplyCapTokens === 0n ? 0n : supplyCapTokens * reserveUnit

  const plan = planSakeDepositAvailability({
    isActive: isBitSet(configData, SAKE_ACTIVE_BIT),
    isFrozen: isBitSet(configData, SAKE_FROZEN_BIT),
    isPaused: isBitSet(configData, SAKE_PAUSED_BIT),
    supplyCapUnits,
    totalSupplyUnits: totalSupply,
    requestedSupplyUnits
  })

  if (plan.status === 'unavailable') {
    return plan
  }

  return await probeSakeDepositExecution(amount)
}

export async function checkSakeWithdrawProtocolGate (): Promise<SakeWithdrawProtocolGatePlan> {
  const config = await getSakeReserveConfiguration()
  const configData = config.data

  return planSakeWithdrawProtocolGate({
    isActive: isBitSet(configData, SAKE_ACTIVE_BIT),
    isPaused: isBitSet(configData, SAKE_PAUSED_BIT)
  })
}

async function simulateSakeContractWrite (
  accountAddress: `0x${string}`,
  contractParams: Record<string, unknown>
): Promise<SakePreflightResult> {
  try {
    const config = {
      ...contractParams,
      account: (contractParams['account'] as `0x${string}`) ?? accountAddress
    }
    const simulation = publicClient.simulateContract(config as Parameters<typeof publicClient.simulateContract>[0])
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Таймаут симуляции транзакции')), SAKE_SIMULATION_TIMEOUT_MS)
    )

    await Promise.race([simulation, timeout])
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: normalizeSakeSimulationError(message)
    }
  }
}

/**
 * Получает баланс USDC.e токена для указанного адреса
 */
export async function getUSDCBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    return formatUnits(balance, decimals)
  } catch (error) {
    logger.error('Ошибка при получении баланса USDC.e', error)
    throw error
  }
}

/**
 * Получает баланс aToken для указанного адреса
 */
export async function getATokenBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    const decimals = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'decimals'
    })

    return formatUnits(balance, decimals)
  } catch (error) {
    logger.error('Ошибка при получении баланса aToken', error)
    throw error
  }
}

/**
 * Проверяет allowance (разрешение) для L2PoolInstance контракта
 */
export async function checkAllowance (owner: `0x${string}`, amount: string): Promise<boolean> {
  try {
    const allowance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, L2_POOL_INSTANCE]
    })

    // Проверяем, есть ли безлимитный approve (максимальное значение uint256)
    const maxAmount = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    const hasUnlimitedAllowance = allowance >= maxAmount

    if (hasUnlimitedAllowance) {
      return true
    }

    // Если нет безлимитного, проверяем обычный allowance
    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)
    const hasEnoughAllowance = allowance >= amountWei

    return hasEnoughAllowance
  } catch (error) {
    logger.error('Ошибка при проверке allowance', error)
    throw error
  }
}

/**
 * Выполняет approve для L2PoolInstance контракта на указанную сумму
 */
export async function approveUSDC (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Получаем decimals токена
    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    // Конвертируем сумму в wei
    const amountWei = parseUnits(amount, decimals)

    // Получаем рекомендуемый лимит газа и увеличиваем на 50%
    const estimatedGas = await publicClient.estimateContractGas({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [L2_POOL_INSTANCE, amountWei],
      account: account
    })

    const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: USDC_E_TOKEN,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [L2_POOL_INSTANCE, amountWei],
        gas: gasLimit
      }
    )
    if (!txResult.success) throw new Error(txResult.error)
    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'SAKE_FINANCE', 'APPROVE')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'SAKE_FINANCE', account.address, 'APPROVE')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.transaction(hash, 'failed', 'SAKE_FINANCE', 'APPROVE')
      throw new Error('Approve transaction failed')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении approve', error)
    throw error
  }
}

/**
 * Добавляет ликвидность в Sake Finance пул (supply)
 */
export async function addLiquidity (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)

    const preflight = await simulateSakeContractWrite(account.address, {
      chain: soneiumChain,
      account: account,
      address: L2_POOL_INSTANCE,
      abi: L2_POOL_ABI,
      functionName: 'supply',
      args: [USDC_E_TOKEN, amountWei, account.address, 0]
    })

    if (!preflight.ok) {
      throw new Error(preflight.reason || 'Sake Finance supply preflight не пройден')
    }

    // Добавляем ликвидность

    // Добавляем ликвидность с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      const txResult = await safeWriteContract(
        publicClient,
        walletClient,
        account.address,
        {
          chain: soneiumChain,
          account: account,
          address: L2_POOL_INSTANCE,
          abi: L2_POOL_ABI,
          functionName: 'supply',
          args: [USDC_E_TOKEN, amountWei, account.address, 0],
          gas: 500000n
        }
      )
      if (!txResult.success) throw new Error(txResult.error)
      hash = txResult.hash
      logger.transaction(hash, 'sent', 'SAKE_FINANCE', 'DEPOSIT')
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('[Sake] Ошибка газа, повтор с увеличенным лимитом')
        const retryResult = await safeWriteContract(
          publicClient,
          walletClient,
          account.address,
          {
            chain: soneiumChain,
            account: account,
            address: L2_POOL_INSTANCE,
            abi: L2_POOL_ABI,
            functionName: 'supply',
            args: [USDC_E_TOKEN, amountWei, account.address, 0],
            gas: 800000n
          }
        )
        if (!retryResult.success) throw new Error(retryResult.error)
        hash = retryResult.hash
        logger.transaction(hash, 'sent', 'SAKE_FINANCE', 'DEPOSIT')
        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'SAKE_FINANCE', account.address, 'DEPOSIT')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.transaction(hash, 'failed', 'SAKE_FINANCE', 'DEPOSIT')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при добавлении ликвидности', error)
    throw error
  }
}

/**
 * Выводит ликвидность (withdraw) из Sake Finance пула
 */
export async function redeemLiquidity (privateKey: `0x${string}`, amount: string | null = null): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Получаем текущий баланс aToken
    const aTokenBalance = await getATokenBalance(account.address)

    if (parseFloat(aTokenBalance) === 0) {
      throw new Error('Нет aToken для вывода')
    }

    // Определяем количество для вывода
    const withdrawAmount = amount || aTokenBalance
    if (parseFloat(withdrawAmount) > parseFloat(aTokenBalance)) {
      throw new Error('Недостаточно aToken для указанной суммы')
    }

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(withdrawAmount, decimals)

    // Проверяем возможность вывода через симуляцию
    const preflight = await simulateSakeContractWrite(account.address, {
      chain: soneiumChain,
      account: account,
      address: L2_POOL_INSTANCE,
      abi: L2_POOL_ABI,
      functionName: 'withdraw',
      args: [USDC_E_TOKEN, amountWei, account.address]
    })

    if (!preflight.ok) {
      throw new Error(preflight.reason || 'Sake Finance withdraw недоступен (возможно lock period)')
    }

    // Выводим ликвидность с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      const txResult = await safeWriteContract(
        publicClient,
        walletClient,
        account.address,
        {
          chain: soneiumChain,
          account: account,
          address: L2_POOL_INSTANCE,
          abi: L2_POOL_ABI,
          functionName: 'withdraw',
          args: [USDC_E_TOKEN, amountWei, account.address],
          gas: 500000n
        }
      )
      if (!txResult.success) throw new Error(txResult.error)
      hash = txResult.hash
      logger.transaction(hash, 'sent', 'SAKE_FINANCE', 'WITHDRAW')
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('[Sake] Ошибка газа, повтор с увеличенным лимитом')
        const retryResult = await safeWriteContract(
          publicClient,
          walletClient,
          account.address,
          {
            chain: soneiumChain,
            account: account,
            address: L2_POOL_INSTANCE,
            abi: L2_POOL_ABI,
            functionName: 'withdraw',
            args: [USDC_E_TOKEN, amountWei, account.address],
            gas: 800000n
          }
        )
        if (!retryResult.success) throw new Error(retryResult.error)
        hash = retryResult.hash
        logger.transaction(hash, 'sent', 'SAKE_FINANCE', 'WITHDRAW')
        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'SAKE_FINANCE', account.address, 'WITHDRAW')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.transaction(hash, 'failed', 'SAKE_FINANCE', 'WITHDRAW')
    }

    return hash
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const logging = classifySakeWithdrawErrorLogging(message)
    if (logging.level === 'warn') {
      logger.warn(`[Sake] ${logging.message}`)
    } else {
      logger.error(logging.message, error)
    }
    throw error
  }
}

/**
 * Получает информацию о балансе ETH
 */
export async function getETHBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.getBalance({ address })
    return formatUnits(balance, 18)
  } catch (error) {
    logger.error('Ошибка при получении баланса ETH', error)
    throw error
  }
}

/**
 * Получает общий supply aToken
 */
export async function getATokenTotalSupply (): Promise<string> {
  try {
    const totalSupply = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'totalSupply'
    })

    const decimals = await publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'decimals'
    })

    return formatUnits(totalSupply, decimals)
  } catch (error) {
    logger.error('Ошибка при получении общего supply aToken', error)
    throw error
  }
}

/**
 * Получает данные аккаунта пользователя в Sake Finance
 */
export async function getUserAccountData (address: `0x${string}`): Promise<{
  totalCollateralETH: string
  totalDebtETH: string
  availableBorrowsETH: string
  currentLiquidationThreshold: string
  ltv: string
  healthFactor: string
}> {
  try {
    const accountData = await publicClient.readContract({
      address: L2_POOL_INSTANCE,
      abi: L2_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [address]
    })

    return {
      totalCollateralETH: formatUnits(accountData[0], 18),
      totalDebtETH: formatUnits(accountData[1], 18),
      availableBorrowsETH: formatUnits(accountData[2], 18),
      currentLiquidationThreshold: formatUnits(accountData[3], 4),
      ltv: formatUnits(accountData[4], 4),
      healthFactor: formatUnits(accountData[5], 18)
    }
  } catch (error) {
    logger.error('Ошибка при получении данных аккаунта', error)
    // Возвращаем пустые данные вместо выброса ошибки
    return {
      totalCollateralETH: '0',
      totalDebtETH: '0',
      availableBorrowsETH: '0',
      currentLiquidationThreshold: '0',
      ltv: '0',
      healthFactor: '0'
    }
  }
}

/**
 * Выводит детальную информацию о ликвидности
 */
export async function displayLiquidityInfo (_userAddress: `0x${string}`, _operation: string, _amount: string): Promise<void> {}

/**
 * Основная функция модуля Sake Finance с логикой:
 * Если есть токены ликвидности → вывод
 * Если нет токенов ликвидности → депозит
 */
export async function performSakeFinanceOperations (privateKey: `0x${string}`, _amount: string | null = null): Promise<{
  success: boolean
  skipped?: boolean
  reason?: string
  depositSkipped?: boolean
  depositSkipReason?: SakeDepositAvailabilityReason
  walletAddress?: string
  usdcBalance?: string
  aTokenBalance?: string
  depositAmount?: string
  supplyTransactionHash?: string
  withdrawTransactionHash?: string | null
  explorerUrl?: string
  usdcPurchased?: boolean
  usdcPurchaseHash?: string | undefined
  usdcPurchaseAmount?: string | undefined
  message?: string
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`[Sake] Кошелек: ${account.address}`)

    // 1. Проверяем текущую ликвидность (aToken баланс)
    const aTokenBalance = await getATokenBalance(account.address)

    // 2. Если есть токены ликвидности, выводим их
    if (parseFloat(aTokenBalance) > 0) {
      logger.info('[Sake] Обнаружена ликвидность, вывод...')
      try {
        const withdrawTxHash = await redeemLiquidity(privateKey)

        // Выводим информацию после вывода
        await displayLiquidityInfo(account.address, 'withdraw', aTokenBalance)

        return {
          success: true,
          walletAddress: account.address,
          aTokenBalance: aTokenBalance,
          withdrawTransactionHash: withdrawTxHash,
          explorerUrl: `https://soneium.blockscout.com/tx/${withdrawTxHash}`
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const handling = classifySakeWithdrawRuntimeHandling(message)

        if (handling.skip) {
          logger.warn(`[Sake] Вывод пропущен: ${handling.message}`)
          logger.logToFile(
            true,
            'Sake Finance',
            'WITHDRAW_SKIPPED',
            `Кошелек: ${account.address} | Причина: ${handling.reason}`
          )

          return {
            success: true,
            skipped: true,
            reason: handling.reason,
            message: handling.message,
            walletAddress: account.address,
            aTokenBalance: aTokenBalance,
            withdrawTransactionHash: null
          }
        }

        throw error
      }
    } else {
      logger.info('[Sake] Нет ликвидности для вывода, депозиты отключены')
      return {
        success: true,
        skipped: true,
        reason: 'withdrawal_only_mode',
        walletAddress: account.address,
        aTokenBalance
      }
    }

  } catch (error) {
    logger.error('Ошибка при выполнении операций Sake Finance', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

// Экспорт констант для использования в других модулях
export {
  L2_POOL_INSTANCE,
  A_TOKEN_INSTANCE,
  USDC_E_TOKEN,
  SAKE_DEFAULT_PROBE_ADDRESS,
  ERC20_ABI,
  L2_POOL_ABI,
  A_TOKEN_ABI
}
