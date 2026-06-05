import { formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContractWithoutSimulation, safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Контракт StargatePoolNative (ETH пул)
const STARGATE_POOL_NATIVE = '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590' as const
// LP токен S*ETH
const STARGATE_ETH_LP = '0x26CA12d5eC43AA9f0aDb4a891918B70CF5720281' as const

// Минимальный резерв ETH для газа (0.0002 ETH)
const GAS_RESERVE = 200000000000000n
// Stargate shared decimals = 6, суммы должны быть кратны 10^12
const STARGATE_PRECISION = 1000000000000n

const STARGATE_NATIVE_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_receiver', type: 'address' },
      { internalType: 'uint256', name: '_amountLD', type: 'uint256' }
    ],
    name: 'deposit',
    outputs: [{ internalType: 'uint256', name: 'amountLD', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: '_amountLP', type: 'uint256' },
      { internalType: 'address', name: '_receiver', type: 'address' }
    ],
    name: 'redeem',
    outputs: [{ internalType: 'uint256', name: 'amountLD', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

const LP_TOKEN_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Получает баланс S*ETH LP токенов
 */
async function getLpBalance (address: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: STARGATE_ETH_LP,
    abi: LP_TOKEN_ABI,
    functionName: 'balanceOf',
    args: [address]
  })
}

/**
 * Депозит ETH в Stargate пул (85–95% от баланса)
 */
export async function performStargateEthDeposit (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  depositAmount?: string
  transactionHash?: string
  explorerUrl?: string
  skipped?: boolean
  reason?: string
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`[Stargate ETH] Кошелек: ${account.address}`)

    const ethBalance = await publicClient.getBalance({ address: account.address })
    logger.info(`[Stargate ETH] Баланс ETH: ${formatUnits(ethBalance, 18)}`)

    const available = ethBalance > GAS_RESERVE ? ethBalance - GAS_RESERVE : 0n

    if (available === 0n) {
      logger.warn(`[Stargate ETH] Недостаточно ETH для депозита`)
      return { success: true, skipped: true, reason: 'insufficient_eth', walletAddress: account.address }
    }

    // Случайный процент 85–95%
    const pct = 85 + Math.random() * 10
    // Округляем вниз до кратного 10^12 (требование Stargate shared decimals = 6)
    const rawAmount = (available * BigInt(Math.floor(pct * 100))) / 10000n
    const depositAmount = (rawAmount / STARGATE_PRECISION) * STARGATE_PRECISION

    logger.info(`[Stargate ETH] Депозит ${formatUnits(depositAmount, 18)} ETH (${pct.toFixed(1)}% от доступного)`)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Пропускаем симуляцию — используем прямую отправку (симуляция даёт false negative
    // из-за особенностей StargatePoolNative, реальная TX проходит нормально)
    const txResult = await safeWriteContractWithoutSimulation(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: STARGATE_POOL_NATIVE,
        abi: STARGATE_NATIVE_ABI,
        functionName: 'deposit',
        args: [account.address, depositAmount],
        value: depositAmount,
        gas: 200000n
      }
    )

    if (!txResult.success) throw new Error(txResult.error)
    const hash = txResult.hash

    logger.transaction(hash, 'sent', 'STARGATE-ETH', 'DEPOSIT')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'STARGATE-ETH', account.address, 'DEPOSIT')
    } else {
      logger.transaction(hash, 'failed', 'STARGATE-ETH', 'DEPOSIT')
      throw new Error('Транзакция депозита не прошла')
    }

    return {
      success: true,
      walletAddress: account.address,
      depositAmount: formatUnits(depositAmount, 18),
      transactionHash: hash,
      explorerUrl: `https://soneium.blockscout.com/tx/${hash}`
    }
  } catch (error) {
    logger.error('[Stargate ETH] Ошибка депозита', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

/**
 * Вывод всех S*ETH LP токенов из Stargate пула
 */
export async function performStargateEthWithdraw (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  lpAmount?: string
  transactionHash?: string
  explorerUrl?: string
  skipped?: boolean
  reason?: string
  error?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`[Stargate ETH] Кошелек: ${account.address}`)

    const lpBalance = await getLpBalance(account.address)
    logger.info(`[Stargate ETH] Баланс S*ETH LP: ${formatUnits(lpBalance, 18)}`)

    if (lpBalance === 0n) {
      logger.info(`[Stargate ETH] Нет LP токенов для вывода`)
      return { success: true, skipped: true, reason: 'no_lp_balance', walletAddress: account.address }
    }

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: STARGATE_POOL_NATIVE,
        abi: STARGATE_NATIVE_ABI,
        functionName: 'redeem',
        args: [lpBalance, account.address],
        gas: 200000n
      }
    )

    if (!txResult.success) throw new Error(txResult.error)
    const hash = txResult.hash

    logger.transaction(hash, 'sent', 'STARGATE-ETH', 'REDEEM')
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'STARGATE-ETH', account.address, 'REDEEM')
    } else {
      logger.transaction(hash, 'failed', 'STARGATE-ETH', 'REDEEM')
      throw new Error('Транзакция вывода не прошла')
    }

    return {
      success: true,
      walletAddress: account.address,
      lpAmount: formatUnits(lpBalance, 18),
      transactionHash: hash,
      explorerUrl: `https://soneium.blockscout.com/tx/${hash}`
    }
  } catch (error) {
    logger.error('[Stargate ETH] Ошибка вывода', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
