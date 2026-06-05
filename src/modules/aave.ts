import { formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { performJumperSwap } from './jumper.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { LIQUIDITY_SWAP_PERCENT_MIN, LIQUIDITY_SWAP_PERCENT_MAX } from '../season-config.js'

// Адреса контрактов Aave
const L2_POOL_INSTANCE = '0xdd3d7a7d03d9fd9ef45f3e587287922ef65ca38b' // L2PoolInstance контракт
const A_TOKEN_INSTANCE = '0xb2C9E934A55B58D20496A5019F8722a96d8A44d8' // ATokenInstance контракт
const USDC_E_TOKEN = '0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369' // USDC.e токен

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

const AAVE_RESERVE_CONFIG_ABI = [
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'asset', 'type': 'address' }
    ],
    'name': 'getConfiguration',
    'outputs': [
      {
        'components': [
          { 'internalType': 'uint256', 'name': 'data', 'type': 'uint256' }
        ],
        'internalType': 'struct DataTypes.ReserveConfigurationMap',
        'name': '',
        'type': 'tuple'
      }
    ],
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

// Создание публичного клиента с fallback RPC
const publicClient = rpcManager.createPublicClient(soneiumChain)

const AAVE_ACTIVE_BIT = 56n
const AAVE_FROZEN_BIT = 57n
const AAVE_PAUSED_BIT = 60n
const AAVE_SUPPLY_CAP_SHIFT = 116n
const AAVE_SUPPLY_CAP_MASK = (1n << 36n) - 1n

export type AaveSupplyAvailabilityReason =
  | 'available'
  | 'inactive_reserve'
  | 'reserve_frozen'
  | 'reserve_paused'
  | 'supply_cap_reached'
  | 'unknown_unavailable'

export type AaveSupplyAvailabilityPlan = {
  status: 'available' | 'unavailable'
  reason: AaveSupplyAvailabilityReason
}

export type AaveSupplyStatusSnapshot = {
  isActive: boolean
  isFrozen: boolean
  isPaused: boolean
  supplyCapUnits: bigint
  totalSupplyUnits: bigint
  requestedSupplyUnits: bigint
}

function isBitSet (value: bigint, bitPosition: bigint): boolean {
  return ((value >> bitPosition) & 1n) === 1n
}

function decodeAaveSupplyCap (configData: bigint): bigint {
  return (configData >> AAVE_SUPPLY_CAP_SHIFT) & AAVE_SUPPLY_CAP_MASK
}

function formatAaveSupplyReason (reason: AaveSupplyAvailabilityReason): string {
  switch (reason) {
  case 'inactive_reserve':
    return 'reserve inactive'
  case 'reserve_frozen':
    return 'reserve frozen'
  case 'reserve_paused':
    return 'reserve paused'
  case 'supply_cap_reached':
    return 'supply cap reached'
  case 'unknown_unavailable':
    return 'unknown unavailable state'
  default:
    return 'available'
  }
}

export function planAaveSupplyAvailability (snapshot: AaveSupplyStatusSnapshot): AaveSupplyAvailabilityPlan {
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

export async function getAaveSupplyAvailability (amount: string): Promise<AaveSupplyAvailabilityPlan> {
  const [decimals, config, totalSupply] = await Promise.all([
    publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    }),
    publicClient.readContract({
      address: L2_POOL_INSTANCE,
      abi: AAVE_RESERVE_CONFIG_ABI,
      functionName: 'getConfiguration',
      args: [USDC_E_TOKEN]
    }),
    publicClient.readContract({
      address: A_TOKEN_INSTANCE,
      abi: A_TOKEN_ABI,
      functionName: 'totalSupply'
    })
  ])

  const configData = config.data
  const requestedSupplyUnits = parseUnits(amount, decimals)
  const reserveUnit = 10n ** BigInt(decimals)
  const supplyCapTokens = decodeAaveSupplyCap(configData)
  const supplyCapUnits = supplyCapTokens === 0n ? 0n : supplyCapTokens * reserveUnit

  return planAaveSupplyAvailability({
    isActive: isBitSet(configData, AAVE_ACTIVE_BIT),
    isFrozen: isBitSet(configData, AAVE_FROZEN_BIT),
    isPaused: isBitSet(configData, AAVE_PAUSED_BIT),
    supplyCapUnits,
    totalSupplyUnits: totalSupply,
    requestedSupplyUnits
  })
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

    logger.operation('Approve для AAVE', 'start')

    // Получаем рекомендуемый лимит газа и увеличиваем на 50%
    const estimatedGas = await publicClient.estimateContractGas({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [L2_POOL_INSTANCE, amountWei],
      account: account
    })

    const gasLimit = BigInt(Math.floor(Number(estimatedGas) * 1.5))

    // Отправляем транзакцию с безопасной отправкой
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

    if (!txResult.success) {
      throw new Error(txResult.error || 'Ошибка отправки транзакции')
    }

    const hash = txResult.hash

    // Ожидаем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.operation('Approve для AAVE', 'success')
      logger.transaction(hash, 'confirmed', 'AAVE', account.address, 'APPROVE')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.operation('Approve для AAVE', 'error')
      throw new Error('Approve transaction failed')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении approve', error)
    throw error
  }
}

