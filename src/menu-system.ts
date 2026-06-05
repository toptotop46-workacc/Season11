import { ask } from './typed-prompts.js'
import { privateKeyToAccount } from 'viem/accounts'
import { ParallelExecutor } from './parallel-executor.js'
import { logger } from './logger.js'
import { SoneiumCollector } from './modules/collector.js'
import { performStargateEthDeposit, performStargateEthWithdraw } from './modules/stargate-eth.js'
import { performWalletTopup } from './wallet-topup.js'
import { GasChecker } from './gas-checker.js'
import { ProxyManager } from './proxy-manager.js'
import { performSeasonBadgeMint } from './modules/season-badge-mint.js'
import axios from 'axios'
import ExcelJS from 'exceljs'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CURRENT_SEASON, POINTS_LIMIT_SEASON, BADGE_MINT_CONFIG } from './season-config.js'
import { shutdownManager } from './shutdown.js'
import { config } from './config.js'
import { backoffDelay, sleep } from './backoff.js'
import { Semaphore } from './semaphore.js'

/**
 * Бонусные задания текущего сезона — авто-заполняется из первого ответа API.
 * Пустой массив пока не получены данные; заполняется в discoverBonusColumns().
 */
let BONUS_QUEST_COLUMNS: Array<{ dappId: string, columns: Array<{ key: string, header: string }> }> = []
let BONUS_QUEST_COLUMNS_FLAT: Array<{ key: string, header: string }> = []

/** Дефолтное значение bonusQuests (все N/A) */
function getDefaultBonusQuests (): Record<string, string> {
  return Object.fromEntries(BONUS_QUEST_COLUMNS_FLAT.map(c => [c.key, 'N/A']))
}

/**
 * Авто-обнаружение бонусных колонок из первого ответа bonus-dapp API.
 * Вызывается один раз при получении первых данных.
 */
function discoverBonusColumns (bonusData: BonusDappQuest[]): void {
  if (BONUS_QUEST_COLUMNS.length > 0) return // уже обнаружены
  const seasonQuests = bonusData.filter(q => q.season === CURRENT_SEASON)
  if (seasonQuests.length === 0) return

  BONUS_QUEST_COLUMNS = seasonQuests.map(dapp => ({
    dappId: dapp.id,
    columns: dapp.quests.map((_quest, i) => ({
      key: `${dapp.id}_q${i}`,
      header: dapp.quests.length === 1 ? dapp.name : `${dapp.name} #${i + 1}`
    }))
  }))
  BONUS_QUEST_COLUMNS_FLAT = BONUS_QUEST_COLUMNS.flatMap(d => d.columns)
}

// Интерфейсы для типизации данных статистики
interface SeasonData {
  address: string
  baseScore: number
  bonusPoints: number
  season: number
  totalScore: number | string
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

interface WalletStatisticsResult {
  address: string
  success: boolean
  status: 'done' | 'not_done' | 'error'
  error?: string
  seasonScore: number
  bonusQuests: Record<string, string>
  pointsCount?: number
  originalIndex?: number // Исходный индекс кошелька для правильной нумерации
}

interface ApiResponseData {
  success: boolean
  data?: SeasonData[]
  error?: string
}

interface BonusDappQuest {
  id: string
  season: number
  name: string
  quests: Array<{
    description?: string
    required: number
    completed: number
    isDone: boolean
  }>
}

interface BonusDappResponseData {
  success: boolean
  data?: BonusDappQuest[]
  error?: string
}

interface SeasonBadgeMintTableRow {
  walletNumber: number
  address: string
  seasonPoints: number | null
  mintStatus: 'minted' | 'skipped' | 'error' | 'already_has'
  statusText: string
  transactionHash?: string
  reason?: string
}

/**
 * Система интерактивного меню для Soneium Automation Bot
 */
export class MenuSystem {
  private parallelExecutor: ParallelExecutor
  private cachedPrivateKeys: `0x${string}`[] | null = null
  private proxyManager: ProxyManager

  constructor (parallelExecutor: ParallelExecutor) {
    this.parallelExecutor = parallelExecutor
    this.proxyManager = ProxyManager.getInstance()
  }

  /**
   * Обработчик отмены (Ctrl+C) для prompts
   */
  private handleCancel (): void {
    logger.print('\n\nПолучен сигнал завершения (Ctrl+C)')
    logger.print('Остановка приложения...')
    logger.print('До свидания!')
    void shutdownManager.shutdown(0)
  }

  /**
   * Показывает главное меню
   */
  async showMainMenu (): Promise<void> {
    // Сбрасываем предвыбранные кошельки и исключенные модули при начале новой сессии
    this.parallelExecutor.clearPreselectedWallets()
    this.parallelExecutor.clearExcludedModules()
    try {
      const response = await ask({
        type: 'select',
        name: 'action',
        message: 'Выберите действие:',
        choices: [
          {
            title: 'Запустить работу',
            value: 'start',
            description: 'Запустить автоматизацию с настройкой потоков (каждый поток - уникальный модуль)'
          },
          {
            title: 'Сбор балансов в ETH',
            value: 'collect',
            description: 'Выполнить collector для всех кошельков один раз'
          },
          {
            title: 'Пополнение кошельков',
            value: 'topup',
            description: 'Пополнение кошельков ETH в сети Soneium'
          },
          {
            title: 'Статистика',
            value: 'stats',
            description: 'Показать статистику по кошелькам и поинтам'
          },
          {
            title: 'Ликвидность Stargate',
            value: 'stargate-eth',
            description: 'Депозит ETH (85–95% баланса) или вывод из Stargate пула'
          },
          {
            title: `Минт бейджа за ${BADGE_MINT_CONFIG.season} сезон`,
            value: 'season-badge-mint',
            description: `Проверка и минт NFT бейджа за ${BADGE_MINT_CONFIG.season} сезон`
          },
          {
            title: 'Выход',
            value: 'exit',
            description: 'Завершить работу программы'
          }
        ],
        initial: 0
      })

      if (!response || !response['action']) {
        this.handleCancel()
        return
      }

      if (response['action'] === 'start') {
        await this.showThreadSelectionMenu()
      } else if (response['action'] === 'collect') {
        await this.executeCollectorForAllWallets()
      } else if (response['action'] === 'topup') {
        await this.showTopupMenu()
      } else if (response['action'] === 'stats') {
        await this.showStatistics()
      } else if (response['action'] === 'stargate-eth') {
        await this.showStargateEthMenu()
      } else if (response['action'] === 'season-badge-mint') {
        await this.showSeasonBadgeMintMenu()
      } else if (response['action'] === 'exit') {
        logger.print('\nДо свидания!')
        void shutdownManager.shutdown(0)
      } else {
        logger.print('\nНеверный выбор. Попробуйте снова.')
        await this.showMainMenu()
      }
    } catch (error) {
      logger.error('Ошибка в главном меню', error)
      void shutdownManager.shutdown(1)
    }
  }

