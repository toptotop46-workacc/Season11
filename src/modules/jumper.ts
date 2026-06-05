import { formatEther, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { WheelXSwap } from '../wheelx-swap.js'
import { LIQUIDITY_SWAP_PERCENT_MIN, LIQUIDITY_SWAP_PERCENT_MAX } from '../season-config.js'
import axios from 'axios'

// Интерфейсы для типизации LI.FI API (соответствуют реальной документации)
interface TokenInfo {
  address: string
  symbol: string
  decimals: number
  chainId: number
  name: string
  logoURI?: string
}

interface ToolDetails {
  key: string
  logoURI: string
  name: string
}

interface LiFiAction {
  fromChainId: number
  toChainId: number
  fromToken: TokenInfo
  toToken: TokenInfo
  fromAmount: string
  toAmount: string
  slippage: number
  transactionRequest: LiFiTransactionRequest
}

interface LiFiTransactionRequest {
  to: string
  data: string
  value?: string
  gasLimit?: string
  gasPrice?: string
  chainId?: number
}

interface LiFiEstimate {
  fromAmount: string
  toAmount: string
  fromAmountMin: string
  toAmountMin: string
}

export interface LiFiQuote {
  id: string
  type: string
  tool: string
  toolDetails: ToolDetails
  action?: LiFiAction
  estimate?: LiFiEstimate
  transactionRequest?: LiFiTransactionRequest
  // Дополнительные поля, которые могут быть в ответе
  [key: string]: unknown
}

interface TransactionReceipt {
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
}

// Используем конфигурацию из RPC менеджера
const LI_FI_CONFIG = {
  INTEGRATOR: 'Soneium',
  FEE_PERCENTAGE: '0.005'
}
// Адреса токенов в сети Soneium
const TOKENS = {
  ETH: '0x0000000000000000000000000000000000000000', // Нативный ETH
  USDT: '0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35',
  USDC_e: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369'
} as const

export function shouldSimulateQuoteTransaction (fromToken: string): boolean {
  return fromToken.toLowerCase() === TOKENS.ETH
}

export function formatLiFiAxiosError (error: {
  message?: string
  response?: {
    status?: number
    statusText?: string
    data?: unknown
  }
}): string {
  const statusParts = [error.response?.status, error.response?.statusText]
    .filter(part => part !== undefined && part !== null && part !== '')
    .join(' ')
  const baseMessage = statusParts || error.message || 'Неизвестная ошибка'

  if (error.response?.data === undefined) {
    return `LI.FI API ошибка: ${baseMessage}`
  }

  const details = typeof error.response.data === 'string'
    ? error.response.data
    : JSON.stringify(error.response.data)

  return details
    ? `LI.FI API ошибка: ${baseMessage} | ${details}`
    : `LI.FI API ошибка: ${baseMessage}`
}

// LI.FI API конфигурация
const LI_FI_API_BASE = 'https://li.quest/v1'
const LI_FI_API_KEY = 'aeaa4f26-c3c3-4b71-aad3-50bd82faf815.1e83cb78-2d75-412d-a310-57272fd0e622'

// Простой rate limiter для LI.FI API
// API ключ дает 100 RPM = 1 запрос каждые 600ms
class RateLimiter {
  private static lastRequestTime = 0
  private static readonly MIN_INTERVAL = 600 // 600ms между запросами (100 RPM)

  static async waitIfNeeded (): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < this.MIN_INTERVAL) {
      const waitTime = this.MIN_INTERVAL - timeSinceLastRequest
      await new Promise(resolve => setTimeout(resolve, waitTime))
    }

    this.lastRequestTime = Date.now()
  }
}

export class SoneiumSwap {
  private privateKey: `0x${string}`
  private client: ReturnType<typeof rpcManager.createPublicClient>
  private account: ReturnType<typeof privateKeyToAccount>
  private walletClient: ReturnType<typeof rpcManager.createWalletClient>
  private customPercentage: number | undefined
  private wheelXSwap: WheelXSwap