/**
 * Добавляет ликвидность в Aave пул (supply) с улучшенной обработкой газа
 */
export async function addLiquidity (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const supplyAvailability = await getAaveSupplyAvailability(amount)
    if (supplyAvailability.status === 'unavailable') {
      throw new Error(`Депозит в Aave сейчас недоступен: ${formatAaveSupplyReason(supplyAvailability.reason)}`)
    }

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)

    logger.operation(`Депозит ${amount} USDC.e в AAVE`, 'start')

    // Gas estimation с retry механизмом
    const gasLimits = [1000000n, 1200000n, 1500000n, 2000000n] // Увеличивающиеся лимиты газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
    let lastError: Error | null = null

    for (let i = 0; i < gasLimits.length; i++) {
      const gasLimit = gasLimits[i]

      try {
        // Сначала пытаемся оценить газ
        let estimatedGas: bigint
        try {
          estimatedGas = await publicClient.estimateContractGas({
            address: L2_POOL_INSTANCE,
            abi: L2_POOL_ABI,
            functionName: 'supply',
            args: [USDC_E_TOKEN, amountWei, account.address, 0],
            account: account.address
          })

          // Добавляем 20% буфер для reentrancy protection
          const gasWithBuffer = (estimatedGas * 120n) / 100n
          const finalGas = gasWithBuffer > gasLimit! ? gasLimit! : gasWithBuffer

          // Отправляем транзакцию с безопасной отправкой
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
              gas: finalGas
            }
          )

          if (!txResult.success) {
            throw new Error(txResult.error || 'Ошибка отправки транзакции')
          }

          hash = txResult.hash
        } catch {
          // Retry с безопасной отправкой
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
              gas: gasLimit
            }
          )

          if (!retryResult.success) {
            throw new Error(retryResult.error || 'Ошибка retry транзакции')
          }

          hash = retryResult.hash
        }

        // Ожидаем подтверждения
        receipt = await publicClient.waitForTransactionReceipt({ hash })

        if (receipt.status === 'success') {
          logger.operation(`Депозит ${amount} USDC.e в AAVE`, 'success')
          logger.transaction(hash, 'confirmed', 'AAVE', account.address, 'DEPOSIT')
          await new Promise(resolve => setTimeout(resolve, 30000))
          return hash
        } else {
          throw new Error('Транзакция не удалась')
        }

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')

        // Проверяем, является ли ошибка связанной с газом
        const isGasError = lastError.message.includes('gas') ||
                           lastError.message.includes('out of gas') ||
                           lastError.message.includes('reentrancy sentry') ||
                           lastError.message.includes('execution reverted')

        if (isGasError && i < gasLimits.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000)) // Небольшая пауза между попытками
          continue
        } else if (i === gasLimits.length - 1) {
          logger.error(`Не удалось добавить ликвидность: ${lastError.message}`)
          throw lastError
        } else {
          throw lastError
        }
      }
    }

    throw lastError || new Error('Не удалось выполнить транзакцию')

  } catch (error) {
    logger.error('Ошибка при добавлении ликвидности', error)
    throw error
  }
}

