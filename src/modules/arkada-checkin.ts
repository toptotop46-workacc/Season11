import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адрес контракта DailyCheck
const CONTRACT_ADDRESS = '0x98826e728977B25279ad7629134FD0e96bd5A7b2'

// ABI контракта (только нужные функции)
const CONTRACT_ABI = [
  {
    'inputs': [],
    'name': 'check',
    'outputs': [],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      {
        'internalType': 'address',
        'name': 'user',
        'type': 'address'
      }
    ],
    'name': 'checkDatas',
    'outputs': [
      {
        'internalType': 'uint256',
        'name': 'streak',
        'type': 'uint256'
      },
      {
        'internalType': 'uint256',
        'name': 'timestamp',
        'type': 'uint256'
      }
    ],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Создание клиентов
const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Проверяет доступность функции check для указанного адреса
 */
export async function checkDatas (userAddress: `0x${string}`): Promise<{
  streak: number
  timestamp: number
  canCheck: boolean
  timeSinceLastCheck: number
}> {
  try {
    const result = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'checkDatas',
      args: [userAddress]
    })

    const [streak, timestamp] = result
    const currentTime = Math.floor(Date.now() / 1000)

    // Контракт DailyCheck считает «новый чек-ин разрешён» по UTC-дню (currentDay > lastCheckDay),
    // а не по «прошло 24 часа». Выравниваем клиентскую логику с контрактной, чтобы кошелёк,
    // чекнувший в 23:00 UTC, мог чекнуться сразу после 00:00 UTC, а не ждать ещё 24 часа.
    const currentDay = Math.floor(currentTime / 86400)
    const lastCheckDay = Math.floor(Number(timestamp) / 86400)
    const canCheck = currentDay > lastCheckDay
    const timeSinceLastCheck = currentTime - Number(timestamp)

    return {
      streak: Number(streak),
      timestamp: Number(timestamp),
      canCheck,
      timeSinceLastCheck
    }
  } catch (error) {
    logger.error('Ошибка при проверке данных', error)
    throw error
  }
}

/**
 * Выполняет транзакцию check
 */
export async function performCheck (privateKey: `0x${string}`): Promise<string> {
  try {
    // Создаем аккаунт из приватного ключа
    const account = privateKeyToAccount(privateKey)

    // Создаем wallet client
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    // Проверяем, можно ли делать check, с retry на случай stale RPC.
    // Сценарий: client говорит canCheck=true (по своему view), но контракт уже знает свежий
    // чек-ин и ревертит. Между попытками ждём, чтобы RPC успел обновиться.
    //
    // ВАЖНО: revert с reason "checked today" — это НЕ transient ошибка, а
    // детерминированное состояние контракта. Нет смысла ретраить — сразу
    // выходим в outer-catch через isDailyDoneRevert, который преобразует
    // это в success.
    const CHECK_READ_RETRY_ATTEMPTS = 2
    const CHECK_READ_RETRY_DELAY_MS = 3000

    for (let attempt = 1; attempt <= CHECK_READ_RETRY_ATTEMPTS; attempt++) {
      const userData = await checkDatas(account.address)

      if (!userData.canCheck) {
        const hoursLeft = Math.ceil(((Math.floor(userData.timestamp / 86400) + 1) * 86400 - Math.floor(Date.now() / 1000)) / 3600)
        logger.warn(`Check недоступен. Попробуйте через ${hoursLeft} часов.`)
        throw new Error(`Check недоступен. Попробуйте через ${hoursLeft} часов.`)
      }

      // canCheck=true — делаем симуляцию для double-check с контрактом
      try {
        await publicClient.simulateContract({
          chain: soneiumChain,
          account,
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'check'
        })
        // Симуляция прошла — можно отправлять
        break
      } catch (simError) {
        const msg = simError instanceof Error ? simError.message : String(simError)
        // Fast-path: "checked today" revert — детерминирован, ретрай бесполезен.
        // Пробрасываем сразу: outer-catch распознает через isDailyDoneRevert.
        if (isDailyDoneRevert(msg)) {
          throw simError
        }
        if (attempt < CHECK_READ_RETRY_ATTEMPTS && msg.includes('revert')) {
          logger.warn(`Симуляция check() упала (попытка ${attempt}/${CHECK_READ_RETRY_ATTEMPTS}): ${msg}, retry через ${CHECK_READ_RETRY_DELAY_MS}ms`)
          await new Promise(resolve => setTimeout(resolve, CHECK_READ_RETRY_DELAY_MS))
          continue
        }
        // Последняя попытка или не-revert ошибка — пробрасываем
        logger.error(`Симуляция check() не прошла после ${attempt} попыток: ${msg}`)
        throw new Error(`Симуляция check() не прошла: ${msg}`)
      }
    }

    // Выполняем транзакцию check с безопасной отправкой
    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'check'
      }
    )

    if (!txResult.success) {
      const errMsg = txResult.error || 'Ошибка отправки транзакции'
      // safeWriteContract revertit "checked today" — пробрасываем как есть,
      // outer-catch performArkadaCheckin преобразует в success.
      throw new Error(errMsg)
    }

    const hash = txResult.hash

    // Ждем подтверждения
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      // Получаем обновленные данные
      await checkDatas(account.address)
    }

    return hash
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Daily-done revert — нормальное состояние контракта, не ошибка.
    // Outer catch performArkadaCheckin распознает это и преобразует в success.
    // НЕ логируем ERROR чтобы не засорять терминал ложными ошибками.
    if (!isDailyDoneRevert(msg)) {
      logger.error('Ошибка при выполнении check', error)
    }
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
 * Основная функция модуля Arkada Check-in
 */
export async function performArkadaCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  streak?: number
  transactionHash?: string
  error?: string
  message?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    // Проверяем баланс
    await getBalance(account.address)

    // Проверяем данные check
    const checkData = await checkDatas(account.address)

    // Если можно делать check, выполняем его
    if (checkData.canCheck) {
      const txHash = await performCheck(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        streak: checkData.streak + 1,
        transactionHash: txHash
      }
    } else {
      const hoursLeft = Math.ceil(((Math.floor(checkData.timestamp / 86400) + 1) * 86400 - Math.floor(Date.now() / 1000)) / 3600)
      logger.warn(`Check недоступен. Попробуйте через ${hoursLeft} часов.`)
      return {
        success: true,
        walletAddress: account.address,
        streak: checkData.streak,
        message: `Check недоступен. Попробуйте через ${hoursLeft} часов.`
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    // Контракт ревертит "checked today" — это нормальное состояние, не FAILED.
    // Возникает когда client-side `canCheck=true` (UTC-day логика), но контракт
    // имеет более строгую логику или RPC отдал stale checkDatas.
    if (isDailyDoneRevert(errMsg)) {
      logger.warn('Arkada: проверка уже выполнена сегодня (revert detected)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        message: 'Уже отмечено сегодня (контракт revert: checked today)'
      }
    }
    logger.error('Ошибка выполнения Arkada Check-in', error)
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
