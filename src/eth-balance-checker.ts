import { createPublicClient, http, formatEther } from 'viem'
import { logger } from './logger.js'

/**
 * Конфигурация сетей для проверки балансов
 */
const NETWORK_CONFIGS = [
  {
    name: 'ARB',
    chainId: 42161,
    rpc: [
      'https://arbitrum-one.publicnode.com',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc'
    ],
    explorer: 'https://arbiscan.io'
  },
  {
    name: 'OP',
    chainId: 10,
    rpc: [
      'https://optimism.publicnode.com',
      'https://optimism-rpc.publicnode.com',
      'https://optimism.drpc.org',
      'https://mainnet.optimism.io'
    ],
    explorer: 'https://optimistic.etherscan.io'
  },
  {
    name: 'BASE',
    chainId: 8453,
    rpc: [
      'https://base.publicnode.com',
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://mainnet.base.org'
    ],
    explorer: 'https://basescan.org'
  }
] as const

/**
 * Интерфейс для результата проверки баланса
 */
interface BalanceResult {
  network: string
  chainId: number
  balance: number
  balanceWei: bigint
  success: boolean
  error?: string
}

/**
 * Класс для проверки балансов ETH в разных сетях
 */
export class ETHBalanceChecker {
  private walletAddress: string
  private requestDelay: number

  constructor (walletAddress: string, requestDelay: number = 500) {
    this.walletAddress = walletAddress
    this.requestDelay = requestDelay
  }

  /**
   * Проверяет баланс ETH в конкретной сети с fallback RPC
   */
  private async checkBalanceInNetwork (networkConfig: (typeof NETWORK_CONFIGS)[number]): Promise<BalanceResult> {
    logger.info(`Проверяем баланс в ${networkConfig.name}...`)

    // Получаем массив RPC (поддерживаем как строку, так и массив)
    const rpcUrls = Array.isArray(networkConfig.rpc) ? networkConfig.rpc : [networkConfig.rpc]

    let lastError: Error | null = null

    // Пробуем каждый RPC по очереди
    for (let i = 0; i < rpcUrls.length; i++) {
      const rpcUrl = rpcUrls[i]!

      try {
        logger.info(`Попытка ${i + 1}/${rpcUrls.length}: ${rpcUrl}`)

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

        const balance = await client.getBalance({ address: this.walletAddress as `0x${string}` })
        const balanceETH = parseFloat(formatEther(balance))

        logger.info(`${networkConfig.name}: ${balanceETH.toFixed(6)} ETH (RPC: ${rpcUrl})`)

        return {
          network: networkConfig.name,
          chainId: networkConfig.chainId,
          balance: balanceETH,
          balanceWei: balance,
          success: true
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')
        logger.warn(`RPC ${i + 1} не работает: ${lastError.message}`)

        // Небольшая задержка перед попыткой следующего RPC
        if (i < rpcUrls.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    }

    // Если все RPC не сработали
    const errorMessage = lastError ? lastError.message : 'Все RPC недоступны'
    logger.warn(`Ошибка проверки ${networkConfig.name}: ${errorMessage}`)

    return {
      network: networkConfig.name,
      chainId: networkConfig.chainId,
      balance: 0,
      balanceWei: 0n,
      success: false,
      error: errorMessage
    }
  }

  /**
   * Тестирует доступность RPC для конкретной сети
   */
  async testNetworkRPCs (networkConfig: (typeof NETWORK_CONFIGS)[number]): Promise<{
    network: string
    workingRPCs: string[]
    failedRPCs: string[]
    totalRPCs: number
  }> {
    const rpcUrls = Array.isArray(networkConfig.rpc) ? networkConfig.rpc : [networkConfig.rpc]
    const workingRPCs: string[] = []
    const failedRPCs: string[] = []

    logger.info(`Тестируем RPC для ${networkConfig.name}...`)

    for (const rpcUrl of rpcUrls) {
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

        // Простой тест - получаем номер блока
        await client.getBlockNumber()
        workingRPCs.push(rpcUrl)
        logger.info(`${rpcUrl} - работает`)
      } catch (error) {
        failedRPCs.push(rpcUrl)
        logger.warn(`${rpcUrl} - не работает: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
      }
    }

    return {
      network: networkConfig.name,
      workingRPCs,
      failedRPCs,
      totalRPCs: rpcUrls.length
    }
  }

  /**
   * Проверяет балансы во всех поддерживаемых сетях
   */
  async checkAllNetworks (): Promise<BalanceResult[]> {
    logger.info('ПРОВЕРКА БАЛАНСОВ ETH В СЕТЯХ')
    logger.info(`Адрес: ${this.walletAddress}`)
    logger.info('='.repeat(60))

    const results: BalanceResult[] = []

    for (const networkConfig of NETWORK_CONFIGS) {
      const result = await this.checkBalanceInNetwork(networkConfig)
      results.push(result)

      // Небольшая задержка между запросами
      await new Promise(resolve => setTimeout(resolve, this.requestDelay))
    }

    return results
  }

  /**
   * Находит сеть с наибольшим балансом
   */
  findBestSourceNetwork (balances: BalanceResult[]): BalanceResult | null {
    const validBalances = balances.filter(b => b.success && b.balance > 0)

    if (validBalances.length === 0) {
      return null
    }

    return validBalances.reduce((best, current) =>
      current.balance > best.balance ? current : best
    )
  }

  /**
   * Получает общую статистику по балансам
   */
  getBalanceStatistics (balances: BalanceResult[]): {
    totalNetworks: number
    successfulChecks: number
    networksWithBalance: number
    totalBalance: number
    bestNetwork?: BalanceResult | undefined
  } {
    const successfulChecks = balances.filter(b => b.success)
    const networksWithBalance = balances.filter(b => b.success && b.balance > 0)
    const totalBalance = networksWithBalance.reduce((sum, b) => sum + b.balance, 0)
    const bestNetwork = this.findBestSourceNetwork(balances)

    return {
      totalNetworks: balances.length,
      successfulChecks: successfulChecks.length,
      networksWithBalance: networksWithBalance.length,
      totalBalance,
      bestNetwork: bestNetwork ?? undefined
    }
  }

  /**
   * Выводит детальную статистику
   */
  printBalanceStatistics (balances: BalanceResult[]): void {
    const stats = this.getBalanceStatistics(balances)

    logger.info('СТАТИСТИКА БАЛАНСОВ')
    logger.info('='.repeat(60))
    logger.info(`Всего сетей: ${stats.totalNetworks}`)
    logger.info(`Успешных проверок: ${stats.successfulChecks}`)
    logger.info(`Сетей с балансом: ${stats.networksWithBalance}`)
    logger.info(`Общий баланс: ${stats.totalBalance.toFixed(6)} ETH`)

    if (stats.bestNetwork) {
      logger.info(`Лучшая сеть: ${stats.bestNetwork.network} (${stats.bestNetwork.balance.toFixed(6)} ETH)`)
    } else {
      logger.warn('Не найдено сетей с балансом')
    }

    logger.info('Детальная информация:')
    balances.forEach(balance => {
      const status = balance.success ? 'OK' : 'Ошибка'
      const balanceStr = balance.success ? `${balance.balance.toFixed(6)} ETH` : 'Ошибка'
      logger.info(`${status} ${balance.network}: ${balanceStr}`)
    })

    logger.info('='.repeat(60))
  }
}