/**
 * Выводит ликвидность (withdraw) из Aave пула с улучшенной обработкой газа
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

    logger.operation(`Вывод ${withdrawAmount} USDC.e из AAVE`, 'start')

    // Gas estimation с retry механизмом
    const gasLimits = [1000000n, 1200000n, 1500000n, 2000000n] // Увеличивающиеся лимиты газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>
    let lastError: Error | null = null

    for (let i = 0; i < gasLimits.length; i++) {
      const gasLimit = gasLimits[i]

      try {
        // Сначала пытаемся оценить газ
        let estimatedGas: bigint
        try {
          estimatedGas = await publicClient.estimateContractGas({
            address: L2_POOL_INSTANCE,
            abi: L2_POOL_ABI,
            functionName: 'withdraw',
            args: [USDC_E_TOKEN, amountWei, account.address],
            account: account.address
          })

          // Добавляем 20% буфер для reentrancy protection
          const gasWithBuffer = (estimatedGas * 120n) / 100n
          const finalGas = gasWithBuffer > gasLimit! ? gasLimit! : gasWithBuffer

          // Отправляем транзакцию с безопасной отправкой
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
              gas: finalGas
            }
          )

          if (!txResult.success) {
            throw new Error(txResult.error || 'Ошибка отправки транзакции')
          }

          hash = txResult.hash
        } catch {
          // Retry с безопасной отправкой
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
              gas: gasLimit
            }
          )

          if (!retryResult.success) {
            throw new Error(retryResult.error || 'Ошибка retry транзакции')
          }

          hash = retryResult.hash
        }

        // Ожидаем подтверждения
        receipt = await publicClient.waitForTransactionReceipt({ hash })

        if (receipt.status === 'success') {
          logger.operation(`Вывод ${withdrawAmount} USDC.e из AAVE`, 'success')
          logger.transaction(hash, 'confirmed', 'AAVE', account.address, 'WITHDRAW')
          await new Promise(resolve => setTimeout(resolve, 30000))
          return hash
        } else {
          throw new Error('Транзакция не удалась')
        }

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')

        // Проверяем, является ли ошибка связанной с газом
        const isGasError = lastError.message.includes('gas') ||
                           lastError.message.includes('out of gas') ||
                           lastError.message.includes('reentrancy sentry') ||
                           lastError.message.includes('execution reverted')

        if (isGasError && i < gasLimits.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000)) // Небольшая пауза между попытками
          continue
        } else if (i === gasLimits.length - 1) {
          logger.error(`Не удалось вывести ликвидность: ${lastError.message}`)
          throw lastError
        } else {
          throw lastError
        }
      }
    }

    throw lastError || new Error('Не удалось выполнить транзакцию')

  } catch (error) {
    logger.error('Ошибка при выводе ликвидности', error)
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
 * Получает данные аккаунта пользователя в Aave
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
      args: [address] // Только адрес пользователя, без адреса актива
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
export async function displayLiquidityInfo (_userAddress: `0x${string}`, _operation: string, _amount: string, _transactionHash: string): Promise<void> {
  // noop — логирование транзакции уже выполнено в вызывающем коде
}

/**
 * Специализированная функция для обеспечения USDC.e баланса для модуля AAVE
 * Покупает минимум 1 USDC.e за одну транзакцию для естественного поведения
 */
