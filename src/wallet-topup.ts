import type { PublicClient, WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { formatEther } from 'viem'
import { rpcManager, soneiumChain } from './rpc-manager.js'
import { ProxyManager } from './proxy-manager.js'
import { ETHBalanceChecker } from './eth-balance-checker.js'
import { MEXCWithdraw } from './mexc-withdraw.js'
import { GasChecker } from './gas-checker.js'
import { safeSendTransaction } from './transaction-utils.js'
import { logger } from './logger.js'
import { fileLogger } from './file-logger.js'

// LI.FI конфигурация (как в jumper.ts)
const LI_FI_CONFIG = {
  INTEGRATOR: 'Soneium',
  FEE_PERCENTAGE: '0.005'
}

// Конфигурация для расчета газа
const GAS_CONFIG = {
  GAS_LIMIT_MULTIPLIER: 1.5, // Множитель для gas limit (1.5x от оценки)
  GAS_BUFFER_PERCENTAGE: 10, // Буфер для газа в процентах (10%)
  PRIORITY_FEE_GWEI: 0.1, // Priority fee в gwei для EIP-1559
  BASE_FEE_MULTIPLIER: 2, // Множитель для base fee (2x)
  FALLBACK_GAS_PRICE_GWEI: 20, // Fallback gas price в gwei для legacy сетей
  FALLBACK_RESERVE_PERCENTAGE: 3, // Fallback резерв в процентах (3%)
  MEXC_WITHDRAW_DELAY_MS: 30000, // Задержка после вывода с MEXC в миллисекундах (30 сек)
  // Итеративный поиск оптимальной суммы
  ITERATIVE_STEP_SIZE: 0.01, // Шаг уменьшения (1%)
  MIN_AMOUNT_PERCENTAGE: 0.90, // Минимум 90% от исходной суммы
  MAX_ITERATIONS: 10, // Максимум 10 итераций (100% - 90% = 10%)
  GAS_ESTIMATION_TIMEOUT: 5000, // Таймаут оценки газа (5 сек)
  // Retry механизм
  RETRY_ATTEMPTS: 5, // Максимум 5 попыток
  RETRY_DELAY_MS: 2000, // Задержка между попытками (2 сек)
  RETRY_BACKOFF_MULTIPLIER: 1.5, // Увеличение задержки (1.5x)
  MAX_RETRY_DELAY_MS: 10000 // Максимальная задержка (10 сек)
}

/**
 * Интерфейс для результата пополнения
 */
interface TopupResult {
  success: boolean
  walletAddress: string
  strategy: 'search' | 'withdraw' | 'sufficient'
  sourceNetwork?: string
  amountUSD: number
  amountETH: string
  mexcWithdrawId?: string | undefined
  bridgeTxHash?: string | undefined
  totalGasUsed?: string
  error?: string | undefined
}

/**
 * Интерфейс для конфигурации пополнения
 */
interface TopupConfig {
  minAmountUSD: number
  maxAmountUSD: number
  minDelayMinutes: number
  maxDelayMinutes: number
}

/**
 * Интерфейс для ответа LI.FI API (соответствует jumper.ts)
 */
interface LIFIQuoteResponse {
  transactionRequest: {
    to: string
    value: string
    data: string
    gasLimit: string
    gasPrice?: string
    chainId?: number
  }
  estimate?: {
    toAmount?: string
    fromAmount?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Класс для пополнения кошельков ETH в сети Soneium
 */
export class WalletTopup {
  private privateKey: `0x${string}`
  private account: ReturnType<typeof privateKeyToAccount>
  private proxyManager: ProxyManager

  constructor (privateKey: `0x${string}`) {
    this.privateKey = privateKey
    this.account = privateKeyToAccount(privateKey)
    this.proxyManager = ProxyManager.getInstance()
  }

  /**
   * Получает адрес кошелька
   */
  getWalletAddress (): string {
    return this.account.address
  }

  /**
   * Получает цену ETH через API
   */
  private async fetchETHPrice (): Promise<number> {
    try {
      const response = await fetch('https://api.relay.link/currencies/token/price?address=0x0000000000000000000000000000000000000000&chainId=1')

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const data = await response.json()
      const price = data.price

      if (typeof price !== 'number' || price <= 0) {
        throw new Error('Неверный формат цены ETH')
      }

      return price
    } catch (error) {
      logger.error('Ошибка получения цены ETH', error)
      throw new Error('Не удалось получить цену ETH')
    }
  }

  /**
   * Конвертирует USD в ETH
   */
  private convertUSDToETH (usdAmount: number, ethPrice: number): number {
    return usdAmount / ethPrice
  }

  /**
   * Генерирует случайную сумму в USD
   */
  private generateRandomAmount (minUSD: number, maxUSD: number): number {
    return Math.random() * (maxUSD - minUSD) + minUSD
  }

  /**
   * Проверяет баланс ETH в сети Soneium
   */
  private async getSoneiumETHBalance (): Promise<number> {
    try {
      const client = rpcManager.createPublicClient(soneiumChain)
      const balance = await client.getBalance({ address: this.account.address })
      return parseFloat(formatEther(balance))
    } catch (error) {
      logger.error('Ошибка получения баланса Soneium', error)
      return 0
    }
  }

  /**
   * Проверяет балансы ETH в других сетях
   */
  private async checkOtherNetworksBalances (): Promise<{ network: string; balance: number }[]> {
    try {
      const balanceChecker = new ETHBalanceChecker(this.account.address, 500) // 500ms задержка между запросами
      const results = await balanceChecker.checkAllNetworks()

      return results.map(result => ({
        network: result.network,
        balance: result.balance
      }))
    } catch (error) {
      logger.error('Ошибка проверки балансов', error)
      return []
    }
  }

  /**
   * Выбирает лучшую стратегию пополнения
   */
  private selectTopupStrategy (balances: { network: string; balance: number }[], requiredAmount: number): 'search' | 'withdraw' {
    // Если есть достаточный баланс в других сетях, используем стратегию поиска
    const hasEnoughBalance = balances.some(b => b.balance >= requiredAmount)
    return hasEnoughBalance ? 'search' : 'withdraw'
  }

  /**
   * Получает баланс в конкретной сети (оптимизированная версия)
   */
  private async getNetworkBalance (network: string): Promise<number> {
    try {
      // Получаем конфигурацию сети напрямую
      const networkConfigs = [
        { name: 'ARB', chainId: 42161, rpc: ['https://arbitrum-one.publicnode.com'], explorer: 'https://arbiscan.io' },
        { name: 'OP', chainId: 10, rpc: ['https://optimism.publicnode.com'], explorer: 'https://optimistic.etherscan.io' },
        { name: 'BASE', chainId: 8453, rpc: ['https://base.publicnode.com'], explorer: 'https://basescan.org' }
      ]

      // Нормализуем название сети (приводим к верхнему регистру)
      const normalizedNetwork = network.toUpperCase()

      // Маппинг названий сетей от MEXC к внутренним названиям
      const networkMapping: Record<string, string> = {
        'ARBITRUM ONE(ARB)': 'ARB',
        'OPTIMISM(OP)': 'OP',
        'BASE': 'BASE'
      }

      const mappedNetwork = networkMapping[normalizedNetwork] || normalizedNetwork

      const targetConfig = networkConfigs.find(config => config.name === mappedNetwork)
      if (!targetConfig) {
        logger.error(`Неизвестная сеть: ${network}`, undefined)
        return 0
      }

      const balance = await this.checkSingleNetworkBalance(targetConfig)

      return balance
    } catch (error) {
      logger.error(`Ошибка получения баланса ${network}`, error)
      return 0
    }
  }

  /**
   * Проверяет баланс в одной конкретной сети
   */
  private async checkSingleNetworkBalance (networkConfig: { name: string; chainId: number; rpc: string[]; explorer: string }): Promise<number> {
    const { createPublicClient, http, formatEther } = await import('viem')

    for (const rpcUrl of networkConfig.rpc) {
      try {
        const client = createPublicClient({
          chain: {
            id: networkConfig.chainId,
            name: networkConfig.name,
            network: networkConfig.name.toLowerCase(),
            nativeCurrency: {
              decimals: 18,
              name: 'Ether',
              symbol: 'ETH'
            },
            rpcUrls: {
              default: { http: [rpcUrl] },
              public: { http: [rpcUrl] }
            },
            blockExplorers: {
              default: { name: 'Explorer', url: networkConfig.explorer }
            }
          },
          transport: http(rpcUrl)
        })

        const balance = await client.getBalance({ address: this.account.address as `0x${string}` })
        return parseFloat(formatEther(balance))
      } catch {
        logger.warn(`RPC ${rpcUrl} не работает для ${networkConfig.name}`)
        continue
      }
    }

    throw new Error(`Все RPC недоступны для ${networkConfig.name}`)
  }

  /**
   * Ожидает поступления средств на баланс
   */
  private async waitForBalanceUpdate (network: string, expectedAmount: number, maxWaitTime: number = 300000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 10000
    const ETH_EPSILON = 0.000001 // 1 микроЭTH для толерантности сравнения

    logger.info(`Ожидаем поступления ${expectedAmount.toFixed(6)} ETH на ${network}`)

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const currentBalance = await this.getNetworkBalance(network)

        if (currentBalance >= expectedAmount - ETH_EPSILON) {
          logger.info(`Средства поступили на ${network}`)
          return true
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval))

      } catch {
        await new Promise(resolve => setTimeout(resolve, checkInterval))
      }
    }

    logger.warn(`Время ожидания истекло, средства не поступили на ${network}`)
    return false
  }

  /**
   * Выбирает подходящую сеть для вывода с учетом минимальной суммы
   */
  private async selectSuitableNetworkForWithdraw (amountETH: number, availableNetworks: string[]): Promise<string> {
    try {
      // Получаем конфигурацию MEXC
      const mexcConfig = await this.loadMEXCConfig()
      const mexcClient = new MEXCWithdraw(mexcConfig)

      // Получаем доступные сети с их минимальными суммами
      const networks = await mexcClient.getWithdrawNetworks()

      // Фильтруем сети, где наша сумма больше минимальной
      const suitableNetworks = networks.filter(network =>
        amountETH >= network.withdrawMin
      )

      if (suitableNetworks.length === 0) {
        const minAmounts = networks.map(n => `${n.network}: ${n.withdrawMin} ETH`).join(', ')
        throw new Error(`Сумма ${amountETH} ETH меньше минимальной для всех доступных сетей. Минимальные суммы: ${minAmounts}`)
      }

      // Выбираем случайную из подходящих сетей
      const randomIndex = Math.floor(Math.random() * suitableNetworks.length)
      const selectedNetwork = suitableNetworks[randomIndex]!

      return selectedNetwork.network
    } catch (error) {
      logger.error('Ошибка при выборе подходящей сети', error)
      // Fallback к случайному выбору
      const randomIndex = Math.floor(Math.random() * availableNetworks.length)
      return availableNetworks[randomIndex]!
    }
  }

  /**
   * Оценивает стоимость газа для конкретной суммы
   */
  private async estimateGasForAmount (sourceNetwork: string, amount: number): Promise<number> {
    try {
      // Получаем котировку для конкретной суммы
      const quote = await this.getBridgeQuote(sourceNetwork, amount)
      if (!quote) {
        throw new Error('Не удалось получить котировку для оценки газа')
      }

      // Создаем клиент для оценки
      const { publicClient } = await this.createSourceNetworkClient(sourceNetwork)

      // Оцениваем газ с таймаутом
      const estimatedGas = await Promise.race([
        publicClient.estimateGas({
          to: quote.transactionRequest.to as `0x${string}`,
          data: quote.transactionRequest.data as `0x${string}`,
          value: BigInt(quote.transactionRequest.value),
          account: this.account
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Таймаут оценки газа')), GAS_CONFIG.GAS_ESTIMATION_TIMEOUT)
        )
      ])

      // Рассчитываем стоимость газа
      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * GAS_CONFIG.GAS_LIMIT_MULTIPLIER))
      const block = await publicClient.getBlock()
      const baseFee = block.baseFeePerGas || 0n

      let feePerGas: bigint
      if (baseFee > 0n) {
        // EIP-1559
        const maxPriorityFeePerGas = BigInt(GAS_CONFIG.PRIORITY_FEE_GWEI * 1e9)
        feePerGas = baseFee * BigInt(GAS_CONFIG.BASE_FEE_MULTIPLIER) + maxPriorityFeePerGas
      } else {
        // Legacy
        const fallbackGasPriceWei = BigInt(GAS_CONFIG.FALLBACK_GAS_PRICE_GWEI * 1e9)
        feePerGas = BigInt(quote.transactionRequest.gasPrice || fallbackGasPriceWei.toString())
      }

      const gasCost = gasLimit * feePerGas
      return parseFloat(formatEther(gasCost))
    } catch (error) {
      // Извлекаем только основную информацию об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств для газа'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else if (error.message.includes('execution reverted')) {
          errorMessage = 'Транзакция отменена'
        } else {
          // Берем только первую строку сообщения
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      logger.error(`Ошибка оценки газа для суммы ${amount}: ${errorMessage}`)
      throw error
    }
  }

  /**
   * Динамически рассчитывает оптимальную сумму для бриджа с учетом газа (итеративный подход)
   */
  private async calculateOptimalBridgeAmount (sourceNetwork: string, maxAmount: number): Promise<number> {
    try {
      const { publicClient } = await this.createSourceNetworkClient(sourceNetwork)
      const balance = await publicClient.getBalance({ address: this.account.address })
      const balanceETH = parseFloat(formatEther(balance))

      let currentAmount = maxAmount
      const minAmount = maxAmount * GAS_CONFIG.MIN_AMOUNT_PERCENTAGE
      const stepSize = GAS_CONFIG.ITERATIVE_STEP_SIZE

      for (let iteration = 1; iteration <= GAS_CONFIG.MAX_ITERATIONS; iteration++) {
        try {
          const gasEstimate = await this.estimateGasForAmount(sourceNetwork, currentAmount)
          const totalCost = currentAmount + gasEstimate

          if (totalCost <= balanceETH) {
            return currentAmount
          }

          currentAmount *= (1 - stepSize)

        } catch (error) {
          let errorMessage = 'Неизвестная ошибка'
          if (error instanceof Error) {
            if (error.message.includes('insufficient funds')) {
              errorMessage = 'Недостаточно средств'
            } else if (error.message.includes('gas required exceeds allowance')) {
              errorMessage = 'Газ превышает лимит'
            } else {
              errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
            }
          }
          logger.warn(`Ошибка оценки газа: ${errorMessage}`)
          currentAmount *= (1 - stepSize)
        }
      }

      const absoluteMin = 0.0001
      if (absoluteMin < balanceETH) {
        try {
          const gasEstimate = await this.estimateGasForAmount(sourceNetwork, absoluteMin)
          if (absoluteMin + gasEstimate <= balanceETH) {
            return absoluteMin
          }
        } catch (error) {
          let errorMessage = 'Неизвестная ошибка'
          if (error instanceof Error) {
            if (error.message.includes('insufficient funds')) {
              errorMessage = 'Недостаточно средств'
            } else if (error.message.includes('gas required exceeds allowance')) {
              errorMessage = 'Газ превышает лимит'
            } else {
              errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
            }
          }
          logger.warn(`Абсолютный минимум не работает: ${errorMessage}`)
        }
      }

      throw new Error(`Не удалось найти подходящую сумму для бриджа после ${GAS_CONFIG.MAX_ITERATIONS} попыток. Баланс: ${balanceETH.toFixed(6)} ETH, требуется минимум: ${minAmount.toFixed(6)} ETH`)

    } catch (error) {
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      logger.error('Критическая ошибка расчета оптимальной суммы', new Error(errorMessage))
      throw error
    }
  }

  /**
   * Выполняет бридж ETH через Jumper с retry механизмом
   */
  private async performBridgeWithRetry (sourceNetwork: string, amountETH: number, gasChecker?: GasChecker): Promise<{ success: boolean; txHash?: string; error?: string }> {
    let lastError: Error | null = null
    let delay = GAS_CONFIG.RETRY_DELAY_MS

    for (let attempt = 1; attempt <= GAS_CONFIG.RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await this.performBridge(sourceNetwork, amountETH, gasChecker)

        if (result.success) {
          logger.info(`Бридж успешен: ${result.txHash}`)
          return result
        }

        if (!result.error) {
          return result
        }

        lastError = new Error(result.error)

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')
        let errorMessage = lastError.message
        if (errorMessage.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (errorMessage.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = errorMessage.split('\n')[0] ?? 'Неизвестная ошибка'
        }
        logger.warn(`Попытка ${attempt} не удалась: ${errorMessage}`)
      }

      if (attempt < GAS_CONFIG.RETRY_ATTEMPTS) {
        logger.info(`Ожидаем ${Math.round(delay / 1000)}с перед попыткой ${attempt + 1}`)
        await new Promise(resolve => setTimeout(resolve, delay))

        // Увеличиваем задержку для следующей попытки
        delay = Math.min(delay * GAS_CONFIG.RETRY_BACKOFF_MULTIPLIER, GAS_CONFIG.MAX_RETRY_DELAY_MS)
      }
    }

    logger.error(`Все ${GAS_CONFIG.RETRY_ATTEMPTS} попыток бриджа не удались`)
    return {
      success: false,
      error: `Бридж не удался после ${GAS_CONFIG.RETRY_ATTEMPTS} попыток. Последняя ошибка: ${lastError?.message}`
    }
  }

  /**
   * Выполняет бридж ETH через Jumper
   */
  private async performBridge (sourceNetwork: string, amountETH: number, gasChecker?: GasChecker): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      await this.checkGasPrice(gasChecker)

      const quote = await this.getBridgeQuote(sourceNetwork, amountETH)
      if (!quote) {
        throw new Error('Не удалось получить котировку для бриджа')
      }

      const txHash = await this.executeBridgeTransaction(quote, sourceNetwork)
      logger.info(`Бридж выполнен: ${txHash}`)

      return { success: true, txHash }
    } catch (error) {
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      logger.error('Ошибка бриджа', new Error(errorMessage))
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Получает котировку для бриджа от LI.FI
   */
  private async getBridgeQuote (sourceNetwork: string, amountETH: number): Promise<LIFIQuoteResponse | null> {
    try {
      const sourceChainId = this.getChainIdByName(sourceNetwork)
      const targetChainId = 1868

      const amountWei = Math.round(amountETH * 1e18).toString()

      const params = new URLSearchParams({
        fromChain: sourceChainId.toString(),
        toChain: targetChainId.toString(),
        fromToken: '0x0000000000000000000000000000000000000000', // ETH
        toToken: '0x0000000000000000000000000000000000000000', // ETH
        fromAmount: amountWei,
        fromAddress: this.account.address,
        toAddress: this.account.address,
        slippage: '0.05',
        order: 'RECOMMENDED',
        integrator: LI_FI_CONFIG.INTEGRATOR,
        fee: LI_FI_CONFIG.FEE_PERCENTAGE
      })

      const response = await fetch(`https://li.quest/v1/quote?${params}`, {
        method: 'GET',
        headers: {
          'x-lifi-api-key': 'aeaa4f26-c3c3-4b71-aad3-50bd82faf815.1e83cb78-2d75-412d-a310-57272fd0e622'
        }
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error(`LI.FI API ошибка ${response.status}`, new Error(errorText))
        throw new Error(`LI.FI API error: ${response.status} - ${errorText}`)
      }

      const quote = await response.json()
      return quote
    } catch (error) {
      logger.error('Ошибка получения котировки LI.FI', error)
      return null
    }
  }

  /**
   * Создает клиент для исходной сети
   */
  public async createSourceNetworkClient (sourceNetwork: string): Promise<{
    walletClient: ReturnType<typeof import('viem').createWalletClient>
    publicClient: ReturnType<typeof import('viem').createPublicClient>
  }> {
    const sourceChainId = this.getChainIdByName(sourceNetwork)

    // Маппинг полных названий сетей на внутренние названия
    const networkMapping: Record<string, string> = {
      'ARBITRUM ONE(ARB)': 'ARB',
      'OPTIMISM(OP)': 'OP',
      'BASE': 'BASE'
    }

    const internalNetwork = networkMapping[sourceNetwork.toUpperCase()] || sourceNetwork.toUpperCase()

    // Конфигурация сетей
    const networkConfigs = {
      'ARB': { name: 'Arbitrum', rpc: 'https://arbitrum-one.publicnode.com', explorer: 'https://arbiscan.io' },
      'OP': { name: 'Optimism', rpc: 'https://optimism.publicnode.com', explorer: 'https://optimistic.etherscan.io' },
      'BASE': { name: 'Base', rpc: 'https://base.publicnode.com', explorer: 'https://basescan.org' }
    }

    const config = networkConfigs[internalNetwork as keyof typeof networkConfigs]
    if (!config) {
      throw new Error(`Неизвестная сеть: ${sourceNetwork} (маппинг: ${internalNetwork})`)
    }

    // Создаем клиент напрямую с viem с правильными типами
    const { createPublicClient, createWalletClient, http } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')

    const chain = {
      id: sourceChainId,
      name: config.name,
      network: config.name.toLowerCase(),
      nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH'
      },
      rpcUrls: {
        default: { http: [config.rpc] },
        public: { http: [config.rpc] }
      },
      blockExplorers: {
        default: { name: 'Explorer', url: config.explorer }
      }
    }

    const account = privateKeyToAccount(this.privateKey)

    const publicClient = createPublicClient({
      chain,
      transport: http(config.rpc, {
        timeout: 10000,
        retryCount: 3,
        retryDelay: 1000
      })
    })

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpc, {
        timeout: 10000,
        retryCount: 3,
        retryDelay: 1000
      })
    })

    return {
      walletClient,
      publicClient
    }
  }

  /**
   * Выполняет транзакцию бриджа
   */
  private async executeBridgeTransaction (quote: LIFIQuoteResponse, sourceNetwork: string): Promise<string> {
    try {
      // Создаем клиент для исходной сети, а не для Soneium
      const { walletClient, publicClient } = await this.createSourceNetworkClient(sourceNetwork)
      const sourceChainId = this.getChainIdByName(sourceNetwork)

      const balance = await publicClient.getBalance({ address: this.account.address })
      const requiredValue = BigInt(quote.transactionRequest.value)

      // Оцениваем газ динамически с запасом
      const estimatedGas = await publicClient.estimateGas({
        to: quote.transactionRequest.to as `0x${string}`,
        data: quote.transactionRequest.data as `0x${string}`,
        value: BigInt(quote.transactionRequest.value),
        account: this.account
      })

      const gasLimit = BigInt(Math.floor(Number(estimatedGas) * GAS_CONFIG.GAS_LIMIT_MULTIPLIER))

      // Используем EIP-1559 gas pricing для Arbitrum и других EIP-1559 сетей
      const block = await publicClient.getBlock()
      const baseFee = block.baseFeePerGas || 0n

      let gasParams: Record<string, bigint> = {}

      if (baseFee > 0n) {
        // EIP-1559 сети (Arbitrum, Optimism, Base)
        const maxPriorityFeePerGas = BigInt(GAS_CONFIG.PRIORITY_FEE_GWEI * 1e9) // Конвертируем gwei в wei
        const maxFeePerGas = baseFee * BigInt(GAS_CONFIG.BASE_FEE_MULTIPLIER) + maxPriorityFeePerGas
        gasParams = {
          maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas
        }
      } else {
        // Legacy сети
        const fallbackGasPriceWei = BigInt(GAS_CONFIG.FALLBACK_GAS_PRICE_GWEI * 1e9) // Конвертируем gwei в wei
        const gasPrice = BigInt(quote.transactionRequest.gasPrice || fallbackGasPriceWei.toString())
        gasParams = { gasPrice: gasPrice }
      }

      // Проверяем достаточность средств с учетом реального газа
      const feePerGas = 'maxFeePerGas' in gasParams ? gasParams['maxFeePerGas']! : gasParams['gasPrice']!
      const gasCost = gasLimit * feePerGas
      const totalRequired = requiredValue + gasCost

      if (balance < totalRequired) {
        throw new Error(`Недостаточно средств: ${formatEther(balance)} < ${formatEther(totalRequired)} (включая газ)`)
      }

      // Правильная структура транзакции с динамическим gas pricing
      const txParams = {
        to: quote.transactionRequest.to as `0x${string}`,
        data: quote.transactionRequest.data as `0x${string}`,
        value: BigInt(quote.transactionRequest.value),
        gas: gasLimit,
        ...gasParams, // EIP-1559 или legacy в зависимости от сети
        chainId: sourceChainId // Используем chainId исходной сети!
      }

      const sendParams: Record<string, unknown> = {
        ...txParams,
        account: this.account,
        chain: walletClient.chain
      }
      const txResult = await safeSendTransaction(
        publicClient as PublicClient,
        walletClient as WalletClient,
        this.account.address,
        sendParams
      )
      if (!txResult.success) throw new Error(txResult.error)
      const hash = txResult.hash

      // Получаем правильную ссылку на explorer исходной сети
      const networkKey = this.getNetworkKey(sourceNetwork)
      const explorerUrl = this.getExplorerUrl(networkKey, hash)

      logger.info(`Транзакция отправлена: ${explorerUrl}`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        logger.info(`Транзакция подтверждена: ${explorerUrl}`)
        // Логируем в файл с правильной ссылкой
        const details = `${this.account.address} - ${explorerUrl}`
        fileLogger.logTransaction(hash, true, 'WALLET_TOPUP', details)
        logger.info(`Использовано газа: ${receipt.gasUsed}`)
        return hash
      } else {
        throw new Error('Транзакция не удалась')
      }
    } catch (error) {
      // Упрощаем сообщение об ошибке
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          errorMessage = 'Недостаточно средств'
        } else if (error.message.includes('gas required exceeds allowance')) {
          errorMessage = 'Газ превышает лимит'
        } else {
          errorMessage = error.message.split('\n')[0] ?? 'Неизвестная ошибка'
        }
      }
      logger.error('Ошибка выполнения транзакции бриджа', new Error(errorMessage))

      // Детальная обработка ошибок
      if (error instanceof Error) {
        if (error.message.includes('insufficient funds')) {
          throw new Error('Недостаточно средств для выполнения транзакции')
        } else if (error.message.includes('gas')) {
          throw new Error('Проблема с газом: ' + error.message)
        } else if (error.message.includes('revert')) {
          throw new Error('Транзакция отменена: ' + error.message)
        } else {
          throw new Error('Ошибка транзакции: ' + error.message)
        }
      }
      throw error
    }
  }

  /**
   * Получает ключ сети для маппинга explorer
   */
  private getNetworkKey (sourceNetwork: string): string {
    const networkMapping: Record<string, string> = {
      'Arbitrum One(ARB)': 'ARB',
      'Optimism(OP)': 'OP',
      'BASE': 'BASE'
    }

    return networkMapping[sourceNetwork] || 'UNKNOWN'
  }

  /**
   * Получает explorer URL для сети
   */
  private getExplorerUrl (networkName: string, txHash: string): string {
    const networkMapping: Record<string, string> = {
      'ARB': 'arbiscan.io',
      'OP': 'optimistic.etherscan.io',
      'BASE': 'basescan.org'
    }

    const mappedNetwork = networkMapping[networkName.toUpperCase()]
    if (mappedNetwork) {
      return `https://${mappedNetwork}/tx/${txHash}`
    }

    // Fallback на Soneium explorer
    return `https://soneium.blockscout.com/tx/${txHash}`
  }

  /**
   * Получает chain ID по имени сети
   */
  private getChainIdByName (networkName: string): number {
    // Маппинг названий сетей от MEXC к внутренним названиям
    const networkMapping: Record<string, string> = {
      'ARBITRUM ONE(ARB)': 'ARB',
      'OPTIMISM(OP)': 'OP',
      'BASE': 'BASE'
    }

    const mappedNetwork = networkMapping[networkName.toUpperCase()] || networkName.toUpperCase()

    const chainIds: Record<string, number> = {
      'ARB': 42161,
      'OP': 10,
      'BASE': 8453
    }

    const chainId = chainIds[mappedNetwork] || 1
    return chainId
  }

  /**
   * Загружает конфигурацию MEXC из файла
   */
  private async loadMEXCConfig (): Promise<{ apiKey: string; secretKey: string; baseUrl: string; timeout?: number; recvWindow?: number }> {
    try {
      const fs = await import('fs')
      const path = await import('path')

      const configPath = path.join(process.cwd(), 'mexc_api.txt')

      if (!fs.existsSync(configPath)) {
        throw new Error('Файл mexc_api.txt не найден. Создайте файл с API ключами MEXC в формате:\napiKey=your_api_key\nsecretKey=your_secret_key')
      }

      const configContent = fs.readFileSync(configPath, 'utf8')
      const lines = configContent.split('\n').filter(line => line.trim() && !line.startsWith('#'))

      let apiKey = ''
      let secretKey = ''

      for (const line of lines) {
        const [key, value] = line.split('=').map(s => s.trim())
        if (key === 'apiKey' && value) {
          apiKey = value
        } else if (key === 'secretKey' && value) {
          secretKey = value
        }
      }

      if (!apiKey || !secretKey) {
        throw new Error('Не найдены apiKey или secretKey в файле mexc_api.txt')
      }

      return {
        apiKey,
        secretKey,
        baseUrl: 'https://api.mexc.com',
        timeout: 30000,
        recvWindow: 5000
      }
    } catch (error) {
      logger.error('Ошибка загрузки конфигурации MEXC', error)
      throw new Error(`Не удалось загрузить конфигурацию MEXC: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  /**
   * Выполняет вывод с MEXC
   */
  private async performMEXCWithdraw (amountETH: number, targetNetwork: string): Promise<{ success: boolean; withdrawId?: string; error?: string }> {
    try {
      logger.info(`Вывод ${amountETH} ETH с MEXC в ${targetNetwork}`)

      // Получаем конфигурацию MEXC из файла
      const mexcConfig = await this.loadMEXCConfig()

      // Создаем экземпляр MEXC клиента
      const mexcClient = new MEXCWithdraw(mexcConfig)

      // Проверяем доступность средств
      const isAvailable = await mexcClient.checkWithdrawAvailability(amountETH)
      if (!isAvailable) {
        throw new Error('Недостаточно средств на MEXC для вывода')
      }

      // Проверяем минимальную сумму
      const isValidAmount = await mexcClient.checkMinimumWithdrawAmount(amountETH)
      if (!isValidAmount) {
        throw new Error('Сумма меньше минимальной для вывода')
      }

      // Выполняем вывод
      const withdrawRequest = {
        coin: 'ETH',
        address: this.account.address,
        amount: amountETH,
        network: targetNetwork
      }

      const result = await mexcClient.withdraw(withdrawRequest)
      logger.info(`Вывод MEXC выполнен: ${result.id}`)

      return { success: true, withdrawId: result.id }
    } catch (error) {
      logger.error('Ошибка вывода MEXC', error)
      return { success: false, error: error instanceof Error ? error.message : 'Неизвестная ошибка' }
    }
  }

  /**
   * Проверка цены газа в ETH mainnet
   */
  private async checkGasPrice (gasChecker?: GasChecker): Promise<void> {
    if (!gasChecker) return

    try {
      if (await gasChecker.isGasPriceTooHigh()) {
        logger.info('Ожидание снижения цены газа')
        await gasChecker.waitForGasPriceToDrop()
      }
    } catch (error) {
      logger.error('Ошибка проверки газа', error)
      // Продолжаем работу даже при ошибке проверки газа
    }
  }

  /**
   * Основная функция пополнения кошелька
   */
  async performTopup (config: TopupConfig, gasChecker?: GasChecker): Promise<TopupResult> {
    try {
      await this.checkGasPrice(gasChecker)

      const ethPrice = await this.fetchETHPrice()

      const randomUSD = this.generateRandomAmount(config.minAmountUSD, config.maxAmountUSD)

      const ethAmount = this.convertUSDToETH(randomUSD, ethPrice)

      const currentBalance = await this.getSoneiumETHBalance()

      if (currentBalance >= ethAmount) {
        logger.info(`В Soneium уже достаточно ETH: ${this.account.address}`)

        return {
          success: true,
          walletAddress: this.account.address,
          strategy: 'sufficient',
          amountUSD: randomUSD,
          amountETH: ethAmount.toString()
        }
      }

      const otherBalances = await this.checkOtherNetworksBalances()

      const strategy = this.selectTopupStrategy(otherBalances, ethAmount)

      let result: TopupResult

      if (strategy === 'search') {
        const bestNetwork = otherBalances.find(b => b.balance >= ethAmount)
        if (!bestNetwork) {
          const availableBalances = otherBalances.map(b => `${b.network}: ${b.balance.toFixed(6)} ETH`).join(', ')
          throw new Error(`Не найдено сети с достаточным балансом для бриджа ${ethAmount} ETH. Доступные балансы: ${availableBalances}`)
        }

        const bridgeAmount = await this.calculateOptimalBridgeAmount(bestNetwork.network, ethAmount)

        const bridgeResult = await this.performBridgeWithRetry(bestNetwork.network, bridgeAmount, gasChecker)

        result = {
          success: bridgeResult.success,
          walletAddress: this.account.address,
          strategy: 'search',
          sourceNetwork: bestNetwork.network,
          amountUSD: randomUSD,
          amountETH: bridgeAmount.toString(), // Фактическая сумма бриджа
          bridgeTxHash: bridgeResult.txHash,
          error: bridgeResult.error
        }
      } else {
        const targetNetworks = ['ARB', 'OP', 'BASE']

        const randomNetwork = await this.selectSuitableNetworkForWithdraw(ethAmount, targetNetworks)

        const withdrawResult = await this.performMEXCWithdraw(ethAmount, randomNetwork)

        if (!withdrawResult.success) {
          throw new Error(`Ошибка вывода MEXC: ${withdrawResult.error}`)
        }

        // Получаем реальную комиссию MEXC для выбранной сети через API
        const mexcConfig = await this.loadMEXCConfig()
        const mexcClient = new MEXCWithdraw(mexcConfig)
        const networks = await mexcClient.getWithdrawNetworks()
        const selectedNetworkConfig = networks.find(n => n.network === randomNetwork)

        if (!selectedNetworkConfig) {
          throw new Error(`Не удалось найти конфигурацию сети ${randomNetwork} в MEXC API`)
        }

        const mexcFee = selectedNetworkConfig.fee

        const expectedAmount = ethAmount - mexcFee

        const balanceUpdated = await this.waitForBalanceUpdate(randomNetwork, expectedAmount)

        if (!balanceUpdated) {
          throw new Error(`Средства не поступили на ${randomNetwork} в течение ожидаемого времени`)
        }

        await new Promise(resolve => setTimeout(resolve, GAS_CONFIG.MEXC_WITHDRAW_DELAY_MS))

        const bridgeAmount = await this.calculateOptimalBridgeAmount(randomNetwork, expectedAmount)

        const bridgeResult = await this.performBridgeWithRetry(randomNetwork, bridgeAmount, gasChecker)

        result = {
          success: bridgeResult.success,
          walletAddress: this.account.address,
          strategy: 'withdraw',
          sourceNetwork: randomNetwork,
          amountUSD: randomUSD,
          amountETH: bridgeAmount.toString(), // Фактическая сумма бриджа
          mexcWithdrawId: withdrawResult.withdrawId,
          bridgeTxHash: bridgeResult.txHash,
          error: bridgeResult.error
        }
      }

      if (result.success) {
        logger.info(`Пополнение выполнено: $${result.amountUSD.toFixed(2)} (${result.amountETH} ETH)`)
      } else {
        logger.warn(`Ошибка пополнения: ${result.error}`)
      }

      return result
    } catch (error) {
      // Детальная обработка различных типов ошибок
      let errorMessage = 'Неизвестная ошибка'
      if (error instanceof Error) {
        if (error.message.includes('недостаточно средств')) {
          errorMessage = `Недостаточно средств: ${error.message}`
        } else if (error.message.includes('минимальная')) {
          errorMessage = `Проблема с минимальной суммой: ${error.message}`
        } else if (error.message.includes('средства не поступили')) {
          errorMessage = `Проблема с поступлением средств: ${error.message}`
        } else if (error.message.includes('бридж')) {
          errorMessage = `Ошибка бриджа: ${error.message}`
        } else {
          errorMessage = error.message
        }
      }

      logger.error('Критическая ошибка пополнения', new Error(errorMessage))

      return {
        success: false,
        walletAddress: this.account.address,
        strategy: 'search',
        amountUSD: 0,
        amountETH: '0',
        error: errorMessage
      }
    }
  }
}

/**
 * Основная функция модуля пополнения
 */
export async function performWalletTopup (privateKey: `0x${string}`, config: TopupConfig, gasChecker?: GasChecker): Promise<TopupResult> {
  try {
    logger.moduleStart('Wallet Topup')

    const topup = new WalletTopup(privateKey)
    const result = await topup.performTopup(config, gasChecker)

    if (result.success) {
      logger.moduleEnd('Wallet Topup', true)
    } else {
      logger.moduleEnd('Wallet Topup', false)
    }

    return result
  } catch (error) {
    logger.moduleEnd('Wallet Topup', false)
    logger.error('Критическая ошибка модуля пополнения', error)
    return {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      strategy: 'search',
      amountUSD: 0,
      amountETH: '0',
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