  /**
   * Показывает меню выбора количества потоков
   */
  private async showThreadSelectionMenu (): Promise<void> {
    try {
      // Получаем количество доступных модулей для динамического ограничения
      const availableModules = this.parallelExecutor.getAvailableModules()
      const maxThreads = availableModules.length

      logger.print('\nЗАПУСК РАБОТЫ')
      logger.print('='.repeat(80))
      logger.print(`Введите количество потоков (1-${maxThreads}):`)
      logger.print(`Если потоков > 1, каждый будет выполнять уникальный модуль (максимум ${maxThreads})`)

      const response = await ask({
        type: 'number',
        name: 'threadCount',
        message: 'Количество потоков:',
        min: 1,
        max: maxThreads,
        initial: maxThreads,
        validate: (value: number) => {
          if (value < 1 || value > maxThreads) {
            return `Количество потоков должно быть от 1 до ${maxThreads}`
          }
          return true
        }
      })

      if (!response || response['threadCount'] === undefined) {
        this.handleCancel()
        return
      }

      if (response['threadCount']) {
        logger.print(`\nВыбрано ${response['threadCount']} потоков`)

        // Выбор режима работы с кошельками
        const walletModeResponse = await ask({
          type: 'select',
          name: 'walletMode',
          message: 'Выберите режим работы с кошельками:',
          choices: [
            {
              title: 'Все кошельки',
              value: 'all',
              description: 'Автоматический выбор активных кошельков (текущее поведение)'
            },
            {
              title: 'Выбрать кошельки',
              value: 'select',
              description: 'Ручной выбор конкретных кошельков для работы'
            }
          ],
          initial: 0
        })

        if (!walletModeResponse || !walletModeResponse['walletMode']) {
          this.handleCancel()
          return
        }

        if (!walletModeResponse['walletMode']) {
          logger.print('\nНеверный выбор. Попробуйте снова.')
          await this.showThreadSelectionMenu()
          return
        }

        let selectedWallets: { privateKey: `0x${string}`, address: string }[] | null = null

        if (walletModeResponse['walletMode'] === 'select') {
          // Показываем меню выбора кошельков
          selectedWallets = await this.showWalletSelectionMenu()
          if (!selectedWallets || selectedWallets.length === 0) {
            logger.print('\nНе выбрано ни одного кошелька. Операция отменена.')
            await this.showMainMenu()
            return
          }
          logger.print(`\nВыбрано ${selectedWallets.length} кошельков для работы`)
        }

        // Выбор модулей для работы
        const moduleSelectionResponse = await ask({
          type: 'select',
          name: 'selectModules',
          message: 'Выбрать модули для работы?',
          choices: [
            {
              title: 'Все модули',
              value: 'no',
              description: 'Использовать все модули (текущее поведение)'
            },
            {
              title: 'Выбрать модули',
              value: 'yes',
              description: 'Выбрать модули, которые будут использоваться'
            }
          ],
          initial: 0
        })

        if (!moduleSelectionResponse || moduleSelectionResponse['selectModules'] === undefined) {
          this.handleCancel()
          return
        }

        if (moduleSelectionResponse['selectModules'] === 'yes') {
          const selectedModules = await this.showModuleSelectionMenu()
          if (selectedModules === null || selectedModules.length === 0) {
            logger.print('\nНе выбрано ни одного модуля. Операция отменена.')
            await this.showMainMenu()
            return
          }

          try {
            // Исключаем все модули, кроме выбранных
            const allModules = this.parallelExecutor.getAvailableModules()
            const excludedModules = allModules
              .map(m => m.name)
              .filter(name => !selectedModules.includes(name))

            this.parallelExecutor.setExcludedModules(excludedModules)
            logger.print(`\nВыбрано ${selectedModules.length} модулей для работы: ${selectedModules.join(', ')}`)
            if (excludedModules.length > 0) {
              logger.print(`Исключено ${excludedModules.length} модулей: ${excludedModules.join(', ')}`)
            }
          } catch (error) {
            logger.error('Ошибка при установке модулей', error)
            await this.showMainMenu()
            return
          }
        } else {
          // Очищаем исключения модулей (используем все модули)
          this.parallelExecutor.clearExcludedModules()
        }

        const gasResponse = await ask({
          type: 'number',
          name: 'maxGasPrice',
          message: 'Максимальная цена газа в ETH mainnet (Gwei):',
          initial: 1,
          min: 0.1,
          max: 100,
          increment: 0.1,
          validate: (value: number) => {
            if (value <= 0) return 'Значение должно быть больше 0'
            if (value > 100) return 'Максимальное значение: 100 Gwei'
            return true
          }
        })

        if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
          this.handleCancel()
          return
        }

        if (!gasResponse['maxGasPrice']) {
          logger.print('\nНеверное значение газа. Попробуйте снова.')
          await this.showThreadSelectionMenu()
          return
        }

        const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
        logger.print(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

        // Устанавливаем предвыбранные кошельки, если они были выбраны
        if (selectedWallets) {
          this.parallelExecutor.setPreselectedWallets(selectedWallets)
        } else {
          this.parallelExecutor.clearPreselectedWallets()
        }

        logger.print('Запуск параллельного выполнения...')
        logger.print('Для остановки нажмите Ctrl+C')
        logger.print('='.repeat(80))

        // Запускаем параллельное выполнение с проверкой газа
        await this.parallelExecutor.executeInfiniteLoop(response['threadCount'], gasChecker)
      } else {
        logger.print('\nНеверный выбор. Попробуйте снова.')
        await this.showThreadSelectionMenu()
      }
    } catch (error) {
      logger.error('Ошибка в меню выбора потоков', error)
      void shutdownManager.shutdown(1)
    }
  }

  /**
   * Показывает меню выбора кошельков для работы
   */
  private async showWalletSelectionMenu (): Promise<{ privateKey: `0x${string}`, address: string }[] | null> {
    try {
      logger.print('\nВЫБОР КОШЕЛЬКОВ')
      logger.print('='.repeat(80))

      const allPrivateKeys = await this.getAllPrivateKeys()

      if (allPrivateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        return null
      }

      // Создаем список кошельков с адресами
      const wallets = allPrivateKeys.map((privateKey, index) => {
        const account = privateKeyToAccount(privateKey)
        return {
          privateKey,
          address: account.address,
          index: index + 1
        }
      })

      // Формируем выбор для prompts
      const choices = wallets.map((wallet) => ({
        title: `${wallet.index}. ${wallet.address}`,
        value: wallet.address,
        description: `Кошелек #${wallet.index}`
      }))

      // Показываем меню выбора
      const response = await ask({
        type: 'multiselect',
        name: 'selectedAddresses',
        message: `Выберите кошельки для работы (найдено ${wallets.length}):`,
        choices: choices,
        hint: '- Пробел для выбора, Enter для подтверждения'
      })

      if (!response) {
        this.handleCancel()
        return null
      }

      if (!response['selectedAddresses']) {
        return null
      }

      // Используем выбранные адреса
      const selectedAddresses: string[] = response['selectedAddresses'] as string[]

      if (selectedAddresses.length === 0) {
        return null
      }

      // Преобразуем адреса в объекты с privateKey и address
      const selectedWallets = selectedAddresses.map(address => {
        const wallet = wallets.find(w => w.address === address)
        if (!wallet) {
          throw new Error(`Кошелек с адресом ${address} не найден`)
        }
        return {
          privateKey: wallet.privateKey,
          address: wallet.address
        }
      })

      return selectedWallets

    } catch (error) {
      logger.error('Ошибка при выборе кошельков', error)
      return null
    }
  }

  /**
   * Показывает меню выбора модулей для работы
   */
  private async showModuleSelectionMenu (): Promise<string[] | null> {
    try {
      logger.print('\nВЫБОР МОДУЛЕЙ ДЛЯ РАБОТЫ')
      logger.print('='.repeat(80))

      const allModules = this.parallelExecutor.getAvailableModules()

      if (allModules.length === 0) {
        logger.print('Не найдено модулей')
        return null
      }

      // Формируем выбор для prompts
      const choices = allModules.map((module) => ({
        title: module.name,
        value: module.name,
        description: module.description
      }))

      // Показываем меню выбора
      const response = await ask({
        type: 'multiselect',
        name: 'selectedModules',
        message: `Выберите модули для работы (найдено ${allModules.length}):`,
        choices: choices,
        min: 1,
        hint: '- Пробел для выбора, Enter для подтверждения'
      })

      if (!response) {
        this.handleCancel()
        return null
      }

      if (!response['selectedModules'] || response['selectedModules'].length === 0) {
        return null
      }

      // Возвращаем выбранные модули
      const selectedModules = response['selectedModules'] as string[]

      // Валидация: должен быть выбран хотя бы 1 модуль (уже проверено через min: 1)
      return selectedModules

    } catch (error) {
      logger.error('Ошибка при выборе модулей для работы', error)
      return null
    }
  }