async function ensureUSDCForAave (privateKey: `0x${string}`, minAmount: string = '1', walletAddress: `0x${string}`): Promise<{
  success: boolean
  usdcBalance: string
  purchased?: boolean
  purchaseHash?: string
  purchaseAmount?: string
  error?: string
}> {
  try {
    // Проверяем текущий баланс USDC.e
    const currentUSDCBalance = await getUSDCBalance(walletAddress)

    // Если баланс достаточный, возвращаем успех
    if (parseFloat(currentUSDCBalance) >= parseFloat(minAmount)) {
      return {
        success: true,
        usdcBalance: currentUSDCBalance,
        purchased: false
      }
    }

    logger.info('[Aave] Недостаточно USDC.e, покупаем через Jumper')

    // Проверяем баланс ETH перед покупкой
    const ethBalance = await getETHBalance(walletAddress)

    if (parseFloat(ethBalance) === 0) {
      const error = 'Недостаточно ETH для покупки USDC.e'
      logger.error(error)
      return {
        success: false,
        usdcBalance: currentUSDCBalance,
        error: error
      }
    }

    const range = LIQUIDITY_SWAP_PERCENT_MAX - LIQUIDITY_SWAP_PERCENT_MIN
    const purchasePercentage = Math.random() * range + LIQUIDITY_SWAP_PERCENT_MIN

    const jumperResult = await performJumperSwap(privateKey, purchasePercentage)

    if (!jumperResult.success) {
      const error = `Не удалось купить USDC.e через jumper: ${jumperResult.error}`
      logger.error(error)
      return {
        success: false,
        usdcBalance: currentUSDCBalance,
        error: error
      }
    }

    await new Promise(resolve => setTimeout(resolve, 30000))

    // Проверяем новый баланс USDC.e
    const newUSDCBalance = await getUSDCBalance(walletAddress)

    return {
      success: true,
      usdcBalance: newUSDCBalance,
      purchased: true,
      purchaseHash: jumperResult.transactionHash || '',
      purchaseAmount: jumperResult.swapAmount || ''
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка в ensureUSDCForAave', errorMessage)
    return {
      success: false,
      usdcBalance: '0',
      error: errorMessage
    }
  }
}

type EnsureUSDCForAaveResult = Awaited<ReturnType<typeof ensureUSDCForAave>>

export interface AaveLiquidityDependencies {
  getATokenBalance: typeof getATokenBalance
  getAaveSupplyAvailability: typeof getAaveSupplyAvailability
  ensureUSDCForAave: (privateKey: `0x${string}`, minAmount: string, walletAddress: `0x${string}`) => Promise<EnsureUSDCForAaveResult>
  checkAllowance: typeof checkAllowance
  approveUSDC: typeof approveUSDC
  addLiquidity: typeof addLiquidity
  redeemLiquidity: typeof redeemLiquidity
}

const defaultAaveLiquidityDependencies: AaveLiquidityDependencies = {
  getATokenBalance,
  getAaveSupplyAvailability,
  ensureUSDCForAave,
  checkAllowance,
  approveUSDC,
  addLiquidity,
  redeemLiquidity
}

/**
 * Полный процесс управления ликвидностью с проверками
 */
export async function performLiquidityManagementWithDependencies (privateKey: `0x${string}`, _amount: string | null = null, dependencies: AaveLiquidityDependencies = defaultAaveLiquidityDependencies): Promise<{
  success: boolean
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
  skipped?: boolean
  reason?: string
  depositSkipped?: boolean
  depositSkipReason?: AaveSupplyAvailabilityReason
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`[Aave] Кошелек: ${account.address}`)

    const aTokenBalance = await dependencies.getATokenBalance(account.address)

    if (parseFloat(aTokenBalance) > 0) {
      logger.info(`[Aave] Обнаружена ликвидность ${aTokenBalance} aToken, выводим`)
      const withdrawTxHash = await dependencies.redeemLiquidity(privateKey)

      return {
        success: true,
        walletAddress: account.address,
        aTokenBalance: aTokenBalance,
        withdrawTransactionHash: withdrawTxHash,
        explorerUrl: `https://soneium.blockscout.com/tx/${withdrawTxHash}`
      }
    } else {
      logger.info('[Aave] Нет ликвидности для вывода, депозиты отключены')
      return {
        success: true,
        skipped: true,
        reason: 'withdrawal_only_mode',
        walletAddress: account.address,
        aTokenBalance
      }
    }

  } catch (error) {
    logger.error('Ошибка при управлении ликвидностью', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

export async function performLiquidityManagement (privateKey: `0x${string}`, amount: string | null = null): Promise<{
  success: boolean
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
  skipped?: boolean
  reason?: string
  depositSkipped?: boolean
  depositSkipReason?: AaveSupplyAvailabilityReason
  error?: string
}> {
  return await performLiquidityManagementWithDependencies(privateKey, amount, defaultAaveLiquidityDependencies)
}

// Экспорт констант для использования в других модулях
export {
  L2_POOL_INSTANCE,
  A_TOKEN_INSTANCE,
  USDC_E_TOKEN,
  ERC20_ABI,
  L2_POOL_ABI,
  A_TOKEN_ABI
}
