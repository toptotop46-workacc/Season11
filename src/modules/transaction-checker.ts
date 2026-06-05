import axios from 'axios'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import { CURRENT_SEASON, POINTS_LIMIT_SEASON } from '../season-config.js'

// Типы

interface TransactionCheckResult {
  address: string
  success: boolean
  pointsCount?: number
  maxPoints?: number
  ratio?: string
  status: 'done' | 'not_done' | 'error'
  error?: string
  responseTime?: number
}

interface SeasonData {
  address: string
  baseScore: number
  bonusPoints: number
  season: number
  totalScore: number
  activityScore: number
  liquidityScore: number
  nftScore: number
  sonyNftScore: number
  isEligible: boolean
  status: string
  badgesCollected: unknown[]
  liquidityContributionPoints: number
  txScore: number
  activityDaysScore: number
  streakScore: number
  createdAt: string
  updatedAt: string
}

// Основной класс модуля
export class TransactionChecker {
  private proxyManager: ProxyManager
  private readonly baseUrl = 'https://portal.soneium.org/api'
  private readonly proxyRetryErrorMessage = 'Не удалось подобрать рабочий прокси'
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0'
  ]

  private readonly CONFIG = {
    timeout: 10000,            // Timeout в мс
    retryAttempts: 10,         // Попытки повтора
    pointsLimit: POINTS_LIMIT_SEASON  // Лимит поинтов для статуса 'done' (из season-config)
  }

  constructor () {
    this.proxyManager = ProxyManager.getInstance()
  }

  // Проверка одного кошелька (публичный метод)
  async checkSingleWalletPublic (address: string): Promise<TransactionCheckResult> {
    return await this.checkSingleWallet(address)
  }

  // Основной метод для проверки списка кошельков
  async checkWallets (wallets: string[]): Promise<{
    activeWallets: string[]
    completedWallets: string[]
  }> {
    // Выполняем все проверки параллельно
    const checkPromises = wallets.map(async (wallet) => {
      try {
        const result = await this.checkSingleWallet(wallet)
        return { wallet, result, error: null }
      } catch (error) {
        return {
          wallet,
          result: null,
          error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        }
      }
    })

    // Ждем завершения всех проверок
    const results = await Promise.all(checkPromises)

    const activeWallets: string[] = []
    const completedWallets: string[] = []

    for (const { wallet, result, error } of results) {
      if (error) {
        activeWallets.push(wallet)
        logger.error(`${wallet}: критическая ошибка - ${error}`)
      } else if (result) {
        if (result.status === 'done') {
          completedWallets.push(wallet)
        } else if (result.status === 'not_done') {
          activeWallets.push(wallet)
        } else {
          activeWallets.push(wallet)
          logger.error(`${wallet}: ошибка - ${result.error}`)
        }
      }
    }

    logger.info(`Проверка завершена: активных ${activeWallets.length}, завершенных ${completedWallets.length}`)

    return { activeWallets, completedWallets }
  }

  // Проверка одного кошелька
  private async checkSingleWallet (address: string): Promise<TransactionCheckResult> {
    // Всегда запрашиваем через API
    return await this.checkWalletViaApi(address)
  }

  // Проверка через API с 10 попытками
  private async checkWalletViaApi (address: string): Promise<TransactionCheckResult> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.CONFIG.retryAttempts; attempt++) {
      let proxy: import('../proxy-manager.js').ProxyConfig | null = null

      try {
        proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }
        const result = await this.getTransactionData(address, proxy)

        if (result.success) {
          // Записываем в БД всегда (не только завершенные)
          // Данные уже сохранены в saveSeasonData

          return result
        } else {
          if (this.proxyManager.isProxyAuthError(result.error)) {
            this.proxyManager.markProxyAsUnhealthy(proxy)
            lastError = this.proxyRetryErrorMessage
            continue
          }

          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        if (proxy && this.proxyManager.isProxyAuthError(error)) {
          this.proxyManager.markProxyAsUnhealthy(proxy)
          lastError = this.proxyRetryErrorMessage
          continue
        }

        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      // Небольшая задержка между попытками
      if (attempt < this.CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    return {
      address,
      success: false,
      status: 'error',
      error: `Все ${this.CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}`
    }
  }

  // Получение данных из API
  private async getTransactionData (address: string, proxy: import('../proxy-manager.js').ProxyConfig): Promise<TransactionCheckResult> {
    const startTime = Date.now()

    try {
      const axiosInstance = this.createAxiosInstance(proxy)

      // Получаем данные о поинтах
      const response = await axiosInstance.get(`${this.baseUrl}/profile/calculator?address=${address}`)
      const data = response.data

      const { count, max } = this.parseApiResponse(data)
      const ratio = `${count}/${max}`
      const status = count >= this.CONFIG.pointsLimit ? 'done' : 'not_done'

      return {
        address,
        success: true,
        pointsCount: count,
        maxPoints: max,
        ratio,
        status,
        responseTime: Date.now() - startTime
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        address,
        success: false,
        status: 'error',
        error: errorMessage,
        responseTime: Date.now() - startTime
      }
    }
  }

  // Получение случайного User-Agent
  private getRandomUserAgent (): string {
    const randomIndex = Math.floor(Math.random() * this.userAgents.length)
    return this.userAgents[randomIndex] || this.userAgents[0]!
  }

  // Создание axios instance с прокси
  private createAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
    const proxyAgents = this.proxyManager.createProxyAgents(proxy)
    const userAgent = this.getRandomUserAgent()

    return axios.create({
      timeout: this.CONFIG.timeout,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive'
      },
      httpsAgent: proxyAgents.httpsAgent,
      httpAgent: proxyAgents.httpAgent
    })
  }

  // Парсинг ответа API
  private parseApiResponse (apiData: unknown): { count: number, max: number } {
    // Проверяем, что данные - это массив
    if (!Array.isArray(apiData) || apiData.length === 0) {
      return { count: 0, max: POINTS_LIMIT_SEASON }
    }

    // Преобразуем данные в SeasonData
    const seasonData: SeasonData[] = apiData.map((item: unknown) => {
      const data = item as Record<string, unknown>
      return {
        address: (data['address'] as string) || '',
        baseScore: (data['baseScore'] as number) || 0,
        bonusPoints: (data['bonusPoints'] as number) || 0,
        season: (data['season'] as number) || 0,
        totalScore: (data['totalScore'] as number) || 0,
        activityScore: (data['activityScore'] as number) || 0,
        liquidityScore: (data['liquidityScore'] as number) || 0,
        nftScore: (data['nftScore'] as number) || 0,
        sonyNftScore: (data['sonyNftScore'] as number) || 0,
        isEligible: (data['isEligible'] as boolean) || false,
        status: (data['status'] as string) || '',
        badgesCollected: (data['badgesCollected'] as unknown[]) || [],
        liquidityContributionPoints: (data['liquidityContributionPoints'] as number) || 0,
        txScore: (data['txScore'] as number) || 0,
        activityDaysScore: (data['activityDaysScore'] as number) || 0,
        streakScore: (data['streakScore'] as number) || 0,
        createdAt: (data['createdAt'] as string) || '',
        updatedAt: (data['updatedAt'] as string) || ''
      }
    })

    // Ищем данные текущего сезона
    const seasonDataItem = seasonData.find(item => item.season === CURRENT_SEASON)
    const totalScore = seasonDataItem ? seasonDataItem.totalScore : 0
    const maxPoints = POINTS_LIMIT_SEASON

    return {
      count: totalScore,
      max: maxPoints
    }
  }

}
