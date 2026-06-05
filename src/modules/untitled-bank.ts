import { formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адреса контрактов Untitled Bank
const BANK_CONTRACT = '0xc675BB95D73CA7db2C09c3dC04dAaA7944CCBA41' // Bank контракт (UB-USDC токен)
const UNTITLED_HUB = '0x2469362f63e9f593087EBbb5AC395CA607B5842F' // UntitledHub контракт
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

// ABI для Bank контракта (функции deposit, redeem, balanceOf)
const BANK_ABI = [
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'receiver', 'type': 'address' }
    ],
    'name': 'deposit',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'shares', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'receiver', 'type': 'address' },
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' }
    ],
    'name': 'redeem',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'assets', 'type': 'uint256' },
      { 'internalType': 'address', 'name': 'receiver', 'type': 'address' },
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' }
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
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' }
    ],
    'name': 'maxRedeem',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' }
    ],
    'name': 'maxWithdraw',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'shares', 'type': 'uint256' }
    ],
    'name': 'previewRedeem',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'assets', 'type': 'uint256' }
    ],
    'name': 'previewWithdraw',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': 'shares', 'type': 'uint256' }
    ],
    'name': 'convertToAssets',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'account', 'type': 'address' }
    ],
    'name': 'balanceOf',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'totalSupply',
    'outputs': [
      { 'internalType': 'uint256', 'name': '', 'type': 'uint256' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'getMarketAllocations',
    'outputs': [
      {
        'components': [
          { 'internalType': 'uint256', 'name': 'id', 'type': 'uint256' },
          { 'internalType': 'uint256', 'name': 'allocation', 'type': 'uint256' }
        ],
        'internalType': 'struct IBank.MarketAllocation[]',
        'name': '',
        'type': 'tuple[]'
      }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для UntitledHub (только нужные view-функции)
const UNTITLED_HUB_ABI = [
  {
    'inputs': [{ 'internalType': 'uint256', 'name': 'id', 'type': 'uint256' }],
    'name': 'market',
    'outputs': [
      { 'internalType': 'uint128', 'name': 'totalSupplyAssets', 'type': 'uint128' },
      { 'internalType': 'uint128', 'name': 'totalSupplyShares', 'type': 'uint128' },
      { 'internalType': 'uint128', 'name': 'totalBorrowAssets', 'type': 'uint128' },
      { 'internalType': 'uint128', 'name': 'totalBorrowShares', 'type': 'uint128' },
      { 'internalType': 'uint128', 'name': 'lastAccrualTimestamp', 'type': 'uint128' },
      { 'internalType': 'uint128', 'name': 'fee', 'type': 'uint128' }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Создание публичного клиента
const publicClient = rpcManager.createPublicClient(soneiumChain)

export type UntitledBankWithdrawalPlan = {
  status: 'available' | 'unavailable'
  sharesToRedeem: bigint
  reason: 'full_liquidity' | 'partial_liquidity' | 'no_withdrawable_liquidity'
  isPartial: boolean
}

export type UntitledBankWithdrawPreview = {
  shareBalance: bigint
  requestedShares: bigint
  maxRedeem: bigint
  maxWithdrawAssets: bigint | null
  expectedAssets: bigint | null
  plan: UntitledBankWithdrawalPlan
}

export type UntitledBankAssetsForSharesReader = (shares: bigint) => Promise<bigint | null>

export function planUntitledBankWithdrawal (params: {
  shareBalance: bigint
  maxRedeem: bigint
  requestedShares: bigint
}): UntitledBankWithdrawalPlan {
  const { shareBalance, maxRedeem, requestedShares } = params

  const cappedRequest = requestedShares > shareBalance ? shareBalance : requestedShares
  const redeemableShares = maxRedeem > cappedRequest ? cappedRequest : maxRedeem

  if (redeemableShares === 0n) {
    return {
      status: 'unavailable',
      sharesToRedeem: 0n,
      reason: 'no_withdrawable_liquidity',
      isPartial: false
    }
  }

  if (redeemableShares < cappedRequest) {
    return {
      status: 'available',
      sharesToRedeem: redeemableShares,
      reason: 'partial_liquidity',
      isPartial: true
    }
  }

  return {
    status: 'available',
    sharesToRedeem: redeemableShares,
    reason: 'full_liquidity',
    isPartial: false
  }
}

export async function reconcileUntitledBankWithdrawalPlanWithAssetsLimit (params: {
  requestedShares: bigint
  currentPlan: UntitledBankWithdrawalPlan
  maxWithdrawAssets: bigint | null
  getAssetsForShares: UntitledBankAssetsForSharesReader
}): Promise<UntitledBankWithdrawalPlan> {
  const { requestedShares, currentPlan, maxWithdrawAssets, getAssetsForShares } = params

  if (currentPlan.status === 'unavailable' || currentPlan.sharesToRedeem === 0n) {
    return currentPlan
  }

  if (maxWithdrawAssets === null) {
    return currentPlan
  }

  if (maxWithdrawAssets === 0n) {
    return {
      status: 'unavailable',
      sharesToRedeem: 0n,
      reason: 'no_withdrawable_liquidity',
      isPartial: false
    }
  }

  const currentAssets = await getAssetsForShares(currentPlan.sharesToRedeem)
  if (currentAssets === null) {
    return {
      status: 'unavailable',
      sharesToRedeem: 0n,
      reason: 'no_withdrawable_liquidity',
      isPartial: false
    }
  }

  if (currentAssets <= maxWithdrawAssets) {
    return currentPlan
  }

  let low = 1n
  let high = currentPlan.sharesToRedeem
  let best = 0n

  while (low <= high) {
    const mid = (low + high) / 2n
    const midAssets = await getAssetsForShares(mid)

    if (midAssets !== null && midAssets <= maxWithdrawAssets) {
      best = mid
      low = mid + 1n
    } else {
      high = mid - 1n
    }
  }

  if (best === 0n) {
    return {
      status: 'unavailable',
      sharesToRedeem: 0n,
      reason: 'no_withdrawable_liquidity',
      isPartial: false
    }
  }

  const wasFullRequest = currentPlan.sharesToRedeem === requestedShares && !currentPlan.isPartial
  const nextReason = wasFullRequest && best === requestedShares
    ? 'full_liquidity'
    : 'partial_liquidity'

  return {
    status: 'available',
    sharesToRedeem: best,
    reason: nextReason,
    isPartial: nextReason === 'partial_liquidity'
  }
}

export function selectUntitledBankRedeemShares (params: {
  shareBalance: bigint
  requestedShares?: bigint
}): bigint {
  const { shareBalance, requestedShares } = params
  return requestedShares ?? shareBalance
}

export function isUntitledBankWithdrawTemporarilyUnavailable (message: string): boolean {
  return message.includes('Симуляция: Транзакция откатится (revert)') ||
    message.includes('WithdrawFailed')
}

export function hasSufficientUntitledBankAllowance (currentAllowance: bigint, requiredAmount: bigint): boolean {
  return currentAllowance >= requiredAmount
}

async function readMaxRedeem (owner: `0x${string}`): Promise<bigint> {
  return await publicClient.readContract({
    address: BANK_CONTRACT,
    abi: BANK_ABI,
    functionName: 'maxRedeem',
    args: [owner]
  })
}

async function readMaxWithdraw (owner: `0x${string}`): Promise<bigint | null> {
  try {
    return await publicClient.readContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
      functionName: 'maxWithdraw',
      args: [owner]
    })
  } catch {
    return null
  }
}

async function readPreviewRedeem (shares: bigint): Promise<bigint | null> {
  try {
    return await publicClient.readContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
      functionName: 'previewRedeem',
      args: [shares]
    })
  } catch {
    try {
      return await publicClient.readContract({
        address: BANK_CONTRACT,
        abi: BANK_ABI,
        functionName: 'convertToAssets',
        args: [shares]
      })
    } catch {
      return null
    }
  }
}

export async function getUntitledBankWithdrawPreview (
  address: `0x${string}`,
  requestedShares?: bigint
): Promise<UntitledBankWithdrawPreview> {
  const shareBalance = await publicClient.readContract({
    address: BANK_CONTRACT,
    abi: BANK_ABI,
    functionName: 'balanceOf',
    args: [address]
  })

  const desiredShares = requestedShares ?? shareBalance
  const maxRedeem = await readMaxRedeem(address)
  const maxWithdrawAssets = await readMaxWithdraw(address)
  const initialPlan = planUntitledBankWithdrawal({
    shareBalance,
    maxRedeem,
    requestedShares: desiredShares
  })
  const plan = await reconcileUntitledBankWithdrawalPlanWithAssetsLimit({
    requestedShares: desiredShares > shareBalance ? shareBalance : desiredShares,
    currentPlan: initialPlan,
    maxWithdrawAssets,
    getAssetsForShares: readPreviewRedeem
  })
  const expectedAssets = plan.sharesToRedeem > 0n
    ? await readPreviewRedeem(plan.sharesToRedeem)
    : null

  return {
    shareBalance,
    requestedShares: desiredShares > shareBalance ? shareBalance : desiredShares,
    maxRedeem,
    maxWithdrawAssets,
    expectedAssets,
    plan
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
 * Получает баланс депозитов в Untitled Bank для указанного адреса
 */
export async function getBankBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.readContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
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
    logger.error('Ошибка при получении баланса Bank токенов', error)
    throw error
  }
}

/**
 * Проверяет allowance (разрешение) для Untitled Bank контракта
 */
export async function checkAllowance (owner: `0x${string}`, amount: string): Promise<boolean> {
  try {
    const allowance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, BANK_CONTRACT]
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
    const hasEnoughAllowance = hasSufficientUntitledBankAllowance(allowance, amountWei)

    return hasEnoughAllowance
  } catch (error) {
    logger.error('Ошибка при проверке allowance', error)
    throw error
  }
}

/**
 * Выполняет approve для Untitled Bank контракта на указанную сумму
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
      args: [BANK_CONTRACT, amountWei],
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
        args: [BANK_CONTRACT, amountWei],
        gas: gasLimit
      }
    )

    if (!txResult.success) {
      throw new Error(txResult.error || 'Ошибка отправки транзакции')
    }

    const hash = txResult.hash

    logger.transaction(hash, 'sent', 'UNTITLED_BANK', 'APPROVE')

    // Ожидаем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'UNTITLED_BANK', account.address, 'APPROVE')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.transaction(hash, 'failed', 'UNTITLED_BANK', 'APPROVE')
      throw new Error('Approve transaction failed')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении approve', error)
    throw error
  }
}

/**
 * Добавляет депозит в Untitled Bank
 */
export async function deposit (privateKey: `0x${string}`, amount: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const amountWei = parseUnits(amount, decimals)

    // Defensive check: even if caller skipped approve, ensure allowance right before deposit.
    const allowance = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, BANK_CONTRACT]
    })

    if (!hasSufficientUntitledBankAllowance(allowance, amountWei)) {
      logger.warn('[Untitled Bank] Недостаточный allowance перед deposit, выполняем approve автоматически')
      await approveUSDC(privateKey, amount)
    }

    // Добавляем депозит с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      // Получаем рекомендуемый лимит газа и увеличиваем на 50%
      const estimatedGas = await publicClient.estimateContractGas({
        address: BANK_CONTRACT,
        abi: BANK_ABI,
        functionName: 'deposit',
        args: [amountWei, account.address],
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
          address: BANK_CONTRACT,
          abi: BANK_ABI,
          functionName: 'deposit',
          args: [amountWei, account.address], // amount, receiver
          gas: gasLimit
        }
      )

      if (!txResult.success) {
        throw new Error(txResult.error || 'Ошибка отправки транзакции')
      }

      hash = txResult.hash
      logger.transaction(hash, 'sent', 'UNTITLED_BANK', 'DEPOSIT')

      // Ожидаем подтверждения
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      // Если ошибка связана с газом, пробуем с еще большим лимитом
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('Ошибка газа, пробуем с увеличенным лимитом...')

        // Retry с безопасной отправкой
        const retryResult = await safeWriteContract(
          publicClient,
          walletClient,
          account.address,
          {
            chain: soneiumChain,
            account: account,
            address: BANK_CONTRACT,
            abi: BANK_ABI,
            functionName: 'deposit',
            args: [amountWei, account.address],
            gas: 800000n // Еще больший лимит газа
          }
        )

        if (!retryResult.success) {
          throw new Error(retryResult.error || 'Ошибка retry транзакции')
        }

        hash = retryResult.hash
        logger.transaction(hash, 'sent', 'UNTITLED_BANK', 'DEPOSIT')
        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'UNTITLED_BANK', account.address, 'DEPOSIT')
      await new Promise(resolve => setTimeout(resolve, 30000))
    } else {
      logger.transaction(hash, 'failed', 'UNTITLED_BANK', 'DEPOSIT')
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении депозита', error)
    throw error
  }
}