  constructor (privateKey: `0x${string}`, customPercentage?: number) {
    // Валидация приватного ключа
    if (!privateKey) {
      throw new Error('Приватный ключ обязателен для создания экземпляра SoneiumSwap')
    }

    // Нормализация приватного ключа (добавляем 0x если его нет)
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}` as `0x${string}`

    // Сохраняем кастомный процент
    this.customPercentage = customPercentage

    try {
      // Создаем аккаунт из приватного ключа
      this.account = privateKeyToAccount(this.privateKey)

      // Создаем клиенты с fallback RPC
      this.client = rpcManager.createPublicClient(soneiumChain)
      this.walletClient = rpcManager.createWalletClient(soneiumChain, this.account)

      // Инициализируем Uniswap V2 fallback (ранее WheelX)
      this.wheelXSwap = new WheelXSwap(this.privateKey)

      // Кошелек инициализирован
    } catch (error) {
      throw new Error(`Ошибка инициализации кошелька: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  /**
   * Получить адрес кошелька из приватного ключа
   */
  getWalletAddress (): `0x${string}` {
    return this.account.address
  }

  /**
   * Получить баланс ETH в сети Soneium
   */
  async getETHBalance (address: `0x${string}` | null = null): Promise<string> {
    try {
      const walletAddress = address || this.getWalletAddress()
      const balance = await this.client.getBalance({
        address: walletAddress
      })
      return formatEther(balance)
    } catch (error) {
      logger.error('Ошибка при получении баланса ETH', error)
      throw error
    }
  }

  /**
   * Получить токен USDC.e для свапа
   */
  getTargetToken (): string {
    return TOKENS.USDC_e
  }

