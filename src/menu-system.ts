import prompts from 'prompts'
import { privateKeyToAccount } from 'viem/accounts'
import { ParallelExecutor } from './parallel-executor.js'
import { logger } from './logger.js'
import { SoneiumCollector } from './modules/collector.js'
import { performWalletTopup } from './wallet-topup.js'
import { GasChecker } from './gas-checker.js'
import { ProxyManager } from './proxy-manager.js'
import { performSeasonBadgeMint } from './modules/season-badge-mint.js'
import { performStargateEthDeposit, performStargateEthWithdraw } from './modules/stargate-eth.js'
import axios from 'axios'
import ExcelJS from 'exceljs'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CURRENT_SEASON, POINTS_LIMIT_SEASON, BADGE_MINT_CONFIG } from './season-config.js'

/** Конфиг бонусных заданий текущего сезона: один столбец на каждое задание (season 10) */
const BONUS_QUEST_COLUMNS: Array<{ dappId: string, columns: Array<{ key: string, header: string }> }> = [
  { dappId: 'startale_10', columns: [{ key: 'startale_gm', header: 'Startale GM' }, { key: 'startale_invite', header: 'Startale Invite' }] },
  { dappId: 'burrowbash_10', columns: [{ key: 'burrowbash_play', header: 'Burrow Bash Play' }] },
  { dappId: 'morningmoon_10', columns: [{ key: 'morningmoon_plant', header: 'Morning Moon Plant' }] },
  { dappId: 'worldoftrinity_10', columns: [{ key: 'worldoftrinity_pack', header: 'WoT Starter Pack' }, { key: 'worldoftrinity_games', header: 'WoT Join 3' }] }
]

/** Плоский список всех бонусных колонок для таблицы и Excel */
const BONUS_QUEST_COLUMNS_FLAT = BONUS_QUEST_COLUMNS.flatMap(d => d.columns)