/**
 * Получает общий supply Bank токенов
 */
export async function getBankTotalSupply (): Promise<string> {
  try {
    const totalSupply = await publicClient.readContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
      functionName: 'totalSupply'
    })

    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    return formatUnits(totalSupply, decimals)
  } catch (error) {
    logger.error('Ошибка при получении общего supply Bank токенов', error)
    throw error
  }
}

/**
 * Проверяет реальную доступную ликвидность в маркетах банка через UntitledHub.
 * Возвращает суммарную ликвидность (totalSupply - totalBorrow) по всем маркетам.
 */
async function getMarketsTotalLiquidity (decimals: number): Promise<bigint> {
  try {
    const allocations = await publicClient.readContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
      functionName: 'getMarketAllocations'
    })

    let totalLiquidity = 0n
    for (const alloc of allocations) {
      try {
        const mkt = await publicClient.readContract({
          address: UNTITLED_HUB,
          abi: UNTITLED_HUB_ABI,
          functionName: 'market',
          args: [alloc.id]
        })
        const supply = mkt[0]
        const borrow = mkt[2]
        const liquidity = supply > borrow ? supply - borrow : 0n
        totalLiquidity += liquidity
      } catch {
        // один маркет не ответил — игнорируем
      }
    }

    logger.info(
      `[Untitled Bank] Реальная ликвидность в маркетах: ${formatUnits(totalLiquidity, decimals)} USDC.e`
    )
    return totalLiquidity
  } catch {
    return 0n
  }
}

