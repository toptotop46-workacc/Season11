import axios from 'axios'
import { parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import { CONTRACTS } from '../contracts.js'

const CONTRACT_ADDRESS = CONTRACTS.awakeningGuardiansPayment

// Контракт Payment: buy(string _id, string _symbol) payable.
// Awakening of Guardians "X2 Gold Reward" — покупка пакета рекламы за ETH.
const CONTRACT_ABI = [
  {
    inputs: [
      { internalType: 'string', name: '_id', type: 'string' },
      { internalType: 'string', name: '_symbol', type: 'string' }
    ],
    name: 'buy',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
] as const

// Параметры покупки (взяты из реальной EOA-транзакции, засчитанной порталом)
const PACKAGE_ID = 'mobicom.kingdefender.ads'
const PACKAGE_SYMBOL = 'ETH'
const PACKAGE_PRICE = parseEther('0.0000015') // 1_500_000_000_000 wei (ровная цена пакета)

// Портал Soneium: бонусный квест отслеживается по этому dapp id.
const PORTAL_BASE_URL = 'https://portal.soneium.org/api'
const BONUS_DAPP_ID = 'aoguardians_11'
const QUEST_REQUIRED = 5 // лимит: 5/5 выполнений на кошелёк (как требует задание)

const publicClient = rpcManager.createPublicClient(soneiumChain)
const proxyManager = ProxyManager.getInstance()

interface QuestProgress {
  completed: number
  required: number
  isDone: boolean
}

/**
 * Запрашивает прогресс бонусного квеста Awakening of Guardians с портала Soneium.
 * Возвращает null, если не удалось получить данные (тогда не блокируем выполнение).
 */
async function fetchQuestProgress (address: string): Promise<QuestProgress | null> {
  const maxAttempts = 5

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = proxyManager.getRandomProxyFast()
    if (!proxy) {
      logger.debug('Awakening of Guardians: нет доступных прокси для проверки портала')
      return null
    }

    try {
      const proxyAgents = proxyManager.createProxyAgents(proxy)
      const response = await axios.get(`${PORTAL_BASE_URL}/profile/bonus-dapp?address=${address}`, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        httpsAgent: proxyAgents.httpsAgent,
        httpAgent: proxyAgents.httpAgent
      })

      const data = response.data
      if (!Array.isArray(data)) return null

      const dapp = data.find((d: Record<string, unknown>) => d['id'] === BONUS_DAPP_ID)
      if (!dapp || !Array.isArray(dapp['quests']) || dapp['quests'].length === 0) {
        // Квест не найден (ещё не активен / другой сезон) — считаем прогресс нулевым
        return { completed: 0, required: QUEST_REQUIRED, isDone: false }
      }

      const quest = dapp['quests'][0] as Record<string, unknown>
      return {
        completed: typeof quest['completed'] === 'number' ? quest['completed'] : 0,
        required: typeof quest['required'] === 'number' ? quest['required'] : QUEST_REQUIRED,
        isDone: quest['isDone'] === true
      }
    } catch (error) {
      if (proxyManager.isProxyAuthError(error)) {
        proxyManager.markProxyAsUnhealthy(proxy)
      }
      if (attempt === maxAttempts) {
        logger.debug(`Awakening of Guardians: не удалось получить прогресс с портала: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  return null
}

/**
 * Выполняет покупку "X2 Gold Reward" в Awakening of Guardians:
 * вызов buy("mobicom.kingdefender.ads", "ETH") на контракте Payment с value = цена пакета.
 *
 * Перед отправкой проверяет прогресс квеста через портал Soneium:
 * если выполнено уже 5/5 — пропускает кошелёк (не тратит газ).
 */
export async function performAwakeningGuardians (privateKey: `0x${string}`): Promise<{
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

    // Проверяем прогресс квеста через портал (лимит 5/5)
    const progress = await fetchQuestProgress(account.address)
    if (progress && progress.completed >= QUEST_REQUIRED) {
      logger.warn(`Awakening of Guardians: квест уже выполнен (${progress.completed}/${progress.required}) — пропуск`)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        reason: `Квест выполнен ${progress.completed}/${progress.required}`,
        message: `Квест выполнен ${progress.completed}/${progress.required}`
      }
    }

    // Проверяем баланс: нужно хватить на цену пакета + газ
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance <= PACKAGE_PRICE) {
      return {
        success: false,
        walletAddress: account.address,
        error: 'Недостаточно ETH для покупки пакета и оплаты газа'
      }
    }

    const progressLabel = progress ? ` (прогресс ${progress.completed}/${progress.required})` : ''
    logger.info(`Awakening of Guardians: покупка "X2 Gold Reward"${progressLabel}`)

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'buy',
        args: [PACKAGE_ID, PACKAGE_SYMBOL],
        value: PACKAGE_PRICE
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции'
      if (isDailyDoneRevert(msg)) {
        logger.warn('Awakening of Guardians: действие уже выполнено (revert detected)')
        return {
          success: true,
          skipped: true,
          walletAddress: account.address,
          message: 'Уже выполнено'
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
      logger.success('Awakening of Guardians: покупка выполнена')
      logger.transaction(hash, 'confirmed', 'AOGUARDIANS')
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
    if (isDailyDoneRevert(errorMessage)) {
      logger.warn('Awakening of Guardians: действие уже выполнено (revert detected в catch)')
      const account = privateKeyToAccount(privateKey)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        message: 'Уже выполнено'
      }
    }
    logger.error('Ошибка Awakening of Guardians', errorMessage)
    return {
      success: false,
      error: errorMessage,
      message: errorMessage
    }
  }
}

export { CONTRACT_ADDRESS, CONTRACT_ABI }