/** Дефолтное значение bonusQuests (все N/A) */
function getDefaultBonusQuests (): Record<string, string> {
  return Object.fromEntries(BONUS_QUEST_COLUMNS_FLAT.map(c => [c.key, 'N/A']))
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
    console.log('\n\nПолучен сигнал завершения (Ctrl+C)')
    console.log('Остановка приложения...')
    console.log('До свидания!')
    process.exit(0)
  }

  /**
   * Показывает главное меню
   */
  async showMainMenu (): Promise<void> {
    // Сбрасываем предвыбранные кошельки и исключенные модули при начале новой сессии
    this.parallelExecutor.clearPreselectedWallets()
    this.parallelExecutor.clearExcludedModules()
    try {
      const response = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

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
        console.log('\nДо свидания!')
        process.exit(0)
      } else {
        console.log('\nНеверный выбор. Попробуйте снова.')
        await this.showMainMenu()
      }
    } catch (error) {
      logger.error('Ошибка в главном меню', error)
      process.exit(1)
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

      console.log('\nЗАПУСК РАБОТЫ')
      console.log('='.repeat(80))
      console.log(`Введите количество потоков (1-${maxThreads}):`)
      console.log(`Если потоков > 1, каждый будет выполнять уникальный модуль (максимум ${maxThreads})`)

      const response = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!response || response['threadCount'] === undefined) {
        this.handleCancel()
        return
      }

      if (response['threadCount']) {
        console.log(`\nВыбрано ${response['threadCount']} потоков`)

        // Выбор режима работы с кошельками
        const walletModeResponse = await prompts({
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        if (!walletModeResponse || !walletModeResponse['walletMode']) {
          this.handleCancel()
          return
        }

        if (!walletModeResponse['walletMode']) {
          console.log('\nНеверный выбор. Попробуйте снова.')
          await this.showThreadSelectionMenu()
          return
        }

        let selectedWallets: { privateKey: `0x${string}`, address: string }[] | null = null

        if (walletModeResponse['walletMode'] === 'select') {
          // Показываем меню выбора кошельков
          selectedWallets = await this.showWalletSelectionMenu()
          if (!selectedWallets || selectedWallets.length === 0) {
            console.log('\nНе выбрано ни одного кошелька. Операция отменена.')
            await this.showMainMenu()
            return
          }
          console.log(`\nВыбрано ${selectedWallets.length} кошельков для работы`)
        }

        // Выбор модулей для работы
        const moduleSelectionResponse = await prompts({
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        if (!moduleSelectionResponse || moduleSelectionResponse['selectModules'] === undefined) {
          this.handleCancel()
          return
        }

        if (moduleSelectionResponse['selectModules'] === 'yes') {
          const selectedModules = await this.showModuleSelectionMenu()
          if (selectedModules === null || selectedModules.length === 0) {
            console.log('\nНе выбрано ни одного модуля. Операция отменена.')
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
            console.log(`\nВыбрано ${selectedModules.length} модулей для работы: ${selectedModules.join(', ')}`)
            if (excludedModules.length > 0) {
              console.log(`Исключено ${excludedModules.length} модулей: ${excludedModules.join(', ')}`)
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

        const gasResponse = await prompts({
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
          this.handleCancel()
          return
        }

        if (!gasResponse['maxGasPrice']) {
          console.log('\nНеверное значение газа. Попробуйте снова.')
          await this.showThreadSelectionMenu()
          return
        }

        const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
        console.log(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

        // Устанавливаем предвыбранные кошельки, если они были выбраны
        if (selectedWallets) {
          this.parallelExecutor.setPreselectedWallets(selectedWallets)
        } else {
          this.parallelExecutor.clearPreselectedWallets()
        }

        console.log('Запуск параллельного выполнения...')
        console.log('Для остановки нажмите Ctrl+C')
        console.log('='.repeat(80))

        // Запускаем параллельное выполнение с проверкой газа
        await this.parallelExecutor.executeInfiniteLoop(response['threadCount'], gasChecker)
      } else {
        console.log('\nНеверный выбор. Попробуйте снова.')
        await this.showThreadSelectionMenu()
      }
    } catch (error) {
      logger.error('Ошибка в меню выбора потоков', error)
      process.exit(1)
    }
  }

  /**
   * Показывает меню выбора кошельков для работы
   */
  private async showWalletSelectionMenu (): Promise<{ privateKey: `0x${string}`, address: string }[] | null> {
    try {
      console.log('\nВЫБОР КОШЕЛЬКОВ')
      console.log('='.repeat(80))

      const allPrivateKeys = await this.getAllPrivateKeys()

      if (allPrivateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
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
      const response = await prompts({
        type: 'multiselect',
        name: 'selectedAddresses',
        message: `Выберите кошельки для работы (найдено ${wallets.length}):`,
        choices: choices,
        hint: '- Пробел для выбора, Enter для подтверждения'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

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
      console.log('\nВЫБОР МОДУЛЕЙ ДЛЯ РАБОТЫ')
      console.log('='.repeat(80))

      const allModules = this.parallelExecutor.getAvailableModules()

      if (allModules.length === 0) {
        console.log('Не найдено модулей')
        return null
      }

      // Формируем выбор для prompts
      const choices = allModules.map((module) => ({
        title: module.name,
        value: module.name,
        description: module.description
      }))

      // Показываем меню выбора
      const response = await prompts({
        type: 'multiselect',
        name: 'selectedModules',
        message: `Выберите модули для работы (найдено ${allModules.length}):`,
        choices: choices,
        min: 1,
        hint: '- Пробел для выбора, Enter для подтверждения'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

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
      console.log('\nСБОР БАЛАНСОВ В ETH')
      console.log('='.repeat(80))

      // Запрос максимальной цены газа
      const gasResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        console.log('\nНеверное значение газа. Попробуйте снова.')
        await this.showMainMenu()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      console.log(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)

      console.log(`Найдено ${shuffledKeys.length} кошельков`)
      console.log('Начинаем сбор...')
      console.log('Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

      // Выполняем collector для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        console.log(`\nКОШЕЛЕК ${i + 1}/${shuffledKeys.length}:`)
        console.log('-'.repeat(50))
        console.log(`Адрес: ${account.address}`)

        try {
          console.log('Проверяем цену газа...')
          await gasChecker.waitForGasPriceToDrop()

          const collector = new SoneiumCollector(privateKey)
          const result = await collector.performCollection()

          if (result.success) {
            successCount++
            console.log(`Успешно собрано: ${result.totalCollected} ETH`)
            console.log(`Собрано токенов: ${result.collectedTokens.length}`)
            console.log(`Найдена ликвидность в: ${result.liquidityFound.length} протоколах`)
            console.log(`Выведена ликвидность из: ${result.withdrawnLiquidity.length} протоколов`)
          } else {
            errorCount++
            console.log(`Ошибка: ${result.error}`)
          }
        } catch (error) {
          errorCount++
          console.log(`Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        if (i < shuffledKeys.length - 1) {
          console.log('Пауза 3 секунды...')
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showCollectorStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при сборе балансов', error)
      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
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
        console.log('Получаем все приватные ключи из зашифрованного хранилища...')
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else if (KeyEncryption.hasPlainKeys()) {
        console.log('Получаем все приватные ключи из keys.txt...')
        privateKeys = KeyEncryption.loadPlainKeys()
      } else {
        throw new Error('Не найдены ключи!')
      }

      this.cachedPrivateKeys = privateKeys as `0x${string}`[]
      console.log(`Загружено ${this.cachedPrivateKeys.length} приватных ключей`)

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
    timeout: 10000,            // Timeout в мс
    retryAttempts: 10,         // Попытки повтора
    pointsLimit: POINTS_LIMIT_SEASON,  // Лимит поинтов для статуса 'done' (из season-config)
    baseUrl: 'https://portal.soneium.org/api'
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

      // Задержка между попытками для избежания рейт-лимита
      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
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

      // Задержка между попытками для избежания рейт-лимита
      if (attempt < this.STATS_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
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
      console.log('\nСТАТИСТИКА ПО КОШЕЛЬКАМ')
      console.log('='.repeat(80))
      console.log('Получаем актуальные данные через API с прокси...')

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const addresses = privateKeys.map(pk => privateKeyToAccount(pk).address)

      console.log(`Проверяем ${addresses.length} кошельков...`)

      // Счетчик для прогресс-бара
      let completedCount = 0
      const totalCount = addresses.length

      // Функция для обновления прогресс-бара
      const updateProgress = () => {
        const percentage = Math.round((completedCount / totalCount) * 100)
        process.stdout.write(`\rПроверка кошельков: [${completedCount}/${totalCount}] ${percentage}%`)
      }

      // Обрабатываем кошельки батчами для избежания рейт-лимита
      const BATCH_SIZE = 50 // Размер батча
      const BATCH_DELAY = 100 // Задержка между батчами в мс
      const results: WalletStatisticsResult[] = []

      for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch = addresses.slice(i, i + BATCH_SIZE)

        // Обрабатываем батч параллельно
        const batchResults = await Promise.all(
          batch.map(async (address, batchIndex) => {
            const originalIndex = i + batchIndex // Исходный индекс кошелька в массиве addresses
            try {
              // Параллельно получаем данные из обоих API
              const [walletData, bonusData] = await Promise.all([
                this.fetchWalletDataWithRetry(address),
                this.fetchBonusDappDataWithRetry(address)
              ])

              // Обработка данных о поинтах (текущий сезон)
              let seasonScore = 0
              let status: 'done' | 'not_done' | 'error' = 'error'

              if (!Array.isArray(walletData) && walletData.error) {
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

              let bonusQuests: Record<string, string> = getDefaultBonusQuests()

              if (Array.isArray(bonusData) && bonusData.length > 0) {
                bonusQuests = this.parseBonusQuests(bonusData)
              } else if (!Array.isArray(bonusData) && bonusData.error) {
                // Ошибка при получении bonus-dapp данных, оставляем N/A
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
        )

        results.push(...batchResults)

        // Задержка между батчами (кроме последнего)
        if (i + BATCH_SIZE < addresses.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY))
        }
      }

      // Завершаем прогресс-бар
      console.log('\n')

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
      console.log(topLine)
      console.log('│' + headerCells.map((c, i) => padToVisible(c, colWidths[i]!)).join('│') + '│')
      console.log(midLine)

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
        console.log('│' + rowCells.map((c, i) => padToVisible(c, colWidths[i]!)).join('│') + '│')
      })

      console.log(botLine)

      console.log('='.repeat(80))

      // Предложение экспорта в Excel
      const exportResponse = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Экспортировать статистику в Excel файл?',
        initial: true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!exportResponse) {
        this.handleCancel()
        return
      }

      if (exportResponse['value']) {
        try {
          console.log('\nСоздание Excel файла...')
          const filePath = await this.exportStatisticsToExcel(results)
          console.log('\nСтатистика успешно экспортирована!')
          console.log(`Путь к файлу: ${filePath}`)
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
    console.log('\nФИНАЛЬНАЯ СТАТИСТИКА СБОРА')
    console.log('='.repeat(80))
    console.log(`Всего кошельков: ${totalCount}`)
    console.log(`Успешно обработано: ${successCount}`)
    console.log(`Ошибок: ${errorCount}`)
    console.log(`Общее время: ${totalTime.toFixed(2)} секунд`)
    console.log(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    console.log('='.repeat(80))
    console.log('СБОР ЗАВЕРШЕН!')
    console.log('='.repeat(80))
  }

  /**
   * Показывает меню пополнения кошельков
   */
  private async showTopupMenu (): Promise<void> {
    try {
      console.log('\nПОПОЛНЕНИЕ КОШЕЛЬКОВ ETH В СЕТИ SONEIUM')
      console.log('='.repeat(80))

      // 1. Минимальная сумма
      const minAmount = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную сумму пополнения (USD):',
        initial: 10,
        min: 1,
        validate: (value: number) => value > 0 ? true : 'Сумма должна быть больше 0'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!minAmount || minAmount['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 2. Максимальная сумма
      const maxAmount = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную сумму пополнения (USD):',
        initial: 50,
        min: minAmount['value'],
        validate: (value: number) => value >= minAmount['value'] ? true : 'Максимальная сумма должна быть больше или равна минимальной'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!maxAmount || maxAmount['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 3. Минимальная задержка
      const minDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную задержку между кошельками (минуты):',
        initial: 2,
        min: 1,
        validate: (value: number) => value >= 1 ? true : 'Задержка должна быть не менее 1 минуты'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!minDelay || minDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 4. Максимальная задержка
      const maxDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную задержку между кошельками (минуты):',
        initial: 5,
        min: minDelay['value'],
        validate: (value: number) => value >= minDelay['value'] ? true : 'Максимальная задержка должна быть больше или равна минимальной'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!maxDelay || maxDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // 5. Запрос максимальной цены газа
      const gasResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        console.log('\nНеверное значение газа. Попробуйте снова.')
        await this.showTopupMenu()
        return
      }

      console.log('\nНастройки пополнения:')
      console.log(`Сумма: $${minAmount['value']} - $${maxAmount['value']}`)
      console.log(`Задержки: ${minDelay['value']} - ${maxDelay['value']} минут`)
      console.log(`Лимит газа: ${gasResponse['maxGasPrice']} Gwei`)
      console.log('='.repeat(80))

      const confirm = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Запустить пополнение с этими настройками?',
        initial: true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!confirm) {
        this.handleCancel()
        return
      }

      if (confirm['value']) {
        const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
        console.log(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

        await this.executeTopupForAllWallets(minAmount['value'], maxAmount['value'], minDelay['value'], maxDelay['value'], gasChecker)
      } else {
        console.log('Пополнение отменено')
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
      console.log('\nЗАПУСК ПОПОЛНЕНИЯ КОШЕЛЬКОВ')
      console.log('='.repeat(80))

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)

      console.log(`Найдено ${shuffledKeys.length} кошельков`)
      console.log('Начинаем пополнение...')
      console.log('Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

      // Выполняем пополнение для каждого кошелька
      let successCount = 0
      let errorCount = 0
      const startTime = Date.now()

      for (let i = 0; i < shuffledKeys.length; i++) {
        const privateKey = shuffledKeys[i]!
        const account = privateKeyToAccount(privateKey)

        console.log(`\nПОПОЛНЕНИЕ КОШЕЛЬКА ${i + 1}/${shuffledKeys.length}:`)
        console.log('-'.repeat(50))
        console.log(`Адрес: ${account.address}`)

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
            console.log('Пополнение выполнено успешно!')
            console.log(`Сумма: $${result.amountUSD.toFixed(2)} (${result.amountETH} ETH)`)
            if (result.mexcWithdrawId) {
              console.log(`MEXC ID: ${result.mexcWithdrawId}`)
            }
            if (result.bridgeTxHash) {
              console.log(`Bridge TX: ${result.bridgeTxHash}`)
            }
          } else {
            throw new Error(result.error || 'Неизвестная ошибка пополнения')
          }

        } catch (error) {
          errorCount++
          console.log(`Ошибка пополнения: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
        }

        // Задержка между кошельками (кроме последнего)
        if (i < shuffledKeys.length - 1) {
          const delayMinutes = Math.random() * (maxDelay - minDelay) + minDelay
          const delayMs = delayMinutes * 60 * 1000

          console.log(`Пауза ${delayMinutes.toFixed(2)} минут (${Math.round(delayMs / 1000)} секунд) до следующего кошелька...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showTopupStatistics(successCount, errorCount, shuffledKeys.length, totalTime)

      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при пополнении кошельков', error)
      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()
    }
  }

  /**
   * Показывает статистику выполнения пополнения
   */
  private showTopupStatistics (successCount: number, errorCount: number, totalCount: number, totalTime: number): void {
    console.log('\nФИНАЛЬНАЯ СТАТИСТИКА ПОПОЛНЕНИЯ')
    console.log('='.repeat(80))
    console.log(`Всего кошельков: ${totalCount}`)
    console.log(`Успешно пополнено: ${successCount}`)
    console.log(`Ошибок: ${errorCount}`)
    console.log(`Общее время: ${totalTime.toFixed(2)} секунд`)
    console.log(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    console.log('='.repeat(80))
    console.log('ПОПОЛНЕНИЕ ЗАВЕРШЕНО!')
    console.log('='.repeat(80))
  }

  /**
   * Показывает меню Ликвидность Stargate (ETH)
   */
  private async showStargateEthMenu (): Promise<void> {
    try {
      console.log('\nЛИКВИДНОСТЬ STARGATE (ETH)')
      console.log('='.repeat(80))

      const actionResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!actionResponse || !actionResponse['action']) {
        this.handleCancel()
        return
      }

      const operation = actionResponse['action'] as 'deposit' | 'withdraw'

      const gasResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      console.log(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      const delayMinResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!delayMinResponse || delayMinResponse['delayMinSec'] === undefined) {
        this.handleCancel()
        return
      }

      const delayMaxResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!delayMaxResponse || delayMaxResponse['delayMaxSec'] === undefined) {
        this.handleCancel()
        return
      }

      const delayMinSec = Math.floor(delayMinResponse['delayMinSec'])
      const delayMaxSec = Math.floor(delayMaxResponse['delayMaxSec'])
      if (delayMinSec < 1 || delayMaxSec < delayMinSec) {
        console.log('Некорректный диапазон паузы. Возврат в главное меню.')
        await this.showMainMenu()
        return
      }
      console.log(`Пауза между кошельками: случайно от ${delayMinSec} до ${delayMaxSec} сек`)

      const privateKeys = await this.getAllPrivateKeys()
      if (privateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const shuffledKeys = this.shuffleArray(privateKeys)
      const opLabel = operation === 'deposit' ? 'ДЕПОЗИТ' : 'ВЫВОД'
      console.log(`\n${opLabel} для ${shuffledKeys.length} кошельков`)
      console.log('Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

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

          console.log(`\n${batchLabel} ${i + 1}/${keys.length}:`)
          console.log('-'.repeat(50))
          console.log(`Адрес: ${account.address}`)

          try {
            console.log('Проверяем цену газа...')
            await gasChecker.waitForGasPriceToDrop()

            const result = operation === 'deposit'
              ? await performStargateEthDeposit(privateKey)
              : await performStargateEthWithdraw(privateKey)

            if (result.skipped) {
              skippedCount++
              console.log(`Пропущен: ${result.reason}`)
            } else if (result.success) {
              successCount++
              // Убираем из списка упавших если он там был (retry)
              const failedIdx = failedKeys.indexOf(privateKey)
              if (failedIdx !== -1) failedKeys.splice(failedIdx, 1)
              if (operation === 'deposit' && 'depositAmount' in result) {
                console.log(`Депозит: ${result.depositAmount} ETH`)
              } else if (operation === 'withdraw' && 'lpAmount' in result) {
                console.log(`Выведено LP: ${result.lpAmount} S*ETH`)
              }
              if (result.transactionHash) {
                console.log(`TX: ${result.transactionHash}`)
                console.log(`Explorer: ${result.explorerUrl}`)
              }
            } else {
              errorCount++
              console.log(`Ошибка: ${result.error}`)
              if (!failedKeys.includes(privateKey)) failedKeys.push(privateKey)
            }
          } catch (error) {
            errorCount++
            console.log(`Критическая ошибка: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
            if (!failedKeys.includes(privateKey)) failedKeys.push(privateKey)
          }

          if (i < keys.length - 1) {
            const pauseSec = delayMinSec + Math.floor(Math.random() * (delayMaxSec - delayMinSec + 1))
            console.log(`Пауза ${pauseSec} секунд...`)
            await new Promise(resolve => setTimeout(resolve, pauseSec * 1000))
          }
        }
      }

      await runBatch(shuffledKeys, 'КОШЕЛЕК')

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log('\n' + '='.repeat(80))
      console.log(`ИТОГО: Успешно: ${successCount} | Пропущено: ${skippedCount} | Ошибок: ${errorCount}`)
      console.log(`Время выполнения: ${totalTime} сек`)

      // Retry для упавших кошельков
      while (failedKeys.length > 0) {
        console.log(`\n⚠️  Упали ${failedKeys.length} кошелек(ов). Повторить попытку?`)
        const retryResponse = await prompts({
          type: 'confirm',
          name: 'retry',
          message: `Запустить повтор для ${failedKeys.length} упавших кошельков?`,
          initial: true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        if (!retryResponse || !retryResponse['retry']) break

        const retryKeys = [...failedKeys]
        failedKeys.length = 0
        errorCount = 0
        console.log(`\nПОВТОР для ${retryKeys.length} кошельков...`)
        console.log('='.repeat(80))
        await runBatch(retryKeys, 'ПОВТОР')

        console.log('\n' + '='.repeat(80))
        console.log(`После повтора — Успешно: ${successCount} | Пропущено: ${skippedCount} | Ошибок: ${failedKeys.length}`)
      }

      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка в меню Stargate ETH', error)
      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()
    }
  }

  /**
   * Показывает меню минта бейджа за 8 сезон
   */
  private async showSeasonBadgeMintMenu (): Promise<void> {
    try {
      console.log(`\nМИНТ БЕЙДЖА ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН`)
      console.log('='.repeat(80))

      // Запрос максимальной цены газа
      const gasResponse = await prompts({
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!gasResponse || gasResponse['maxGasPrice'] === undefined) {
        this.handleCancel()
        return
      }

      if (!gasResponse['maxGasPrice']) {
        console.log('\nНеверное значение газа. Попробуйте снова.')
        await this.showMainMenu()
        return
      }

      const gasChecker = new GasChecker(gasResponse['maxGasPrice'])
      console.log(`Лимит газа установлен: ${gasResponse['maxGasPrice']} Gwei`)

      // Запрос минимальной задержки
      const minDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите минимальную задержку между минтами (минуты):',
        initial: 2,
        min: 1,
        validate: (value: number) => value >= 1 ? true : 'Задержка должна быть не менее 1 минуты'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!minDelay || minDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      // Запрос максимальной задержки
      const maxDelay = await prompts({
        type: 'number',
        name: 'value',
        message: 'Введите максимальную задержку между минтами (минуты):',
        initial: 5,
        min: minDelay['value'],
        validate: (value: number) => value >= minDelay['value'] ? true : 'Максимальная задержка должна быть больше или равна минимальной'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!maxDelay || maxDelay['value'] === undefined) {
        this.handleCancel()
        return
      }

      console.log(`Задержки между минтами: ${minDelay['value']} - ${maxDelay['value']} минут`)
      console.log('Задержка применяется только после успешного минта')

      // Получаем все приватные ключи
      const privateKeys = await this.getAllPrivateKeys()

      if (privateKeys.length === 0) {
        console.log('Не найдено приватных ключей')
        await this.showMainMenu()
        return
      }

      const keysWithIndex = privateKeys.map((key, index) => ({
        originalIndex: index,
        privateKey: key
      }))

      console.log(`Найдено ${keysWithIndex.length} кошельков`)
      console.log('Начинаем проверку и минт...')
      console.log('Для остановки нажмите Ctrl+C')
      console.log('='.repeat(80))

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

        console.log(`\nКОШЕЛЕК ${i + 1}/${keysWithIndex.length}:`)
        console.log('-'.repeat(50))
        console.log(`Адрес: ${account.address}`)

        try {
          console.log('Проверяем цену газа...')
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
              console.log(`Пропущен: ${result.reason || 'Не указана причина'}`)
            } else {
              successCount++
              previousMintSuccessful = true // Устанавливаем флаг успешного минта
              mintStatus = 'minted'
              statusText = 'Minted'
              console.log('Минт выполнен успешно!')
              if (result.transactionHash) {
                console.log(`TX Hash: ${result.transactionHash}`)
                if (result.explorerUrl) {
                  console.log(`Explorer: ${result.explorerUrl}`)
                }
              }
            }
          } else {
            errorCount++
            mintStatus = 'error'
            statusText = 'Ошибка'
            console.log(`Ошибка: ${result.error || 'Неизвестная ошибка'}`)
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
          console.log(`Критическая ошибка: ${errorMessage}`)

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

          console.log(`Задержка ${delayMinutes.toFixed(2)} минут (${Math.round(delayMs / 1000)} секунд) до следующего кошелька...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        } else if (i < keysWithIndex.length - 1) {
          console.log('Пауза 3 секунды...')
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }

      // Сортируем результаты по оригинальному номеру кошелька из keys.txt
      results.sort((a, b) => a.walletNumber - b.walletNumber)

      // Показываем таблицу результатов
      this.showSeasonBadgeMintTable(results)

      // Предложение экспорта в Excel
      const exportResponse = await prompts({
        type: 'confirm',
        name: 'value',
        message: 'Экспортировать результаты минта в Excel файл?',
        initial: true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      if (!exportResponse) {
        this.handleCancel()
        return
      }

      if (exportResponse['value']) {
        try {
          console.log('\nСоздание Excel файла...')
          const filePath = await this.exportSeasonBadgeMintToExcel(results)
          console.log('\nРезультаты успешно экспортированы!')
          console.log(`Путь к файлу: ${filePath}`)
        } catch (error) {
          logger.error('Ошибка при экспорте в Excel', error)
        }
      }

      // Показываем финальную статистику
      const endTime = Date.now()
      const totalTime = (endTime - startTime) / 1000
      this.showSeasonBadgeMintStatistics(successCount, skippedCount, errorCount, keysWithIndex.length, totalTime)

      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
      await this.showMainMenu()

    } catch (error) {
      logger.error('Ошибка при минте бейджей', error)
      console.log('\nВозврат в главное меню через 5 секунд...')
      await new Promise(resolve => setTimeout(resolve, 5000))
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

    console.log(`\nРЕЗУЛЬТАТЫ МИНТА БЕЙДЖЕЙ ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН`)
    console.log('='.repeat(80))

    // Заголовок таблицы
    console.log(`┌──────┬─────────────────────────────────────────────────────────┬${seasonDashes}┬──────────────────┐`)
    console.log(`│   #  │ Wallet Address                                          │ ${headerSeason}│ Mint Status      │`)
    console.log(`├──────┼─────────────────────────────────────────────────────────┼${seasonDashes}┼──────────────────┤`)

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

      console.log(`│ ${walletNumber} │ ${address.padEnd(55)} │ ${points} │ ${status} │`)
    })

    console.log(`└──────┴─────────────────────────────────────────────────────────┴${seasonDashes}┴──────────────────┘`)
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
    console.log('\nФИНАЛЬНАЯ СТАТИСТИКА МИНТА БЕЙДЖЕЙ')
    console.log('='.repeat(80))
    console.log(`Всего кошельков: ${totalCount}`)
    console.log(`Успешно заминчено: ${successCount}`)
    console.log(`Пропущено: ${skippedCount}`)
    console.log(`Ошибок: ${errorCount}`)
    console.log(`Общее время: ${totalTime.toFixed(2)} секунд`)
    if (totalCount > 0) {
      console.log(`Процент успеха: ${((successCount / totalCount) * 100).toFixed(1)}%`)
    }
    console.log('='.repeat(80))
    console.log(`МИНТ БЕЙДЖЕЙ ЗА ${BADGE_MINT_CONFIG.season} СЕЗОН ЗАВЕРШЕН!`)
    console.log('='.repeat(80))
  }

}