/**
 * Находит максимальную сумму assets, при которой withdraw(assets) успешно пройдёт.
 * Сначала проверяет реальную ликвидность маркетов — если 0, сразу возвращает 0.
 * Затем пробует полную сумму через симуляцию.
 * При частичной доступности — бинарный поиск.
 */
async function findMaxWithdrawableAssets (
  owner: `0x${string}`,
  theoreticalMax: bigint,
  decimals: number
): Promise<bigint> {
  // Шаг 1: проверяем реальную ликвидность маркетов (быстрый path без лишних eth_call)
  const marketLiquidity = await getMarketsTotalLiquidity(decimals)
  if (marketLiquidity === 0n) {
    logger.warn('[Untitled Bank] Все маркеты полностью заняты (utilization 100%) — вывод временно недоступен')
    return 0n
  }

  // Шаг 2: доступная сумма ограничена минимумом из теоретического максимума и ликвидности маркетов
  const cap = marketLiquidity < theoreticalMax ? marketLiquidity : theoreticalMax

  // Шаг 3: пробуем сначала ограниченную сумму через симуляцию
  const capSim = await simulateWithdraw(owner, cap)
  if (capSim.ok) {
    logger.info(`[Untitled Bank] Симуляция вывода прошла: ${formatUnits(cap, decimals)} USDC.e`)
    return cap
  }

  // Шаг 4: пробуем полный теоретический максимум (на случай если cap оценён консервативно)
  if (cap < theoreticalMax) {
    const fullSim = await simulateWithdraw(owner, theoreticalMax)
    if (fullSim.ok) {
      logger.info(`[Untitled Bank] Симуляция полного вывода прошла: ${formatUnits(theoreticalMax, decimals)} USDC.e`)
      return theoreticalMax
    }
  }

  logger.info(`[Untitled Bank] Частичная ликвидность (${formatUnits(marketLiquidity, decimals)}), ищем максимум через бинарный поиск...`)

  // Шаг 5: бинарный поиск в диапазоне [1, cap]
  let lo = 1n
  let hi = cap
  let best = 0n

  for (let i = 0; i < 20 && lo <= hi; i++) {
    const mid = (lo + hi) / 2n
    const sim = await simulateWithdraw(owner, mid)
    if (sim.ok) {
      best = mid
      lo = mid + 1n
    } else {
      hi = mid - 1n
    }
  }

  if (best > 0n) {
    logger.info(`[Untitled Bank] Максимальная доступная сумма: ${formatUnits(best, decimals)} USDC.e`)
  } else {
    logger.warn('[Untitled Bank] Бинарный поиск не нашёл доступной суммы')
  }
  return best
}

