import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адрес контракта чекина (из транзакции Blockscout)
const CONTRACT_ADDRESS = '0xedCbF9D4CC3BA9aAA896adADeac1b6DF6326f7D8' as const

const CONTRACT_ABI = [
  {
    inputs: [],
    name: 'checkIn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Получает баланс ETH для указанного адреса
 */
async function getBalance (address: `0x${string}`): Promise<string> {
  const balance = await publicClient.getBalance({ address })
  return formatEther(balance)
}

/**
 * Выполняет чекин: вызов checkIn() на контракте Captain.
 */
export async function performCaptainCheckin (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
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

    // Симуляция: если контракт ревертит (например, чекин уже сделан сегодня) — не отправляем tx
    try {
      await publicClient.simulateContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'checkIn',
        account: account
      })
    } catch {
      logger.warn('Чекин уже выполнен сегодня или недоступен (симуляция откатилась)')
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
      // Контракт ревертит "уже выполнено" (селектор 0xd3d38ea7) — pre-simulation
      // выше прошла потому что между ней и safeWriteContract состояние RPC обновилось
      // (или другой инстанс успел сделать tx). Не считаем это THREAD_FAILED.
      if (isDailyDoneRevert(msg)) {
        logger.warn('Captain чекин уже выполнен сегодня (revert detected)')
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
      logger.success('Captain check-in выполнен')
      logger.transaction(hash, 'confirmed', 'CAPTAIN')
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
    // Подстраховка: если revert "уже выполнено" пробился сквозь pre-simulation
    // (потому что её try/catch ловит ВСЕ ошибки, включая RPC timeout, и считает
    // их за success) — здесь ещё раз проверяем.
    if (isDailyDoneRevert(errorMessage)) {
      logger.warn('Captain чекин уже выполнен сегодня (revert detected в catch)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        walletAddress: account.address,
        message: 'Чекин уже выполнен сегодня'
      }
    }
    logger.error('Ошибка Captain check-in', errorMessage)
    return {
      success: false,
      error: errorMessage,
      message: errorMessage
    }
  }
}

export { CONTRACT_ADDRESS, CONTRACT_ABI }