  /**
   * Выполняет модуль collector для всех кошельков в случайном порядке
   */
  private async executeCollectorForAllWallets (): Promise<void> {
    try {
      logger.print('\nСБОР БАЛАНСОВ В ETH')
      logger.print('='.repeat(80))

      // Запрос максимальной цены газа
      const gasResponse = await ask({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        logger.print('\nНеверное значение газа. Попробуйте снова.')
        await this.showMainMenu()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      logger.print(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)

      logger.print(`Найдено ${shuffledKeys.length} кошельков`)
      logger.print('Начинаем сбор...')
      logger.print('Для остановки нажмите Ctrl+C')
      logger.print('='.repeat(80))

      // Выполняем collector для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        logger.print(`\nКОШЕЛЕК ${i + 1}/${shuffledKeys.length}:`)
        logger.print('-'.repeat(50))
        logger.print(`Адрес: ${account.address}`)

        try {
          logger.print('Проверяем цену газа...')
          await gasChecker.waitForGasPriceToDrop()

          const collector = new SoneiumCollector(privateKey)
          const result = await collector.performCollection()

          if (result.success) {
            successCount++
            logger.print(`Успешно собрано: ${result.totalCollected} ETH`)
            logger.print(`Собрано токенов: ${result.collectedTokens.length}`)
            logger.print(`Найдена ликвидность в: ${result.liquidityFound.length} протоколах`)
            logger.print(`Выведена ликвидность из: ${result.withdrawnLiquidity.length} протоколов`)
          } else {
            errorCount++
            logger.print(`Ошибка: ${result.error}`)
          }
        } catch (error) {
          errorCount++
          logger.print(`Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        if (i < shuffledKeys.length - 1) {
          logger.print('Пауза 3 секунды...')
          await sleep(3000)
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showCollectorStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при сборе балансов', error)
      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()
    }
  }

  /**
   * Получает все приватные ключи с кэшированием
   */
  private async getAllPrivateKeys (): Promise<`0x${string}`[]> {
    try {
      if (this.cachedPrivateKeys !== null) {
        return this.cachedPrivateKeys
      }

      const { KeyEncryption } = await import('./key-encryption.js')

      let privateKeys: string[] = []

      if (KeyEncryption.hasEncryptedKeys()) {
        logger.print('Получаем все приватные ключи из зашифрованного хранилища...')
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else if (KeyEncryption.hasPlainKeys()) {
        logger.print('Получаем все приватные ключи из keys.txt...')
        privateKeys = KeyEncryption.loadPlainKeys()
      } else {
        throw new Error('Не найдены ключи!')
      }

      this.cachedPrivateKeys = privateKeys as `0x${string}`[]
      logger.print(`Загружено ${this.cachedPrivateKeys.length} приватных ключей`)

      return this.cachedPrivateKeys
    } catch (error) {
      logger.error('Ошибка при получении приватных ключей', error)
      return []
    }
  }

  /**
   * Перемешивает массив в случайном порядке
   */
  private shuffleArray<T> (array: T[]): T[] {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    return shuffled
  }

  /**
   * Получает данные кошелька через API с retry-логикой и случайными прокси
   */
  // Конфигурация для статистики (порог из season-config)
  private readonly STATS_CONFIG = {
    timeout: config.statsApiTimeout,
    retryAttempts: config.statsApiRetryAttempts,
    pointsLimit: POINTS_LIMIT_SEASON,
    baseUrl: config.statsApiBaseUrl
  }

  /**
   * Безопасно преобразует значение в число
   * Поддерживает как числа, так и строки, которые можно преобразовать в число
   */
  private parseScore (value: unknown): number {
    if (typeof value === 'number') {
      return isNaN(value) ? 0 : value
    }
    if (typeof value === 'string') {
      const parsed = Number(value)
      return isNaN(parsed) ? 0 : parsed
    }
    return 0
  }

  /**
   * Экспортирует статистику в Excel файл
   */
  private async exportStatisticsToExcel (results: WalletStatisticsResult[]): Promise<string> {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Статистика')

    // Настройка колонок: базовые + бонусные по конфигу
    worksheet.columns = [
      { header: '№', key: 'number', width: 5 },
      { header: 'Адрес кошелька', key: 'address', width: 45 },
      { header: `Сезон ${CURRENT_SEASON}`, key: 'seasonScore', width: 12 },
      ...BONUS_QUEST_COLUMNS_FLAT.map(c => ({ header: c.header, key: c.key, width: 14 }))
    ]

    // Форматирование заголовков
    const headerRow = worksheet.getRow(1)
    headerRow.font = { bold: true, size: 12 }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' } // Светло-серый фон
    }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
    headerRow.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    }

    // Сортируем результаты по исходному индексу для правильной нумерации
    const sortedResults = [...results].sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0))

    // Добавление данных с цветовой индикацией
    sortedResults.forEach((result) => {
      const rowData: Record<string, string | number> = {
        number: (result.originalIndex ?? 0) + 1,
        address: result.address,
        seasonScore: result.seasonScore ?? 0
      }
      for (const { key } of BONUS_QUEST_COLUMNS_FLAT) {
        rowData[key] = result.bonusQuests[key] ?? 'N/A'
      }
      const row = worksheet.addRow(rowData)

      // Цветовая индикация для текущего сезона
      const seasonScoreCell = row.getCell('seasonScore')
      const score = result.seasonScore ?? 0

      if (score >= POINTS_LIMIT_SEASON) {
        seasonScoreCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF90EE90' } // Светло-зеленый
        }
        seasonScoreCell.font = { bold: true }
      } else if (score >= 80) {
        seasonScoreCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFFFE0' } // Светло-желтый
        }
        seasonScoreCell.font = { bold: true }
      } else {
        seasonScoreCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFB6C1' } // Светло-розовый/красный
        }
        seasonScoreCell.font = { bold: true }
      }

      // Цветовая индикация для заданий
      const formatQuestCell = (cell: ExcelJS.Cell, quest: string) => {
        if (quest === 'N/A') {
          // Серый для недоступных
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFD3D3D3' }
          }
        } else {
          // Проверяем прогресс (формат "X/Y")
          const match = quest.match(/^(\d+)\/(\d+)$/)
          if (match) {
            const completed = parseInt(match[1]!, 10)
            const required = parseInt(match[2]!, 10)
            if (completed >= required) {
              // Зеленый для выполненных (X >= Y)
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF90EE90' }
              }
              cell.font = { bold: true }
            } else if (completed === 0) {
              // Красный для 0/X
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFB6C1' }
              }
            } else {
              // Желтый для частичного прогресса
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFFFE0' }
              }
            }
          }
        }
        cell.alignment = { horizontal: 'center' }
      }

      for (const { key } of BONUS_QUEST_COLUMNS_FLAT) {
        formatQuestCell(row.getCell(key), result.bonusQuests[key] ?? 'N/A')
      }

      // Выравнивание числовых значений
      const numberCell = row.getCell('number')
      numberCell.alignment = { horizontal: 'center' }
      seasonScoreCell.alignment = { horizontal: 'center' }
    })

    // Заморозка заголовка при прокрутке
    worksheet.views = [{
      state: 'frozen',
      ySplit: 1 // Заморозить первую строку
    }]

    // Создание папки exports если её нет
    const exportsDir = join(process.cwd(), 'exports')
    if (!existsSync(exportsDir)) {
      mkdirSync(exportsDir, { recursive: true })
    }

    // Генерация имени файла с датой и временем
    const now = new Date()
    const timestamp = now.toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, -5)
      .replace('T', '_')
    const fileName = `statistics_${timestamp}.xlsx`
    const filePath = join(exportsDir, fileName)

    // Сохранение файла
    await workbook.xlsx.writeFile(filePath)

    return filePath
  }

  private async fetchWalletDataWithRetry (address: string): Promise<SeasonData[] | ApiResponseData> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.STATS_CONFIG.retryAttempts; attempt++) {
      let proxy: import('./proxy-manager.js').ProxyConfig | null = null

      try {
        proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }

        const result = await this.getWalletDataViaApi(address, proxy)

        if (result.success && result.data) {
          return result.data
        } else {
          if (this.proxyManager.isProxyAuthError(result.error)) {
            this.proxyManager.markProxyAsUnhealthy(proxy)
            lastError = 'Не удалось подобрать рабочий прокси'
            continue
          }

          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        if (proxy && this.proxyManager.isProxyAuthError(error)) {
          this.proxyManager.markProxyAsUnhealthy(proxy)
          lastError = 'Не удалось подобрать рабочий прокси'
          continue
        }

        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await sleep(backoffDelay(attempt, { baseMs: 2000 }))
      }
    }

    return { success: false, error: `Все ${this.STATS_CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}` }
  }

  // Получение данных из API через прокси (аналогично transaction-checker)
  private async getWalletDataViaApi (address: string, proxy: import('./proxy-manager.js').ProxyConfig): Promise<ApiResponseData> {
    try {
      const axiosInstance = this.createStatsAxiosInstance(proxy)

      // Получаем данные о поинтах
      const response = await axiosInstance.get(`${this.STATS_CONFIG.baseUrl}/profile/calculator?address=${address}`)
      const data = response.data

      // Проверяем, что данные корректные
      if (!data) {
        return {
          success: false,
          error: 'API вернул пустой ответ'
        }
      }

      // Если это массив и он пустой, это нормально (аналогично transaction-checker)
      if (Array.isArray(data) && data.length === 0) {
        return {
          success: true,
          data: []
        }
      }

      return {
        success: true,
        data: data
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  // Получение данных bonus-dapp из API через прокси
  private async getBonusDappDataViaApi (address: string, proxy: import('./proxy-manager.js').ProxyConfig): Promise<BonusDappResponseData> {
    try {
      const axiosInstance = this.createStatsAxiosInstance(proxy)

      // Получаем данные о доп заданиях
      const response = await axiosInstance.get(`${this.STATS_CONFIG.baseUrl}/profile/bonus-dapp?address=${address}`)
      const data = response.data

      // Проверяем, что данные корректные
      if (!data) {
        return {
          success: false,
          error: 'API вернул пустой ответ'
        }
      }

      // Если это массив и он пустой, это нормально
      if (Array.isArray(data) && data.length === 0) {
        return {
          success: true,
          data: []
        }
      }

      return {
        success: true,
        data: data
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  // Получение данных bonus-dapp с retry-логикой
  private async fetchBonusDappDataWithRetry (address: string): Promise<BonusDappQuest[] | BonusDappResponseData> {
    let lastError = ''

    for (let attempt = 1; attempt <= this.STATS_CONFIG.retryAttempts; attempt++) {
      let proxy: import('./proxy-manager.js').ProxyConfig | null = null

      try {
        proxy = this.proxyManager.getRandomProxyFast()
        if (!proxy) {
          throw new Error('Нет доступных прокси')
        }

        const result = await this.getBonusDappDataViaApi(address, proxy)

        if (result.success && result.data) {
          return result.data
        } else {
          if (this.proxyManager.isProxyAuthError(result.error)) {
            this.proxyManager.markProxyAsUnhealthy(proxy)
            lastError = 'Не удалось подобрать рабочий прокси'
            continue
          }

          lastError = result.error || 'Неизвестная ошибка'
        }
      } catch (error) {
        if (proxy && this.proxyManager.isProxyAuthError(error)) {
          this.proxyManager.markProxyAsUnhealthy(proxy)
          lastError = 'Не удалось подобрать рабочий прокси'
          continue
        }

        lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      }

      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await sleep(backoffDelay(attempt, { baseMs: 2000 }))
      }
    }

    return { success: false, error: `Все ${this.STATS_CONFIG.retryAttempts} попыток неудачны. Последняя ошибка: ${lastError}` }
  }

  // Парсинг заданий текущего сезона из bonus-dapp данных (по одному столбцу на квест)
  private parseBonusQuests (bonusData: BonusDappQuest[]): Record<string, string> {
    const seasonQuests = bonusData.filter((item) => item.season === CURRENT_SEASON)
    const out: Record<string, string> = { ...getDefaultBonusQuests() }

    for (const { dappId, columns } of BONUS_QUEST_COLUMNS) {
      const dapp = seasonQuests.find((item) => item.id === dappId)
      if (!dapp) continue
      for (let i = 0; i < columns.length; i++) {
        const quest = dapp.quests[i]
        out[columns[i]!.key] = quest ? `${quest.completed}/${quest.required}` : 'N/A'
      }
    }
    return out
  }

  // Создание axios instance с прокси для статистики (аналогично transaction-checker)
  private createStatsAxiosInstance (proxy: import('./proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
    const proxyAgents = this.proxyManager.createProxyAgents(proxy)
    const userAgent = this.getRandomUserAgent()

    return axios.create({
      timeout: this.STATS_CONFIG.timeout,
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

  /**
   * Получает случайный User-Agent
   */
  private getRandomUserAgent (): string {
    const userAgents = [
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

    const randomIndex = Math.floor(Math.random() * userAgents.length)
    return userAgents[randomIndex]!
  }

  /**
   * Показывает статистику по кошелькам и поинтам
   */
  private async showStatistics (): Promise<void> {
    try {
      logger.print('\nСТАТИСТИКА ПО КОШЕЛЬКАМ')
      logger.print('='.repeat(80))
      logger.print('Получаем актуальные данные через API с прокси...')

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const addresses = privateKeys.map(pk => privateKeyToAccount(pk).address)

      logger.print(`Проверяем ${addresses.length} кошельков...`)

      // Счетчик для прогресс-бара
      let completedCount = 0
      const totalCount = addresses.length

      // Функция для обновления прогресс-бара
      const updateProgress = () => {
        const percentage = Math.round((completedCount / totalCount) * 100)
        process.stdout.write(`\rПроверка кошельков: [${completedCount}/${totalCount}] ${percentage}%`)
      }

      // Семафор для ограничения конкурентности (адаптивный)
      const INITIAL_CONCURRENCY = config.statsConcurrency
      const sem = new Semaphore(INITIAL_CONCURRENCY)
      let consecutiveErrors = 0
      const MAX_CONSECUTIVE_ERRORS = 5 // Circuit breaker порог

      const fetchWallet = async (address: string, originalIndex: number): Promise<WalletStatisticsResult> => {
        return sem.run(async () => {
          // Circuit breaker: пауза при серии ошибок
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            const pauseMs = 15_000
            logger.warn(`Circuit breaker: ${consecutiveErrors} ошибок подряд, пауза ${pauseMs / 1000}с`)
            await sleep(pauseMs)
            consecutiveErrors = 0
            sem.setLimit(Math.max(3, Math.floor(sem.limit / 2)))
          }

          try {
            const [walletData, bonusData] = await Promise.all([
              this.fetchWalletDataWithRetry(address),
              this.fetchBonusDappDataWithRetry(address)
            ])

            let seasonScore = 0
            let status: 'done' | 'not_done' | 'error' = 'error'

            if (!Array.isArray(walletData) && walletData.error) {
              consecutiveErrors++
              completedCount++
              updateProgress()
              return {
                address,
                success: false,
                status: 'error' as const,
                error: walletData.error,
                seasonScore: 0,
                bonusQuests: getDefaultBonusQuests(),
                originalIndex
              }
            }

            if (Array.isArray(walletData) && walletData.length > 0) {
              const seasonDataItem = walletData.find((item: SeasonData) => item.season === CURRENT_SEASON)
              seasonScore = seasonDataItem ? this.parseScore(seasonDataItem.totalScore) : 0
              status = seasonScore >= this.STATS_CONFIG.pointsLimit ? 'done' : 'not_done'
            } else {
              status = 'not_done'
            }

            // Авто-обнаружение бонусных колонок из первого ответа
            if (Array.isArray(bonusData) && bonusData.length > 0) {
              discoverBonusColumns(bonusData)
            }

            let bonusQuests: Record<string, string> = getDefaultBonusQuests()

            if (Array.isArray(bonusData) && bonusData.length > 0) {
              bonusQuests = this.parseBonusQuests(bonusData)
            }

            consecutiveErrors = 0 // Сброс при успехе
            // Плавно поднимаем конкурентность обратно при успехах
            if (sem.limit < INITIAL_CONCURRENCY) {
              sem.setLimit(Math.min(sem.limit + 1, INITIAL_CONCURRENCY))
            }

            completedCount++
            updateProgress()

            return {
              address,
              success: true,
              status,
              seasonScore,
              bonusQuests,
              pointsCount: seasonScore,
              originalIndex
            }
          } catch (error) {
            consecutiveErrors++
            completedCount++
            updateProgress()
            return {
              address,
              success: false,
              status: 'error' as const,
              error: error instanceof Error ? error.message : 'Неизвестная ошибка',
              seasonScore: 0,
              bonusQuests: getDefaultBonusQuests(),
              originalIndex
            }
          }
        })
      }

      // Все кошельки запускаются через семафор — конкурентность регулируется автоматически
      const results = await Promise.all(
        addresses.map((address, i) => fetchWallet(address, i))
      )

      // Завершаем прогресс-бар
      logger.print('\n')

      // Сортируем результаты по исходному индексу для правильной нумерации
      results.sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0))

      // eslint-disable-next-line no-control-regex -- намеренно ищем ANSI escape-коды
      const ANSI_RE = /\x1b\[\d+m/g

      const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

      const padToVisible = (s: string, w: number): string => {
        const visLen = stripAnsi(s).length
        return visLen >= w ? s : s + ' '.repeat(w - visLen)
      }

      // Ширины колонок: динамически по длине заголовка бонус-квестов
      const W_NUM = 6
      const W_ADDR = 55
      const W_SEASON = 9
      const bonusWidths = BONUS_QUEST_COLUMNS_FLAT.map(c => Math.max(c.header.length + 1, 8))
      const colWidths = [W_NUM, W_ADDR, W_SEASON, ...bonusWidths]

      const sepParts = colWidths.map(w => '─'.repeat(w))
      const topLine = '┌' + sepParts.join('┬') + '┐'
      const midLine = '├' + sepParts.join('┼') + '┤'
      const botLine = '└' + sepParts.join('┴') + '┘'
      const headerCells = [
        '#'.padStart(W_NUM),
        'Wallet Address'.padEnd(W_ADDR),
        `Season ${CURRENT_SEASON}`.padEnd(W_SEASON),
        ...BONUS_QUEST_COLUMNS_FLAT.map((c, i) => c.header.padEnd(colWidths[3 + i]!))
      ]
      logger.print(topLine)
      logger.print('│' + headerCells.map((c, i) => padToVisible(c, colWidths[i]!)).join('│') + '│')
      logger.print(midLine)

      const formatQuest = (quest: string, width: number): string => {
        const padded = quest.padStart(width)
        if (quest === 'N/A') return padded
        const match = quest.match(/^(\d+)\/(\d+)$/)
        if (match) {
          const completed = parseInt(match[1]!, 10)
          const required = parseInt(match[2]!, 10)
          if (completed >= required) return `\x1b[32m${padded}\x1b[0m`
          if (completed === 0) return `\x1b[31m${padded}\x1b[0m`
          return `\x1b[33m${padded}\x1b[0m`
        }
        return padded
      }

      results.forEach((result) => {
        const walletNumber = ((result.originalIndex ?? 0) + 1).toString().padStart(W_NUM)
        const address = (result.address.length > 50 ? result.address.substring(0, 47) + '...' : result.address).padEnd(W_ADDR)

        let seasonStr = result.seasonScore !== undefined ? result.seasonScore.toString().padStart(W_SEASON) : 'N/A'.padStart(W_SEASON)
        if (result.seasonScore !== undefined) {
          if (result.seasonScore >= POINTS_LIMIT_SEASON) {
            seasonStr = `\x1b[32m${seasonStr}\x1b[0m`
          } else if (result.seasonScore >= 80) {
            seasonStr = `\x1b[33m${seasonStr}\x1b[0m`
          } else {
            seasonStr = `\x1b[31m${seasonStr}\x1b[0m`
          }
        }

        const bonusCells = BONUS_QUEST_COLUMNS_FLAT.map((c, i) => formatQuest(result.bonusQuests[c.key] ?? 'N/A', colWidths[3 + i]!))
        const rowCells = [walletNumber, address, seasonStr, ...bonusCells]
        logger.print('│' + rowCells.map((c, i) => padToVisible(c, colWidths[i]!)).join('│') + '│')
      })

      logger.print(botLine)

      logger.print('='.repeat(80))

      // Предложение экспорта в Excel
      const exportResponse = await ask({
        type: 'confirm',
        name: 'value',
        message: 'Экспортировать статистику в Excel файл?',
        initial: true
      })

      if (!exportResponse) {
        this.handleCancel()
        return
      }

      if (exportResponse['value']) {
        try {
          logger.print('\nСоздание Excel файла...')
          const filePath = await this.exportStatisticsToExcel(results)
          logger.print('\nСтатистика успешно экспортирована!')
          logger.print(`Путь к файлу: ${filePath}`)
        } catch (error) {
          logger.error('Ошибка при экспорте в Excel', error)
        }
      }

      // Возвращаемся в главное меню
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при получении статистики', error)
      await this.showMainMenu()
    }
  }

  /**
   * Показывает статистику выполнения collector
   */
  private showCollectorStatistics (successCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    logger.print('\nФИНАЛЬНАЯ СТАТИСТИКА СБОРА')
    logger.print('='.repeat(80))
    logger.print(`Всего кошельков: ${totalCount}`)
    logger.print(`Успешно обработано: ${successCount}`)
    logger.print(`Ошибок: ${errorCount}`)
    logger.print(`Общее время: ${totalTime.toFixed(2)} секунд`)
    logger.print(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    logger.print('='.repeat(80))
    logger.print('СБОР ЗАВЕРШЕН!')
    logger.print('='.repeat(80))
  }

  /**
   * Показывает меню пополнения кошельков
   */
  private async showTopupMenu (): Promise<void> {
    try {
      logger.print('\nПОПОЛНЕНИЕ КОШЕЛЬКОВ ETH В СЕТИ SONEIUM')
      logger.print('='.repeat(80))

      // 1. Минимальная сумма
      const minAmount = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную сумму пополнения (USD):',
        initial: 10,
        min: 1,
        validate: (value: number) => value > 0 ? true : 'Сумма должна быть больше 0'
      })

      if (!minAmount || minAmount['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 2. Максимальная сумма
      const maxAmount = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную сумму пополнения (USD):',
        initial: 50,
        min: minAmount['value'],
        validate: (value: number) => value >= minAmount['value'] ? true : 'Максимальная сумма должна быть больше или равна минимальной'
      })

      if (!maxAmount || maxAmount['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 3. Минимальная задержка
      const minDelay = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную задержку между кошельками (минуты):',
        initial: 2,
        min: 1,
        validate: (value: number) => value >= 1 ? true : 'Задержка должна быть не менее 1 минуты'
      })

      if (!minDelay || minDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 4. Максимальная задержка
      const maxDelay = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную задержку между кошельками (минуты):',
        initial: 5,
        min: minDelay['value'],
        validate: (value: number) => value >= minDelay['value'] ? true : 'Максимальная задержка должна быть больше или равна минимальной'
      })

      if (!maxDelay || maxDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 5. Запрос максимальной цены газа
      const gasResponse = await ask({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        logger.print('\nНеверное значение газа. Попробуйте снова.')
        await this.showTopupMenu()
        return
      }

      logger.print('\nНастройки пополнения:')
      logger.print(`Сумма: $${minAmount['value']} - $${maxAmount['value']}`)
      logger.print(`Задержки: ${minDelay['value']} - ${maxDelay['value']} минут`)
      logger.print(`Лимит газа: ${gasResponse['maxGasPrice']} Gwei`)
      logger.print('='.repeat(80))

      const confirm = await ask({
        type: 'confirm',
        name: 'value',
        message: 'Запустить пополнение с этими настройками?',
        initial: true
      })

      if (!confirm) {
        this.handleCancel()
        return
      }

      if (confirm['value']) {
        const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
        logger.print(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

        await this.executeTopupForAllWallets(minAmount['value'], maxAmount['value'], minDelay['value'], maxDelay['value'], gasChecker)
      } else {
        logger.print('Пополнение отменено')
        await this.showMainMenu()
      }
    } catch (error) {
      logger.error('Ошибка в меню пополнения', error)
      await this.showMainMenu()
    }
  }

  /**
   * Выполняет пополнение для всех кошельков
   */
  private async executeTopupForAllWallets (minUSD: number, maxUSD: number, minDelay: number, maxDelay: number, gasChecker?: GasChecker): Promise<void> {
    try {
      logger.print('\nЗАПУСК ПОПОЛНЕНИЯ КОШЕЛЬКОВ')
      logger.print('='.repeat(80))

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)

      logger.print(`Найдено ${shuffledKeys.length} кошельков`)
      logger.print('Начинаем пополнение...')
      logger.print('Для остановки нажмите Ctrl+C')
      logger.print('='.repeat(80))

      // Выполняем пополнение для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        logger.print(`\nПОПОЛНЕНИЕ КОШЕЛЬКА ${i + 1}/${shuffledKeys.length}:`)
        logger.print('-'.repeat(50))
        logger.print(`Адрес: ${account.address}`)

        try {
          // Вызываем реальный модуль пополнения
          const config = {
            minAmountUSD: minUSD,
            maxAmountUSD: maxUSD,
            minDelayMinutes: minDelay,
            maxDelayMinutes: maxDelay
          }

          const result = await performWalletTopup(privateKey, config, gasChecker)

          if (result.success) {
            successCount++
            logger.print('Пополнение выполнено успешно!')
            logger.print(`Сумма: $${result.amountUSD.toFixed(2)} (${result.amountETH} ETH)`)
            if (result.mexcWithdrawId) {
              logger.print(`MEXC ID: ${result.mexcWithdrawId}`)
            }
            if (result.bridgeTxHash) {
              logger.print(`Bridge TX: ${result.bridgeTxHash}`)
            }
          } else {
            throw new Error(result.error || 'Неизвестная ошибка пополнения')
          }

        } catch (error) {
          errorCount++
          logger.print(`Ошибка пополнения: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        // Задержка между кошельками (кроме последнего)
        if (i < shuffledKeys.length - 1) {
          const delayMinutes = Math.random() * (maxDelay - minDelay) + minDelay
          const delayMs = delayMinutes * 60 * 1000

          logger.print(`Пауза ${delayMinutes.toFixed(2)} минут (${Math.round(delayMs / 1000)} секунд) до следующего кошелька...`)
          await sleep(delayMs)
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showTopupStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при пополнении кошельков', error)
      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()
    }
  }

  /**
   * Показывает статистику выполнения пополнения
   */
  private showTopupStatistics (successCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    logger.print('\nФИНАЛЬНАЯ СТАТИСТИКА ПОПОЛНЕНИЯ')
    logger.print('='.repeat(80))
    logger.print(`Всего кошельков: ${totalCount}`)
    logger.print(`Успешно пополнено: ${successCount}`)
    logger.print(`Ошибок: ${errorCount}`)
    logger.print(`Общее время: ${totalTime.toFixed(2)} секунд`)
    logger.print(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    logger.print('='.repeat(80))
    logger.print('ПОПОЛНЕНИЕ ЗАВЕРШЕНО!')
    logger.print('='.repeat(80))
  }

  /**
   * Показывает меню Ликвидность Stargate (ETH)
   */
  private async showStargateEthMenu (): Promise<void> {
    try {
      logger.print('\nЛИКВИДНОСТЬ STARGATE (ETH)')
      logger.print('='.repeat(80))

      const actionResponse = await ask({
        type: 'select',
        name: 'action',
        message: 'Выберите операцию:',
        choices: [
          {
            title: 'Депозит',
            value: 'deposit',
            description: 'Внести 85–95% ETH в Stargate пул (генерирует liqScore)'
          },
          {
            title: 'Вывод',
            value: 'withdraw',
            description: 'Вывести все S*ETH LP токены обратно в ETH'
          }
        ],
        initial: 0
      })

      if (!actionResponse || !actionResponse['action']) {
        this.handleCancel()
        return
      }

      const operation = actionResponse['action'] as 'deposit' | 'withdraw'

      const gasResponse = await ask({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      logger.print(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      const delayMinResponse = await ask({
        type: 'number',
        name: 'delayMinSec',
        message: 'Мин. пауза между кошельками (сек):',
        initial: 30,
        min: 1,
        max: 86400,
        validate: (value: number) => {
          if (!Number.isFinite(value) || value < 1) return 'Минимум 1 секунда'
          if (value > 86400) return 'Максимум 86400 сек (24 ч)'
          return true
        }
      })

      if (!delayMinResponse || delayMinResponse['delayMinSec'] === undefined) {
        this.handleCancel()
        return
      }

      const delayMaxResponse = await ask({
        type: 'number',
        name: 'delayMaxSec',
        message: 'Макс. пауза между кошельками (сек):',
        initial: Math.max(30, Math.floor(delayMinResponse['delayMinSec'])),
        min: 1,
        max: 86400,
        validate: (value: number) => {
          if (!Number.isFinite(value) || value < 1) return 'Минимум 1 секунда'
          if (value > 86400) return 'Максимум 86400 сек (24 ч)'
          if (value < delayMinResponse['delayMinSec']) {
            return `Не меньше минимума (${delayMinResponse['delayMinSec']} сек)`
          }
          return true
        }
      })

      if (!delayMaxResponse || delayMaxResponse['delayMaxSec'] === undefined) {
        this.handleCancel()
        return
      }

      const delayMinSec = Math.floor(delayMinResponse['delayMinSec'])
      const delayMaxSec = Math.floor(delayMaxResponse['delayMaxSec'])
      if (delayMinSec < 1 || delayMaxSec < delayMinSec) {
        logger.print('Некорректный диапазон паузы. Возврат в главное меню.')
        await this.showMainMenu()
        return
      }
      logger.print(`Пауза между кошельками: случайно от ${delayMinSec} до ${delayMaxSec} сек`)

      const privateKeys = await this.getAllPrivateKeys()
      if (privateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)
      const opLabel = operation === 'deposit' ? 'ДЕПОЗИТ' : 'ВЫВОД'
      logger.print(`\n${opLabel} для ${shuffledKeys.length} кошельков`)
      logger.print('Для остановки нажмите Ctrl+C')
      logger.print('='.repeat(80))

      let successCount = 0
      let skippedCount = 0
      let errorCount = 0
      const startTime = Date.now()
      const failedKeys: `0x${string}`[] = []

      const runBatch = async (keys: `0x${string}`[], batchLabel: string): Promise<void> => {
        for (let i = 0; i < keys.length; i++) {
          const privateKey = keys[i]!
          const { privateKeyToAccount: pkToAccount } = await import('viem/accounts')
          const account = pkToAccount(privateKey)

          logger.print(`\n${batchLabel} ${i + 1}/${keys.length}:`)
          logger.print('-'.repeat(50))
          logger.print(`Адрес: ${account.address}`)

          try {
            logger.print('Проверяем цену газа...')
            await gasChecker.waitForGasPriceToDrop()

            const result = operation === 'deposit'
              ? await performStargateEthDeposit(privateKey)
              : await performStargateEthWithdraw(privateKey)

            if (result.skipped) {
              skippedCount++
              logger.print(`Пропущен: ${result.reason}`)
            } else if (result.success) {
              successCount++
              const failedIdx = failedKeys.indexOf(privateKey)
              if (failedIdx !== -1) failedKeys.splice(failedIdx, 1)
              if (operation === 'deposit' && 'depositAmount' in result) {
                logger.print(`Депозит: ${result.depositAmount} ETH`)
              } else if (operation === 'withdraw' && 'lpAmount' in result) {
                logger.print(`Выведено LP: ${result.lpAmount} S*ETH`)
              }
              if (result.transactionHash) {
                logger.print(`TX: ${result.transactionHash}`)
                logger.print(`Explorer: ${result.explorerUrl}`)
              }
            } else {
              errorCount++
              logger.print(`Ошибка: ${result.error}`)
              if (!failedKeys.includes(privateKey)) failedKeys.push(privateKey)
            }
          } catch (error) {
            errorCount++
            logger.print(`Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
            if (!failedKeys.includes(privateKey)) failedKeys.push(privateKey)
          }

          if (i < keys.length - 1) {
            const pauseSec = delayMinSec + Math.floor(Math.random() * (delayMaxSec - delayMinSec + 1))
            logger.print(`Пауза ${pauseSec} секунд...`)
            await sleep(pauseSec * 1000)
          }
        }
      }

      await runBatch(shuffledKeys, 'КОШЕЛЕК')

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      logger.print('\n' + '='.repeat(80))
      logger.print(`ИТОГО: Успешно: ${successCount} | Пропущено: ${skippedCount} | Ошибок: ${errorCount}`)
      logger.print(`Время выполнения: ${totalTime} сек`)

      while (failedKeys.length > 0) {
        logger.print(`\n⚠️  Упали ${failedKeys.length} кошелек(ов). Повторить попытку?`)
        const retryResponse = await ask({
          type: 'confirm',
          name: 'retry',
          message: `Запустить повтор для ${failedKeys.length} упавших кошельков?`,
          initial: true
        })

        if (!retryResponse || !retryResponse['retry']) break

        const retryKeys = [...failedKeys]
        failedKeys.length = 0
        errorCount = 0
        logger.print(`\nПОВТОР для ${retryKeys.length} кошельков...`)
        logger.print('='.repeat(80))
        await runBatch(retryKeys, 'ПОВТОР')

        logger.print('\n' + '='.repeat(80))
        logger.print(`После повтора — Успешно: ${successCount} | Пропущено: ${skippedCount} | Ошибок: ${failedKeys.length}`)
      }

      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка в меню Stargate ETH', error)
      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()
    }
  }

  /**
   * Показывает меню минта бейджа
   */
  private async showSeasonBadgeMintMenu (): Promise<void> {
    try {
      logger.print(`\nМИНТ БЕЙДЖА ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН`)
      logger.print('='.repeat(80))

      // Запрос максимальной цены газа
      const gasResponse = await ask({
        type: 'number',
        name: 'maxGasPrice',
        message: 'Максимальная цена газа в ETH mainnet (Gwei):',
        initial: 5,
        min: 0.1,
        max: 100,
        increment: 0.1,
        validate: (value: number) => {
          if (value <= 0) return 'Значение должно быть больше 0'
          if (value > 100) return 'Максимальное значение: 100 Gwei'
          return true
        }
      })

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        logger.print('\nНеверное значение газа. Попробуйте снова.')
        await this.showMainMenu()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      logger.print(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      // Запрос минимальной задержки
      const minDelay = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную задержку между минтами (минуты):',
        initial: 2,
        min: 1,
        validate: (value: number) => value >= 1 ? true : 'Задержка должна быть не менее 1 минуты'
      })

      if (!minDelay || minDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // Запрос максимальной задержки
      const maxDelay = await ask({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную задержку между минтами (минуты):',
        initial: 5,
        min: minDelay['value'],
        validate: (value: number) => value >= minDelay['value'] ? true : 'Максимальная задержка должна быть больше или равна минимальной'
      })

      if (!maxDelay || maxDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      logger.print(`Задержки между минтами: ${minDelay['value']} - ${maxDelay['value']} минут`)
      logger.print('Задержка применяется только после успешного минта')

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        logger.print('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const keysWithIndex = privateKeys.map((key, index) => ({
        originalIndex: index,
        privateKey: key
      }))

      logger.print(`Найдено ${keysWithIndex.length} кошельков`)
      logger.print('Начинаем проверку и минт...')
      logger.print('Для остановки нажмите Ctrl+C')
      logger.print('='.repeat(80))

      // Выполняем минт для каждого кошелька
      let successCount = 0
      let skippedCount = 0
      let errorCount = 0
      const startTime = Date.now()
      let previousMintSuccessful = false // Отслеживаем, был ли предыдущий минт успешным
      const results: SeasonBadgeMintTableRow[] = [] // Массив для хранения результатов

      for (let i = 0; i < keysWithIndex.length; i++) {
        const { originalIndex, privateKey } = keysWithIndex[i]!
        const account = privateKeyToAccount(privateKey)

        logger.print(`\nКОШЕЛЕК ${i + 1}/${keysWithIndex.length}:`)
        logger.print('-'.repeat(50))
        logger.print(`Адрес: ${account.address}`)

        try {
          logger.print('Проверяем цену газа...')
          await gasChecker.waitForGasPriceToDrop()

          const result = await performSeasonBadgeMint(privateKey, BADGE_MINT_CONFIG)

          // Сбрасываем флаг перед проверкой результата
          previousMintSuccessful = false

          // Определяем статус для таблицы
          let mintStatus: 'minted' | 'skipped' | 'error' | 'already_has'
          let statusText: string

          if (result.success) {
            if (result.skipped) {
              skippedCount++
              if (result.reason?.includes('NFT уже есть')) {
                mintStatus = 'already_has'
                statusText = 'Minted'
              } else if (result.reason?.includes('Недостаточно поинтов')) {
                mintStatus = 'skipped'
                statusText = 'Not Eligible'
              } else {
                mintStatus = 'skipped'
                statusText = 'Skipped'
              }
              logger.print(`Пропущен: ${result.reason || 'Не указана причина'}`)
            } else {
              successCount++
              previousMintSuccessful = true // Устанавливаем флаг успешного минта
              mintStatus = 'minted'
              statusText = 'Minted'
              logger.print('Минт выполнен успешно!')
              if (result.transactionHash) {
                logger.print(`TX Hash: ${result.transactionHash}`)
                if (result.explorerUrl) {
                  logger.print(`Explorer: ${result.explorerUrl}`)
                }
              }
            }
          } else {
            errorCount++
            mintStatus = 'error'
            statusText = 'Ошибка'
            logger.print(`Ошибка: ${result.error || 'Неизвестная ошибка'}`)
          }

          // Сохраняем результат для таблицы (используем оригинальный индекс из keys.txt)
          const tableResult: SeasonBadgeMintTableRow = {
            walletNumber: originalIndex + 1,
            address: account.address,
            seasonPoints: result.seasonPoints ?? null,
            mintStatus,
            statusText
          }
          if (result.transactionHash) {
            tableResult.transactionHash = result.transactionHash
          }
          if (result.reason) {
            tableResult.reason = result.reason
          }
          results.push(tableResult)
        } catch (error) {
          errorCount++
          previousMintSuccessful = false
          const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
          logger.print(`Критическая ошибка: ${errorMessage}`)

          // Сохраняем результат с ошибкой (используем оригинальный индекс из keys.txt)
          results.push({
            walletNumber: originalIndex + 1,
            address: account.address,
            seasonPoints: null,
            mintStatus: 'error',
            statusText: 'Ошибка',
            reason: errorMessage
          })
        }

        // Задержка между кошельками (только если предыдущий минт был успешным и это не последний кошелек)
        if (i < keysWithIndex.length - 1 && previousMintSuccessful) {
          const delayMinutes = Math.random() * (maxDelay['value'] - minDelay['value']) + minDelay['value']
          const delayMs = delayMinutes * 60 * 1000

          logger.print(`Задержка ${delayMinutes.toFixed(2)} минут (${Math.round(delayMs / 1000)} секунд) до следующего кошелька...`)
          await sleep(delayMs)
        } else if (i < keysWithIndex.length - 1) {
          logger.print('Пауза 3 секунды...')
          await sleep(3000)
        }
      }

      // Сортируем результаты по оригинальному номеру кошелька из keys.txt
      results.sort((a, b) => a.walletNumber - b.walletNumber)

      // Показываем таблицу результатов
      this.showSeasonBadgeMintTable(results)

      // Предложение экспорта в Excel
      const exportResponse = await ask({
        type: 'confirm',
        name: 'value',
        message: 'Экспортировать результаты минта в Excel файл?',
        initial: true
      })

      if (!exportResponse) {
        this.handleCancel()
        return
      }

      if (exportResponse['value']) {
        try {
          logger.print('\nСоздание Excel файла...')
          const filePath = await this.exportSeasonBadgeMintToExcel(results)
          logger.print('\nРезультаты успешно экспортированы!')
          logger.print(`Путь к файлу: ${filePath}`)
        } catch (error) {
          logger.error('Ошибка при экспорте в Excel', error)
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showSeasonBadgeMintStatistics(successCount, skippedCount, errorCount, keysWithIndex.length, totalTime)

      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при минте бейджей', error)
      logger.print('\nВозврат в главное меню через 5 секунд...')
      await sleep(5000)
      await this.showMainMenu()
    }
  }

  /**
   * Показывает таблицу результатов минта бейджей
   */
  private showSeasonBadgeMintTable (results: SeasonBadgeMintTableRow[]): void {
    const seasonLabel = `Season ${BADGE_MINT_CONFIG.season}`
    // Внутренняя ширина колонки поинтов: минимум 9 chars (для 'Season 9'), расширяется для двухзначных номеров
    const seasonColInner = Math.max(9, seasonLabel.length + 1)
    const pointsWidth = seasonColInner - 2 // -1 пробел слева, -1 пробел справа в строках данных

    const headerSeason = seasonLabel.padEnd(seasonColInner - 1) // ' Season 9' структура: 1 пробел + label, padded
    const seasonDashes = '─'.repeat(seasonColInner)

    logger.print(`\nРЕЗУЛЬТАТЫ МИНТА БЕЙДЖЕЙ ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН`)
    logger.print('='.repeat(80))

    // Заголовок таблицы
    logger.print(`┌──────┬─────────────────────────────────────────────────────────┬${seasonDashes}┬──────────────────┐`)
    logger.print(`│   #  │ Wallet Address                                          │ ${headerSeason}│ Mint Status      │`)
    logger.print(`├──────┼─────────────────────────────────────────────────────────┼${seasonDashes}┼──────────────────┤`)

    // Данные таблицы
    results.forEach((result) => {
      const walletNumber = result.walletNumber.toString().padStart(3) + ' '
      const address = result.address.length > 50 ? result.address.substring(0, 47) + '...' : result.address

      // Форматируем поинты с цветовой индикацией
      let points = 'N/A'.padStart(pointsWidth)
      if (result.seasonPoints !== null && result.seasonPoints !== undefined) {
        points = result.seasonPoints.toString().padStart(pointsWidth)
        if (result.seasonPoints >= 84) {
          points = `\x1b[32m${points}\x1b[0m` // Зеленый
        } else if (result.seasonPoints >= 80) {
          points = `\x1b[33m${points}\x1b[0m` // Желтый
        } else {
          points = `\x1b[31m${points}\x1b[0m` // Красный
        }
      }

      // Форматируем статус с цветовой индикацией
      let status = result.statusText.padEnd(16)
      if (result.mintStatus === 'minted' || result.mintStatus === 'already_has') {
        status = `\x1b[32m${status}\x1b[0m` // Зеленый
      } else if (result.mintStatus === 'skipped') {
        status = `\x1b[33m${status}\x1b[0m` // Желтый
      } else {
        status = `\x1b[31m${status}\x1b[0m` // Красный
      }

      logger.print(`│ ${walletNumber} │ ${address.padEnd(55)} │ ${points} │ ${status} │`)
    })

    logger.print(`└──────┴─────────────────────────────────────────────────────────┴${seasonDashes}┴──────────────────┘`)
  }

  /**
   * Экспортирует результаты минта бейджей в Excel файл
   */
  private async exportSeasonBadgeMintToExcel (results: SeasonBadgeMintTableRow[]): Promise<string> {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet(`Минт бейджей Season ${BADGE_MINT_CONFIG.season}`)

    // Настройка колонок
    worksheet.columns = [
      { header: '№', key: 'number', width: 5 },
      { header: 'Адрес кошелька', key: 'address', width: 45 },
      { header: `Сезон ${BADGE_MINT_CONFIG.season}`, key: 'seasonScore', width: 12 },
      { header: 'Статус минта', key: 'status', width: 18 },
      { header: 'TX Hash', key: 'txHash', width: 70 }
    ]

    // Форматирование заголовков
    const headerRow = worksheet.getRow(1)
    headerRow.font = { bold: true, size: 12 }
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' } // Светло-серый фон
    }
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
    headerRow.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    }

    // Добавление данных с цветовой индикацией
    results.forEach((result) => {
      const row = worksheet.addRow({
        number: result.walletNumber,
        address: result.address,
        seasonScore: result.seasonPoints !== null ? result.seasonPoints : 'N/A',
        status: result.statusText,
        txHash: result.transactionHash || ''
      })

      // Цветовая индикация для значения поинтов сезона
      const seasonScoreCell = row.getCell('seasonScore')
      if (result.seasonPoints !== null && result.seasonPoints !== undefined) {
        if (result.seasonPoints >= 84) {
          seasonScoreCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF90EE90' } // Светло-зеленый
          }
          seasonScoreCell.font = { bold: true }
        } else if (result.seasonPoints >= 80) {
          seasonScoreCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFFFE0' } // Светло-желтый
          }
          seasonScoreCell.font = { bold: true }
        } else {
          seasonScoreCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFB6C1' } // Светло-розовый/красный
          }
        }
        seasonScoreCell.alignment = { horizontal: 'center' }
      } else {
        seasonScoreCell.alignment = { horizontal: 'center' }
      }

      // Цветовая индикация для статуса
      const statusCell = row.getCell('status')
      if (result.mintStatus === 'minted' || result.mintStatus === 'already_has') {
        // Зеленый для заминченных
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF90EE90' } // Светло-зеленый
        }
        statusCell.font = { bold: true }
      } else if (result.mintStatus === 'skipped') {
        // Желтый для пропущенных
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFFFE0' } // Светло-желтый
        }
      } else {
        // Красный для ошибок
        statusCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFB6C1' } // Светло-розовый/красный
        }
      }
      statusCell.alignment = { horizontal: 'center' }

      // Выравнивание числовых значений
      const numberCell = row.getCell('number')
      numberCell.alignment = { horizontal: 'center' }
    })

    // Заморозка заголовка при прокрутке
    worksheet.views = [{
      state: 'frozen',
      ySplit: 1 // Заморозить первую строку
    }]

    // Создание папки exports если её нет
    const exportsDir = join(process.cwd(), 'exports')
    if (!existsSync(exportsDir)) {
      mkdirSync(exportsDir, { recursive: true })
    }

    // Генерация имени файла с датой и временем
    const now = new Date()
    const timestamp = now.toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, -5)
      .replace('T', '_')
    const fileName = `season${BADGE_MINT_CONFIG.season}_mint_${timestamp}.xlsx`
    const filePath = join(exportsDir, fileName)

    // Сохранение файла
    await workbook.xlsx.writeFile(filePath)

    return filePath
  }

  /**
   * Показывает статистику выполнения минта бейджей
   */
  private showSeasonBadgeMintStatistics (successCount: number, skippedCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    logger.print('\nФИНАЛЬНАЯ СТАТИСТИКА МИНТА БЕЙДЖЕЙ')
    logger.print('='.repeat(80))
    logger.print(`Всего кошельков: ${totalCount}`)
    logger.print(`Успешно заминчено: ${successCount}`)
    logger.print(`Пропущено: ${skippedCount}`)
    logger.print(`Ошибок: ${errorCount}`)
    logger.print(`Общее время: ${totalTime.toFixed(2)} секунд`)
    if (totalCount > 0) {
      logger.print(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    }
    logger.print('='.repeat(80))
    logger.print(`МИНТ БЕЙДЖЕЙ ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН ЗАВЕРШЕН!`)
    logger.print('='.repeat(80))
  }

}