async function simulateWithdraw (owner: `0x${string}`, assets: bigint): Promise<{ ok: boolean; error?: string }> {
  try {
    await publicClient.simulateContract({
      address: BANK_CONTRACT,
      abi: BANK_ABI,
      functionName: 'withdraw',
      args: [assets, owner, owner],
      account: owner,
      gas: 500000n
    })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

/**
 * Выводит депозит (withdraw) из Untitled Bank
 */
export async function withdraw (privateKey: `0x${string}`, amount: string | null = null): Promise<string | null> {
  try {
    const account = privateKeyToAccount(privateKey)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Получаем баланс в читаемом формате для логов
    const decimals = await publicClient.readContract({
      address: USDC_E_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals'
    })

    const requestedShares = amount ? parseUnits(amount, decimals) : undefined
    const preview = await getUntitledBankWithdrawPreview(account.address, requestedShares)

    if (preview.shareBalance === 0n) {
      throw new Error('Нет депозитов для вывода')
    }

    logger.info(
      `[Untitled Bank] Preview withdraw | shareBalance=${formatUnits(preview.shareBalance, decimals)} | ` +
      `requestedShares=${formatUnits(preview.requestedShares, decimals)} | ` +
      `maxRedeem=${formatUnits(preview.maxRedeem, decimals)} | ` +
      `maxWithdrawAssets=${preview.maxWithdrawAssets !== null ? formatUnits(preview.maxWithdrawAssets, decimals) : 'n/a'} | ` +
      `expectedAssets=${preview.expectedAssets !== null ? formatUnits(preview.expectedAssets, decimals) : 'n/a'} | ` +
      `sharesToRedeem=${formatUnits(preview.plan.sharesToRedeem, decimals)} | ` +
      `reason=${preview.plan.reason}`
    )

    if (preview.expectedAssets !== null) {
      logger.info(`Ожидаемый вывод: ${formatUnits(preview.expectedAssets, decimals)} USDC.e`)
    }

    if (preview.plan.status === 'unavailable') {
      logger.warn('Preview показывает нулевую доступную ликвидность')
    } else if (preview.plan.isPartial) {
      logger.warn(`Preview показывает частичный вывод: ${formatUnits(preview.plan.sharesToRedeem, decimals)} из ${formatUnits(preview.requestedShares, decimals)} shares`)
    }

    // maxWithdraw() контракта возвращает теоретический максимум, но НЕ учитывает реальную ликвидность пулов.
    // Реальная доступная ликвидность может быть значительно меньше.
    // Ищем максимальную сумму, при которой withdraw(assets) не откатится, через бинарный поиск по eth_call.
    const theoreticalMax = preview.expectedAssets ?? preview.maxWithdrawAssets
    if (theoreticalMax === null || theoreticalMax === 0n) {
      throw new Error('Не удалось определить количество активов для вывода')
    }

    const assetsToWithdraw = await findMaxWithdrawableAssets(
      account.address,
      theoreticalMax,
      decimals
    )

    if (assetsToWithdraw === 0n) {
      logger.warn('[Untitled Bank] Бинарный поиск не нашёл доступной ликвидности — вывод временно невозможен')
      return null
    }

    logger.info(`[Untitled Bank] Вывод через withdraw(assets): ${formatUnits(assetsToWithdraw, decimals)} USDC.e`)

    // Выводим депозит с увеличенным лимитом газа
    let hash: `0x${string}`
    let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>

    try {
      // Отправляем транзакцию с безопасной отправкой
      const txResult = await safeWriteContract(
        publicClient,
        walletClient,
        account.address,
        {
          chain: soneiumChain,
          account: account,
          address: BANK_CONTRACT,
          abi: BANK_ABI,
          functionName: 'withdraw',
          args: [assetsToWithdraw, account.address, account.address], // assets, receiver, owner
          gas: 500000n // Увеличенный лимит газа для сложной операции Untitled Bank
        },
        3
      )

      if (!txResult.success) {
        throw new Error(txResult.error || 'Ошибка отправки транзакции')
      }

      hash = txResult.hash
      logger.transaction(hash, 'sent', 'UNTITLED_BANK', 'WITHDRAW')

      // Ожидаем подтверждения
      receipt = await publicClient.waitForTransactionReceipt({ hash })
    } catch (error) {
      // Если ошибка связана с газом, пробуем с еще большим лимитом
      if (error instanceof Error && error.message.includes('gas')) {
        logger.warn('Ошибка газа, пробуем с увеличенным лимитом...')

        // Retry с безопасной отправкой
        const retryResult = await safeWriteContract(
          publicClient,
          walletClient,
          account.address,
          {
            chain: soneiumChain,
            account: account,
            address: BANK_CONTRACT,
            abi: BANK_ABI,
            functionName: 'withdraw',
            args: [assetsToWithdraw, account.address, account.address],
            gas: 800000n // Еще больший лимит газа
          },
          3
        )

        if (!retryResult.success) {
          throw new Error(retryResult.error || 'Ошибка retry транзакции')
        }

        hash = retryResult.hash
        logger.transaction(hash, 'sent', 'UNTITLED_BANK', 'WITHDRAW')
        receipt = await publicClient.waitForTransactionReceipt({ hash })
      } else {
        throw error
      }
    }

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'UNTITLED_BANK', account.address, 'WITHDRAW')
      await new Promise(resolve => setTimeout(resolve, 30000))
      return hash
    } else {
      logger.transaction(hash, 'failed', 'UNTITLED_BANK', 'WITHDRAW')
      logger.warn('Withdraw failed - доступная ликвидность изменилась между preflight и отправкой')
      logger.warn('Попробуйте позже, когда появится ликвидность, или выведите меньшую сумму')
      return null
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    if (isUntitledBankWithdrawTemporarilyUnavailable(errorMsg)) {
      logger.error('Ошибка при выводе депозита: недостаточно доступной ликвидности или превышен withdraw limit')
      logger.info('Рекомендация: подождите, пока появится ликвидность, или попробуйте вывести меньшую сумму')
      return null
    } else {
      logger.error('Ошибка при выводе депозита', error)
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
 * Выводит детальную информацию о депозитах
 */
export async function displayDepositInfo (_userAddress: `0x${string}`, _operation: string, _amount: string, _transactionHash: string): Promise<void> {}

/**
 * Полный процесс управления депозитами с проверками
 */
export async function performDepositManagement (privateKey: `0x${string}`, _amount: string | null = null): Promise<{
  success: boolean
  skipped?: boolean
  reason?: string
  walletAddress?: string
  usdcBalance?: string
  bankBalance?: string
  depositAmount?: string
  depositTransactionHash?: string
  withdrawTransactionHash?: string | null
  explorerUrl?: string
  withdrawSkipped?: boolean
  withdrawReason?: string
  usdcPurchased?: boolean
  usdcPurchaseHash?: string | undefined
  usdcPurchaseAmount?: string | undefined
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`[UntitledBank] Кошелек: ${account.address}`)

    const bankBalance = await getBankBalance(account.address)

    if (parseFloat(bankBalance) > 0) {
      logger.info('Обнаружены существующие депозиты, проверяем доступный лимит вывода...')
      const withdrawTxHash = await withdraw(privateKey)

      if (withdrawTxHash === null) {
        logger.logToFile(
          true,
          'Untitled Bank',
          'WITHDRAW_SKIPPED',
          `Кошелек: ${account.address} | Причина: недостаточно доступной ликвидности для вывода сейчас`
        )
        return {
          success: false,
          skipped: true,
          reason: 'withdraw_unavailable',
          walletAddress: account.address,
          bankBalance: bankBalance,
          withdrawTransactionHash: null,
          withdrawSkipped: true,
          withdrawReason: 'withdraw_unavailable'
        }
      }

      await displayDepositInfo(account.address, 'withdraw', bankBalance, withdrawTxHash)

      return {
        success: true,
        walletAddress: account.address,
        bankBalance: bankBalance,
        withdrawTransactionHash: withdrawTxHash,
        explorerUrl: `https://soneium.blockscout.com/tx/${withdrawTxHash}`
      }
    } else {
      logger.info('[UntitledBank] Нет ликвидности для вывода, депозиты отключены')
      return {
        success: true,
        skipped: true,
        reason: 'withdrawal_only_mode',
        walletAddress: account.address,
        bankBalance
      }
    }

  } catch (error) {
    logger.error('Ошибка при управлении депозитами', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

// Экспорт констант для использования в других модулях
export {
  BANK_CONTRACT,
  UNTITLED_HUB,
  USDC_E_TOKEN,
  ERC20_ABI,
  BANK_ABI
}
