import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { CONTRACTS } from '../contracts.js'

const CONTRACT_ADDRESS = CONTRACTS.diceOrDieCheckin

const CONTRACT_ABI = [
  {
    inputs: [],
    name: 'checkIn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getUserStatus',
    outputs: [
      { internalType: 'uint256', name: 'lastCheckin', type: 'uint256' },
      { internalType: 'uint256', name: 'streak', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

const SECONDS_PER_DAY = 86400

/**
 * Получает баланс ETH для указанного адреса
 */
async function getBalance (address: `0x${string}`): Promise<string> {
  const balance = await publicClient.getBalance({ address })
  return formatEther(balance)
}

/**
 * Проверяет, доступен ли чекин сегодня (по UTC-дню относительно lastCheckin).
 * Контракт хранит последний чекин в getUserStatus(user).lastCheckin.
 * Если последний чекин был в текущем UTC-дне — чекин недоступен.
 */
function isCheckinAvailable (lastCheckin: bigint): boolean {
  if (lastCheckin === 0n) return true
  const lastDay = Math.floor(Number(lastCheckin) / SECONDS_PER_DAY)
  const todayDay = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY)
  return todayDay > lastDay
}

/**
 * Выполняет чекин Dice or Die: вызов checkIn() на контракте DODDailyCheckin.
 *
 * Сначала читает getUserStatus(EOA) — если чекин уже сделан сегодня,
 * не тратит газ. Иначе симулирует и отправляет транзакцию.
 */
export async function performDiceOrDieCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  streak?: number
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const ethBalance = await getBalance(account.address)

    if (parseFloat(ethBalance) === 0) {
      return {
        success: false,
        walletAddress: account.address,
        error: 'Недостаточно ETH для оплаты газа'
      }
    }

    // Проверяем статус: доступен ли чекин для этого EOA сегодня
    try {
      const [lastCheckin] = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'getUserStatus',
        args: [account.address]
      })

      if (!isCheckinAvailable(lastCheckin)) {
        logger.warn('Dice or Die чекин уже выполнен сегодня (по getUserStatus)')
        return {
          success: true,
          walletAddress: account.address,
          message: 'Чекин уже выполнен сегодня'
        }
      }
    } catch (statusError) {
      // Чтение статуса упало (RPC) — не блокируем, дальше отработает симуляция
      logger.debug(`Dice or Die: не удалось прочитать getUserStatus, продолжаем: ${statusError instanceof Error ? statusError.message : String(statusError)}`)
    }

    // Симуляция: если контракт ревертит (AlreadyCheckedInToday) — не отправляем tx
    try {
      await publicClient.simulateContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'checkIn',
        account: account
      })
    } catch {
      logger.warn('Dice or Die чекин уже выполнен сегодня или недоступен (симуляция откатилась)')
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'checkIn'
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции'
      // AlreadyCheckedInToday (селектор 0xd3d38ea7) — состояние RPC обновилось
      // между симуляцией и отправкой. Не считаем это ошибкой.
      if (isDailyDoneRevert(msg)) {
        logger.warn('Dice or Die чекин уже выполнен сегодня (revert detected)')
        return {
          success: true,
          walletAddress: account.address,
          message: 'Чекин уже выполнен сегодня'
        }
      }
      logger.error(msg)
      return {
        success: false,
        walletAddress: account.address,
        error: msg,
        message: msg
      }
    }

    const hash = txResult.hash
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.success('Dice or Die check-in выполнен')
      logger.transaction(hash, 'confirmed', 'DICEORDIE')
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash
      }
    }

    return {
      success: false,
      walletAddress: account.address,
      transactionHash: hash,
      error: 'Транзакция не прошла',
      message: 'Транзакция откатилась (revert)'
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    // Подстраховка: revert «уже выполнено» мог пробиться сквозь pre-simulation
    if (isDailyDoneRevert(errorMessage)) {
      logger.warn('Dice or Die чекин уже выполнен сегодня (revert detected в catch)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }
    logger.error('Ошибка Dice or Die check-in', errorMessage)
    return {
      success: false,
      error: errorMessage,
      message: errorMessage
    }
  }
}

export { CONTRACT_ADDRESS, CONTRACT_ABI }