  /**
   * Создать axios instance для LI.FI API
   * Прокси не используются - API ключ дает 100 RPM (12,000 запросов за 2 часа)
   */
  private createAxiosInstance (): import('axios').AxiosInstance {
    return axios.create({
      headers: {
        'x-lifi-api-key': LI_FI_API_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    })
  }

  /**
   * Получить котировку от LI.FI API с fallback на Uniswap V2
   * Включает симуляцию транзакции для проверки её выполнения
   */
  async getQuote (fromToken: string, toToken: string, amount: string, fromAddress: `0x${string}`): Promise<LiFiQuote> {
    // Создаем параметры запроса
    const params = new URLSearchParams({
      fromChain: soneiumChain.id.toString(),
      toChain: soneiumChain.id.toString(),
      fromToken: fromToken,
      toToken: toToken,
      fromAmount: amount,
      fromAddress: fromAddress,
      slippage: '0.05',
      order: 'RECOMMENDED',
      integrator: LI_FI_CONFIG.INTEGRATOR,
      fee: LI_FI_CONFIG.FEE_PERCENTAGE
    })

    try {
      // Применяем rate limiting
      await RateLimiter.waitIfNeeded()

      // Создаем axios instance
      const axiosInstance = this.createAxiosInstance()

      // Запрос к LI.FI API
      const response = await axiosInstance.get(`${LI_FI_API_BASE}/quote?${params}`)

      const quote = response.data
      if (quote.transactionRequest && shouldSimulateQuoteTransaction(fromToken)) {
        const simulation = await this.simulateTransaction(quote.transactionRequest)

        if (!simulation.success) {
          logger.warn(`Симуляция LI.FI неудачна: ${simulation.error}`)
          // Не блокируем котировку - симуляция может давать false negative
          // Если транзакция реально не пройдет, она откатится при отправке
        }
      }

      return quote
    } catch (error) {
      // Логируем детали ошибки для диагностики
      if (axios.isAxiosError(error)) {
        logger.error(formatLiFiAxiosError(error))
      } else if (error instanceof Error) {
        logger.error(`LI.FI ошибка: ${error.message}`)
      }

      logger.warn('Ошибка LI.FI API, fallback на Uniswap V2')

      try {
        const wheelXQuote = await this.wheelXSwap.getQuote(
          fromToken,
          toToken,
          amount,
          fromAddress
        )
        logger.info('Котировка Uniswap V2 получена')

        // Преобразуем формат Uniswap V2 в LiFi для совместимости
        return this.wheelXSwap.convertToLiFiFormat(wheelXQuote)
      } catch (wheelXError) {
        // Если и Uniswap V2 не работает, показываем обе ошибки
        const lifiError = axios.isAxiosError(error)
          ? formatLiFiAxiosError(error)
          : error instanceof Error
            ? error.message
            : 'Неизвестная ошибка'
        const uniswapErrorMsg = wheelXError instanceof Error ? wheelXError.message : 'Неизвестная ошибка'

        throw new Error(`Не удалось получить котировку из обоих источников. ${lifiError}. Uniswap V2: ${uniswapErrorMsg}`)
      }
    }
  }

  /**
   * Вычислить EIP-1559 параметры газа для Soneium сети
   */
  private async calculateEIP1559GasParams (): Promise<{
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }> {
    try {
      // Получаем текущий блок для baseFee
      const block = await this.client.getBlock({ blockTag: 'latest' })
      const baseFee = block.baseFeePerGas || BigInt('1000000') // минимум 1 Mwei если нет baseFee

      // Для Soneium (OP Stack) используем консервативные параметры
      // Priority fee должен быть минимальным для L2
      const minPriorityFee = BigInt('1000000') // 1 Mwei (0.001 gwei)

      // Пытаемся получить рекомендуемый priority fee из истории блоков
      let recommendedPriorityFee = minPriorityFee

      try {
        // Для Soneium (OP Stack) priority fee обычно очень низкий
        recommendedPriorityFee = baseFee / BigInt(100) // 1% от baseFee
        if (recommendedPriorityFee < minPriorityFee) {
          recommendedPriorityFee = minPriorityFee
        }
      } catch {
        logger.warn('Не удалось получить историю комиссий, используем минимальное значение priority fee')
        recommendedPriorityFee = minPriorityFee
      }

      // Max fee = baseFee * 2 + priority fee (с запасом для колебаний baseFee)
      const maxFeePerGas = baseFee * BigInt(2) + recommendedPriorityFee
      const maxPriorityFeePerGas = recommendedPriorityFee

      return {
        maxFeePerGas,
        maxPriorityFeePerGas
      }
    } catch (error) {
      logger.error('Ошибка при расчете EIP-1559 параметров газа', error)

      // Fallback значения для Soneium
      const fallbackMaxPriorityFee = BigInt('1000000') // 1 Mwei
      const fallbackMaxFee = BigInt('10000000') // 10 Mwei

      logger.warn(`Используем fallback параметры газа: maxFee=${(Number(fallbackMaxFee) / 1_000_000_000).toFixed(9)} gwei, priorityFee=${(Number(fallbackMaxPriorityFee) / 1_000_000_000).toFixed(9)} gwei`)

      return {
        maxFeePerGas: fallbackMaxFee,
        maxPriorityFeePerGas: fallbackMaxPriorityFee
      }
    }
  }

  /**
   * Симулировать транзакцию для проверки её выполнения
   * Используется для валидации котировок LI.FI перед отправкой
   */
  private async simulateTransaction (transactionRequest: LiFiTransactionRequest): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      // Валидация параметров транзакции
      if (!transactionRequest.to || !transactionRequest.data) {
        return {
          success: false,
          error: 'Отсутствуют обязательные параметры транзакции (to, data)'
        }
      }

      // Подготавливаем параметры для симуляции
      const callParams = {
        to: transactionRequest.to as `0x${string}`,
        data: transactionRequest.data as `0x${string}`,
        value: BigInt(transactionRequest.value || '0'),
        account: this.account.address
      }

      // Выполняем симуляцию с таймаутом
      const simulationPromise = this.client.call(callParams)
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Таймаут симуляции транзакции (30 секунд)')), 30000)
      })

      try {
        await Promise.race([simulationPromise, timeoutPromise])
        logger.debug('Симуляция LI.FI успешна')
        return { success: true }
      } catch (simulationError) {
        // Обработка различных типов ошибок симуляции
        let errorMessage = 'Неизвестная ошибка симуляции'

        if (simulationError instanceof Error) {
          errorMessage = simulationError.message

          // Проверяем тип ошибки
          if (errorMessage.includes('revert') || errorMessage.includes('execution reverted')) {
            errorMessage = 'Транзакция откатится (revert)'
          } else if (errorMessage.includes('insufficient funds') || errorMessage.includes('insufficient balance')) {
            errorMessage = 'Недостаточно средств для выполнения транзакции'
          } else if (errorMessage.includes('timeout') || errorMessage.includes('Таймаут')) {
            errorMessage = 'Таймаут симуляции транзакции'
          }
        }

        return {
          success: false,
          error: errorMessage
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.error('Ошибка при симуляции транзакции', error)
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  /**
   * Выполнить транзакцию
   */
  async executeTransaction (transactionRequest: LiFiTransactionRequest): Promise<{
    success: boolean
    hash?: string
    receipt?: TransactionReceipt
    blockNumber?: bigint
    gasUsed?: bigint
    error?: string
  }> {
    try {
      // Валидация параметров транзакции
      if (!transactionRequest.to || !transactionRequest.data) {
        throw new Error('Отсутствуют обязательные параметры транзакции (to, data)')
      }

      // Подготавливаем транзакцию с умным лимитом газа (рекомендуемый * 1.5)
      const baseGasLimit = transactionRequest.gasLimit ?
        parseInt(transactionRequest.gasLimit) : 1000000
      const gasLimit = Math.floor(baseGasLimit * 2)

      // Вычисляем EIP-1559 параметры
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.calculateEIP1559GasParams()

      const txParams = {
        type: 'eip1559' as const, // EIP-1559
        to: transactionRequest.to as `0x${string}`,
        data: transactionRequest.data as `0x${string}`,
        value: BigInt(transactionRequest.value || '0'),
        gas: BigInt(gasLimit.toString()),
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: transactionRequest.chainId || soneiumChain.id
      }

      // Отправляем транзакцию с безопасной отправкой
      const txResult = await safeSendTransaction(
        this.client,
        this.walletClient,
        this.account.address,
        {
          ...txParams,
          account: this.account,
          chain: this.client.chain
        }
      )

      if (!txResult.success) {
        throw new Error(txResult.error || 'Ошибка отправки транзакции')
      }

      const hash = txResult.hash
      logger.transaction(hash, 'sent', 'JUMPER', 'SWAP')

      // Ждем подтверждения транзакции
      const receipt = await this.client.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        logger.transaction(hash, 'confirmed', 'JUMPER', this.account.address, 'SWAP')
      } else {
        logger.transaction(hash, 'failed', 'JUMPER', this.account.address, 'SWAP')
      }

      if (receipt.status === 'success') {
        return {
          success: true,
          hash: hash,
          receipt: receipt,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed
        }
      } else {
        return {
          success: false,
          hash: hash,
          receipt: receipt,
          error: 'Transaction reverted'
        }
      }

    } catch (error) {
      logger.error('Ошибка при выполнении транзакции', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Генерировать случайный процент для свапа (1-15%)
   */
  private getRandomSwapPercentage (): number {
    const range = LIQUIDITY_SWAP_PERCENT_MAX - LIQUIDITY_SWAP_PERCENT_MIN
    return Math.random() * range + LIQUIDITY_SWAP_PERCENT_MIN
  }

  /**
   * Выполнить свап случайного процента (1-15%) от баланса ETH на случайный токен
   */
  async performSwap (walletAddress: `0x${string}` | null = null): Promise<{
    success: boolean
    walletAddress?: string
    ethBalance?: string
    swapAmount?: string
    targetToken?: string
    targetTokenAddress?: string
    quote?: LiFiQuote
    transactionResult?: {
      success: boolean
      hash?: string
      receipt?: TransactionReceipt
      blockNumber?: bigint
      gasUsed?: bigint
      error?: string
    }
    error?: string
  }> {
    try {
      // Начинаем процесс свапа

      // 1. Получаем адрес кошелька
      const address = walletAddress || this.getWalletAddress()
      // Получаем адрес кошелька

      // 2. Получаем баланс ETH
      const ethBalance = await this.getETHBalance(address)

      if (parseFloat(ethBalance) === 0) {
        throw new Error('Недостаточно ETH для выполнения свапа')
      }

      // 3. Вычисляем процент от баланса (поддержка дробных % из конфига, например 0.1–1%)
      const swapPercentage = this.customPercentage ?? this.getRandomSwapPercentage()
      const ethBalanceWei = parseEther(ethBalance)
      // Базисные пункты (0.01% = 1): позволяют дробные проценты без BigInt от float
      const basisPoints = Math.round(swapPercentage * 100)
      const swapAmountWei = (ethBalanceWei * BigInt(basisPoints)) / BigInt(10000)

      // 4. Выбираем токен USDC.e
      const targetToken = this.getTargetToken()
      const tokenName = 'USDC.e'

      // 5. Получаем котировку от LI.FI
      const quote = await this.getQuote(
        TOKENS.ETH,
        targetToken,
        swapAmountWei.toString(),
        address
      )

      if (!quote) {
        throw new Error('Не удалось получить котировку от LI.FI')
      }

      // Проверяем, есть ли action в ответе
      if (!quote.action) {
        throw new Error('Li.Fi не может найти маршрут для данного свапа')
      }

      // Проверяем, есть ли transactionRequest в корне ответа (не в action!)
      if (!quote.transactionRequest) {
        throw new Error('Li.Fi не предоставил данные транзакции')
      }

      // Валидация котировки
      if (!quote.transactionRequest.to || !quote.transactionRequest.data) {
        throw new Error('Котировка от LI.FI содержит некорректные данные транзакции')
      }

      // 6. Выполняем транзакцию
      const txResult = await this.executeTransaction(quote.transactionRequest)

      if (txResult.success) {
        await new Promise(resolve => setTimeout(resolve, 30000))

        // 7. Возвращаем информацию о свапе
        return {
          success: true,
          walletAddress: address,
          ethBalance,
          swapAmount: formatEther(swapAmountWei),
          targetToken: tokenName,
          targetTokenAddress: targetToken,
          quote: quote,
          transactionResult: txResult
        }
      } else {

        // Возвращаем ошибку
        return {
          success: false,
          walletAddress: address,
          ethBalance,
          swapAmount: formatEther(swapAmountWei),
          targetToken: tokenName,
          targetTokenAddress: targetToken,
          quote: quote,
          transactionResult: txResult,
          error: txResult.error || 'Transaction failed'
        }
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Получить информацию о поддерживаемых токенах
   */
  getTokenInfo (): Record<string, {
    address: string
    symbol: string
    name: string
    decimals: number
  }> {
    return {
      ETH: {
        address: TOKENS.ETH,
        symbol: 'ETH',
        name: 'Ethereum',
        decimals: 18
      },
      USDT: {
        address: TOKENS.USDT,
        symbol: 'USDT',
        name: 'Tether USD',
        decimals: 6
      },
      USDC_e: {
        address: TOKENS.USDC_e,
        symbol: 'USDC.e',
        name: 'USD Coin (Bridged)',
        decimals: 6
      }
    }
  }

}

/**
 * Основная функция модуля Jumper
 */
export async function performJumperSwap (privateKey: `0x${string}`, customPercentage?: number): Promise<{
  success: boolean
  walletAddress?: string
  ethBalance?: string
  swapAmount?: string
  targetToken?: string
  transactionHash?: string
  error?: string
}> {
  try {
    logger.moduleStart('Jumper Swap')
    const swap = new SoneiumSwap(privateKey, customPercentage)
    const walletAddress = swap.getWalletAddress()
    logger.info(`[Jumper] Кошелек: ${walletAddress}`)

    const result = await swap.performSwap()

    if (result.success) {
      logger.info(`[Jumper] Свап ${result.swapAmount} ETH -> ${result.targetToken}`)

      if (result.transactionResult && result.transactionResult.success) {
        const returnValue: {
          success: boolean
          walletAddress?: string
          ethBalance?: string
          swapAmount?: string
          targetToken?: string
          transactionHash?: string
          error?: string
        } = {
          success: true
        }

        if (result.walletAddress) returnValue.walletAddress = result.walletAddress
        if (result.ethBalance) returnValue.ethBalance = result.ethBalance
        if (result.swapAmount) returnValue.swapAmount = result.swapAmount
        if (result.targetToken) returnValue.targetToken = result.targetToken
        if (result.transactionResult.hash) returnValue.transactionHash = result.transactionResult.hash

        logger.moduleEnd('Jumper Swap', true)
        return returnValue
      } else if (result.transactionResult) {
        logger.moduleEnd('Jumper Swap', false)
        return {
          success: false,
          error: result.transactionResult.error || 'Неизвестная ошибка'
        }
      }
    } else {
      logger.moduleEnd('Jumper Swap', false)
      const returnValue: {
        success: boolean
        walletAddress?: string
        ethBalance?: string
        swapAmount?: string
        targetToken?: string
        transactionHash?: string
        error?: string
      } = {
        success: false
      }

      if (result.error) returnValue.error = result.error

      return returnValue
    }

    return {
      success: false,
      error: 'Неизвестная ошибка'
    }
  } catch (error) {
    logger.moduleEnd('Jumper Swap', false)
    logger.error('Критическая ошибка модуля Jumper', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
