import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адрес контракта Main
const CONTRACT_ADDRESS = '0x21Be1D69A77eA5882aCcD5c5319Feb7AC3854751'

// ABI контракта (только нужные функции)
const CONTRACT_ABI = [
  {
    'inputs': [
      {
        'internalType': 'address',
        'name': 'player',
        'type': 'address'
      }
    ],
    'name': 'hasCheckedInToday',
    'outputs': [
      {
        'internalType': 'bool',
        'name': '',
        'type': 'bool'
      }
    ],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      {
        'internalType': 'address',
        'name': 'referrer',
        'type': 'address'
      }
    ],
    'name': 'checkIn',
    'outputs': [],
    'stateMutability': 'nonpayable',
    'type': 'function'
  }
] as const

// Создание клиентов
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Проверяет, чекинился ли пользователь сегодня
 */
export async function hasCheckedInToday (userAddress: `0x${string}`): Promise<boolean> {
  try {
    const result = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'hasCheckedInToday',
      args: [userAddress]
    })

    return result as boolean
  } catch (error) {
    logger.error('Ошибка при проверке статуса чекина', error)
    throw error
  }
}

/**
 * Выполняет транзакцию checkIn
 */
export async function performCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  message?: string
}> {
  try {
    // Создаем аккаунт из приватного ключа
    const account = privateKeyToAccount(privateKey)

    // Создаем wallet client
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Проверяем, можно ли делать чекин
    const hasChecked = await hasCheckedInToday(account.address)

    if (hasChecked) {
      logger.info('Чекин уже выполнен сегодня')
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }

    // Выполняем транзакцию checkIn с безопасной отправкой
    // Передаем нулевой адрес как реферер (без рефералов)
    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'checkIn',
        args: ['0x0000000000000000000000000000000000000000'] // Нулевой адрес как реферер
      }
    )

    if (!txResult.success) {
      // Контракт ревертит "уже выполнено сегодня" (селектор 0xd3d38ea7) — это
      // не ошибка, а нормальное состояние когда `hasCheckedInToday` view дал
      // stale-данные (типичная ситуация при race с другим инстансом / медленный RPC).
      const errMsg = txResult.error || 'Ошибка отправки транзакции'
      if (isDailyDoneRevert(errMsg)) {
        logger.warn('Чекин уже выполнен сегодня (revert detected)')
        return {
          success: true,
          walletAddress: account.address,
          message: 'Чекин уже выполнен сегодня'
        }
      }
      throw new Error(errMsg)
    }

    const hash = txResult.hash

    // Ждем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.info('Чекин выполнен успешно')
    }

    return {
      success: true,
      walletAddress: account.address,
      transactionHash: hash
    }
  } catch (error) {
    logger.error('Ошибка при выполнении чекина', error)
    throw error
  }
}

/**
 * Получает информацию о балансе кошелька
 */
export async function getBalance (address: `0x${string}`): Promise<string> {
  try {
    const balance = await publicClient.getBalance({
      address: address
    })
    return formatEther(balance)
  } catch (error) {
    logger.error('Ошибка при получении баланса', error)
    throw error
  }
}

/**
 * Основная функция модуля Lootcoin Check-in
 */
export async function performLootcoinCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)

    // Проверяем баланс
    await getBalance(account.address)

    // Проверяем статус чекина
    const hasChecked = await hasCheckedInToday(account.address)

    // Если можно делать чекин, выполняем его
    if (!hasChecked) {
      const result = await performCheckin(privateKey)
      return result
    } else {
      logger.info('Чекин уже выполнен сегодня')
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    // Зеркало проверки внутри performCheckin: если revert на стадии simulation
    // (safeWriteContract бросает Error через throw new Error(errMsg)) — это всё
    // ещё "уже выполнено сегодня", не настоящая ошибка.
    if (isDailyDoneRevert(errMsg)) {
      logger.warn('Чекин уже выполнен сегодня (revert detected в catch)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }
    logger.error('Ошибка выполнения Lootcoin Check-in', error)
    return {
      success: false,
      error: errMsg
    }
  }
}

// Экспорт констант для использования в других модулях
export {
  CONTRACT_ADDRESS,
  CONTRACT_ABI
}
