import { privateKeyToAccount } from 'viem/accounts'
import { TransactionChecker } from './modules/transaction-checker.js'
import { logger } from './logger.js'
import { sleep } from './backoff.js'
import { metrics } from './metrics.js'
import { GasChecker } from './gas-checker.js'
import { GM_IGNORE_POINTS_LIMIT } from './season-config.js'
import { filterUnderDailyCap, prioritizeWallets, hasReachedDailyCap as hasReachedDailyCapPure } from './wallet-selection.js'

// Импорт всех модулей
import { performArkadaCheckin } from './modules/arkada-checkin.js'
import { performLootcoinCheckin } from './modules/lootcoin.js'
import { performJumperSwap } from './modules/jumper.js'
import { performRevoke } from './modules/revoke.js'
import { performHarkan } from './modules/harkan.js'
import { performVelodrome } from './modules/velodrome.js'
import { performWowmax } from './modules/wowmax.js'
import { performCaptainCheckin } from './modules/captain-checkin.js'
import { performDiceOrDieCheckin } from './modules/diceordie-checkin.js'
import { performPocketKnightsCheckin } from './modules/pocketknights-checkin.js'
import { performAwakeningGuardians } from './modules/awakening-guardians.js'

// Интерфейс для результата выполнения модуля
interface ModuleResult {
  success: boolean
  walletAddress?: string
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean // Флаг пропуска кошелька (не ошибка)
  reason?: string // Причина пропуска
  // Дополнительные поля для конкретных модулей
  ethBalance?: string
  swapAmount?: string
  targetToken?: string
  usdcBalance?: string
  streak?: number
  blockNumber?: bigint
  message?: string
  [key: string]: unknown
}

// Типы для модулей
interface Module {
  name: string
  description: string
  execute: (privateKey: `0x${string}`) => Promise<ModuleResult>
}

// Интерфейс для задачи кошелька
interface WalletTask {
  walletIndex: number
  privateKey: `0x${string}`
  walletAddress: string
  assignedModule: Module
}

// Результат выполнения потока
interface ThreadResult {
  threadId: number
  success: boolean
  walletAddress: string
  moduleName: string
  executionTime: number
  transactionHash?: string | undefined
  explorerUrl?: string | null | undefined
  error?: string | undefined
}

/**
 * Класс для параллельного выполнения модулей
 */
export class ParallelExecutor {
  private transactionChecker: TransactionChecker | null = null
  private iteration: number = 1
  private moduleOffset: number = 0 // Смещение для циклического перебора модулей

  // Список кошельков для текущей итерации (isCompleted=true → только GM модуль)
  private currentIterationWallets: { privateKey: `0x${string}`, address: string, isCompleted: boolean }[] = []

  // Отслеживание ежедневных транзакций: address -> { date, count }
  private dailyTxTracker: Map<string, { date: string, count: number }> = new Map()

  /** Максимум транзакций на кошелёк в день. Выполнившие норму уступают поток отстающим. */
  private readonly MAX_TX_PER_WALLET_PER_DAY = 15

  // Кэш для приватных ключей - чтобы не запрашивать пароль каждый раз
  private cachedPrivateKeys: `0x${string}`[] | null = null

  // Предвыбранные кошельки для работы (если null - используется автоматический выбор)
  private preselectedWallets: { privateKey: `0x${string}`, address: string }[] | null = null

  // Исключенные модули (имена модулей, которые не будут использоваться)
  private excludedModules: string[] = []

  // Конфигурация для выбора кошельков
  private readonly WALLET_SELECTION_CONFIG = {
    maxCheckAttempts: 5,        // Максимум батчей для проверки (5 * threadCount кошельков)
    batchSizeMultiplier: 1,     // Множитель размера батча (1 = threadCount, 2 = 2*threadCount)
    minActiveWallets: 0         // Минимум активных кошельков для продолжения работы (0 = всегда продолжать)
  }

  // Список всех доступных модулей
  private readonly modules: Module[] = [
    {
      name: 'Arkada Check-in',
      description: 'Ежедневный check-in в Arkada',
      execute: performArkadaCheckin
    },
    {
      name: 'Lootcoin Check-in',
      description: 'Ежедневный check-in в Lootcoin',
      execute: performLootcoinCheckin
    },
    {
      name: 'Jumper',
      description: 'Свапы токенов через LI.FI',
      execute: performJumperSwap
    },
    {
      name: 'Revoke',
      description: 'Отзыв всех апрувов для кошелька',
      execute: performRevoke
    },
    {
      name: 'Harkan',
      description: 'Один спин в Harkan (cyber-roulette)',
      execute: performHarkan
    },
    {
      name: 'Velodrome',
      description: 'Свап ETH → USDC.e (0.1–1% от баланса) через Velodrome',
      execute: performVelodrome
    },
    {
      name: 'WOWMAX',
      description: 'Свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX',
      execute: performWowmax
    },
    {
      name: 'Captain Check-in',
      description: 'Ежедневный check-in в Captain',
      execute: performCaptainCheckin
    },
    {
      name: 'Dice or Die Check-in',
      description: 'Ежедневный check-in в Dice or Die',
      execute: performDiceOrDieCheckin
    },
    {
      name: 'Pocket Knights Check-in',
      description: 'Ежедневный check-in в Pocket Knights',
      execute: performPocketKnightsCheckin
    },
    {
      name: 'Awakening of Guardians',
      description: 'Покупка X2 Gold Reward (бонусный квест, лимит 5/5)',
      execute: performAwakeningGuardians
    }
  ]

  constructor (transactionChecker: TransactionChecker | null) {
    this.transactionChecker = transactionChecker
  }

  /**
   * Устанавливает предвыбранные кошельки для работы
   */
  setPreselectedWallets (wallets: { privateKey: `0x${string}`, address: string }[]): void {
    this.preselectedWallets = wallets
  }

  /**
   * Очищает предвыбранные кошельки
   */
  clearPreselectedWallets (): void {
    this.preselectedWallets = null
  }

  /**
   * Получает список активных (неисключенных) модулей
   */
  private getActiveModules (): Module[] {
    return this.modules.filter(module => !this.excludedModules.includes(module.name))
  }

  /**
   * Устанавливает список исключенных модулей
   */
  setExcludedModules (moduleNames: string[]): void {
    // Валидация: должен остаться хотя бы 1 активный модуль
    const wouldBeActive = this.modules.length - moduleNames.length
    if (wouldBeActive < 1) {
      throw new Error('Нельзя исключить все модули. Должен остаться хотя бы 1 активный модуль.')
    }

    // Фильтруем только существующие имена модулей
    const validModuleNames = this.modules.map(m => m.name)
    const filteredNames = moduleNames.filter(name => validModuleNames.includes(name))

    this.excludedModules = filteredNames
  }

  /**
   * Очищает список исключенных модулей
   */
  clearExcludedModules (): void {
    this.excludedModules = []
  }

  /**
   * Возвращает список исключенных модулей
   */
  getExcludedModules (): string[] {
    return [...this.excludedModules]
  }

  /**
   * Возвращает список всех доступных модулей
   */
  getAvailableModules (): Module[] {
    return [...this.modules]
  }

  /**
   * Возвращает количество транзакций кошелька за сегодня
   */
  private getTodayTxCount (address: string): number {
    const entry = this.dailyTxTracker.get(address)
    const today = new Date().toISOString().split('T')[0]!
    if (!entry || entry.date !== today) return 0
    return entry.count
  }

  /**
   * Проверяет, делал ли кошелек транзакцию сегодня
   */
  private hasTransactedToday (address: string): boolean {
    return this.getTodayTxCount(address) > 0
  }

  /**
   * Проверяет, достиг ли кошелёк дневного лимита транзакций
   */
  private hasReachedDailyCap (address: string): boolean {
    return hasReachedDailyCapPure(this.getTodayTxCount(address), this.MAX_TX_PER_WALLET_PER_DAY)
  }

  /**
   * Отмечает, что кошелек сделал транзакцию сегодня (инкремент счётчика)
   */
  private markTransactionToday (address: string): void {
    const today = new Date().toISOString().split('T')[0]!
    const entry = this.dailyTxTracker.get(address)
    if (!entry || entry.date !== today) {
      this.dailyTxTracker.set(address, { date: today, count: 1 })
    } else {
      entry.count++
    }
  }

  /**
   * Получает кошельки, которым нужен streak сегодня
   */
  private getWalletsNeedingStreakToday<T extends { address: string }> (wallets: T[]): T[] {
    return wallets.filter(w => !this.hasTransactedToday(w.address))
  }

  /**
   * Выбирает кошельки для текущей итерации с проверкой поинтов.
   *
   * Если GM_IGNORE_POINTS_LIMIT=true:
   *   — active-кошельки (score < 81) → isCompleted=false → обычная ротация модулей
   *   — completed-кошельки (score >= 81) → isCompleted=true → принудительно Startale GM
   *   — все вместе попадают в итерацию
   *
   * Если GM_IGNORE_POINTS_LIMIT=false:
   *   — старое поведение: completed-кошельки полностью исключаются
   */
  private async selectRandomWalletsForIteration (threadCount: number): Promise<void> {
    try {
      // Если есть предвыбранные кошельки, используем их (isCompleted=false — ручной режим)
      if (this.preselectedWallets && this.preselectedWallets.length > 0) {
        const actualThreadCount = Math.min(threadCount, this.preselectedWallets.length)
        const withFlag = this.preselectedWallets.map(w => ({ ...w, isCompleted: false }))

        const walletsNeedingStreak = this.getWalletsNeedingStreakToday(withFlag)

        if (walletsNeedingStreak.length > 0) {
          const priorityCount = Math.min(actualThreadCount, walletsNeedingStreak.length)
          this.currentIterationWallets = walletsNeedingStreak.slice(0, priorityCount)

          if (priorityCount < actualThreadCount) {
            const remaining = withFlag
              .filter(w => !walletsNeedingStreak.includes(w))
              .slice(0, actualThreadCount - priorityCount)
            this.currentIterationWallets.push(...remaining)
          }
        } else {
          this.currentIterationWallets = withFlag.slice(0, actualThreadCount)
        }
        return
      }

      // Автоматический выбор кошельков с приоритетом отстающих
      const allPrivateKeys = await this.getAllPrivateKeys()
      const allAddresses = allPrivateKeys.map(pk => privateKeyToAccount(pk).address)

      // Перемешиваем адреса чтобы каждую итерацию проверялись разные кошельки
      // (batch-checking выходит рано — без shuffle хвост массива никогда не проверится)
      const shuffled = this.shuffleArray(allAddresses)

      // Проверяем кошельки батчами до нахождения нужного количества
      const batchSize = threadCount * this.WALLET_SELECTION_CONFIG.batchSizeMultiplier
      const allActiveWallets: string[] = []
      const allCompletedWallets: string[] = []
      // Кэш score для сортировки по приоритету (отстающие первыми)
      const scoreMap = new Map<string, number>()
      let checkedCount = 0
      let attempt = 0

      // Определяем целевое количество: при GM_IGNORE_POINTS_LIMIT ищем active+completed
      const needTotal = GM_IGNORE_POINTS_LIMIT

      while (
        (needTotal
          ? (allActiveWallets.length + allCompletedWallets.length) < threadCount
          : allActiveWallets.length < threadCount) &&
        attempt < this.WALLET_SELECTION_CONFIG.maxCheckAttempts &&
        checkedCount < shuffled.length
      ) {
        attempt++
        const startIndex = checkedCount
        const endIndex = Math.min(startIndex + batchSize, shuffled.length)
        const walletsToCheck = shuffled.slice(startIndex, endIndex)

        if (walletsToCheck.length === 0) {
          break
        }

        const { activeWallets, completedWallets, walletScores } = await this.transactionChecker!.checkWallets(walletsToCheck)

        allActiveWallets.push(...activeWallets)
        allCompletedWallets.push(...completedWallets)
        for (const ws of walletScores) {
          scoreMap.set(ws.address, ws.score)
        }
        checkedCount += walletsToCheck.length
      }

      // Формируем финальный список с учётом флага
      type WalletEntry = { privateKey: `0x${string}`, address: string, isCompleted: boolean }
      const candidateWallets: WalletEntry[] = []

      // Добавляем active-кошельки
      for (const addr of allActiveWallets) {
        const pk = allPrivateKeys.find(k => privateKeyToAccount(k).address === addr)!
        candidateWallets.push({ privateKey: pk, address: addr, isCompleted: false })
      }

      // Добавляем completed-кошельки если GM_IGNORE_POINTS_LIMIT=true
      if (GM_IGNORE_POINTS_LIMIT && allCompletedWallets.length > 0) {
        for (const addr of allCompletedWallets) {
          const pk = allPrivateKeys.find(k => privateKeyToAccount(k).address === addr)!
          candidateWallets.push({ privateKey: pk, address: addr, isCompleted: true })
        }
      }

      if (candidateWallets.length === 0) {
        this.currentIterationWallets = []
        return
      }

      // Фильтруем кошельки, достигшие дневного лимита транзакций
      // (если лимита достигли все — helper вернёт исходный список как fallback)
      const pool = filterUnderDailyCap(
        candidateWallets,
        (address) => this.getTodayTxCount(address),
        this.MAX_TX_PER_WALLET_PER_DAY
      )

      // Сортировка по приоритету:
      // 1) Без транзакции сегодня (streak) — первыми
      // 2) По score — отстающие (меньший score) первыми
      const prioritized = prioritizeWallets(
        pool,
        (address) => this.hasTransactedToday(address),
        (address) => scoreMap.get(address) ?? 0
      )

      const actualThreadCount = Math.min(threadCount, prioritized.length)
      this.currentIterationWallets = prioritized.slice(0, actualThreadCount)

    } catch (error) {
      logger.error('Ошибка при выборе кошельков для итерации', error)
      // В случае ошибки используем случайные кошельки без проверки
      const allPrivateKeys = await this.getAllPrivateKeys()
      const randomKeys = allPrivateKeys.slice(0, threadCount)
      this.currentIterationWallets = randomKeys.map(key => ({
        privateKey: key,
        address: privateKeyToAccount(key).address,
        isCompleted: false
      }))
    }
  }

  /**
   * Выполнение уникальных действий для всех кошельков (одноразово)
   */
  async executeUniqueActions (maxConcurrent: number = 10): Promise<void> {
    try {
      const allWallets = await this.getAllWallets()

      // Распределяем модули между кошельками
      const walletTasks = this.distributeModulesToWallets(allWallets)

      // Показываем карту распределения
      this.showDistributionMap(walletTasks)

      // Выполняем задачи с ограничением потоков
      await this.executeTasksWithConcurrency(walletTasks, maxConcurrent)
    } catch (error) {
      logger.error('Ошибка в режиме уникальных действий', error)
      throw error
    }
  }

  /**
   * Основной метод - бесконечный цикл с параллельным выполнением
   */
  async executeInfiniteLoop (threadCount: number, gasChecker?: GasChecker): Promise<void> {
    try {
      // ИНИЦИАЛИЗИРУЕМ КЭШ КЛЮЧЕЙ ДО НАЧАЛА ЦИКЛА
      // Это гарантирует, что пароль будет запрошен только один раз в начале,
      // а не после долгого ожидания газа
      await this.getAllPrivateKeys()

      while (true) {
        try {
          if (gasChecker) {
            await this.checkGasPrice(gasChecker)
          }

          await this.executeIteration(threadCount)

          await sleep(5000)

          this.iteration++

        } catch (error) {
          logger.error(`Ошибка в итерации #${this.iteration}`, error)
          await sleep(1000)
          this.iteration++
        }
      }
    } catch (error) {
      logger.error('Критическая ошибка в бесконечном цикле', error)
      throw error
    }
  }

  /**
   * Выполнение одной итерации с параллельными потоками
   */
  private async executeIteration (threadCount: number): Promise<void> {
    const startTime = Date.now()

    // Проверяем, что есть хотя бы 1 активный модуль
    const activeModules = this.getActiveModules()
    if (activeModules.length === 0) {
      throw new Error('Нет доступных модулей для работы. Все модули исключены.')
    }

    // Выбираем случайные кошельки для текущей итерации
    await this.selectRandomWalletsForIteration(threadCount)

    if (this.currentIterationWallets.length === 0) {
      return
    }

    const actualThreadCount = Math.min(threadCount, this.currentIterationWallets.length)

    const threadPromises: Promise<ThreadResult>[] = []

    // Создаем промисы только для доступного количества кошельков
    for (let threadId = 1; threadId <= actualThreadCount; threadId++) {
      threadPromises.push(this.executeThread(threadId))
    }

    // Ждем завершения всех потоков
    const results = await Promise.allSettled(threadPromises)
    const endTime = Date.now()
    const totalTime = (endTime - startTime) / 1000

    // Обрабатываем результаты
    const threadResults: ThreadResult[] = []
    let successCount = 0
    let errorCount = 0

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        threadResults.push(result.value)
        if (result.value.success) {
          successCount++
        } else {
          errorCount++
        }
      } else {
        errorCount++
        threadResults.push({
          threadId: index + 1,
          success: false,
          walletAddress: 'unknown',
          moduleName: 'unknown',
          executionTime: 0,
          error: result.reason instanceof Error ? result.reason.message : 'Неизвестная ошибка'
        })
      }
    })

    // Показываем результаты итерации
    this.showIterationResults(threadResults, successCount, errorCount, totalTime)

    // Обновляем смещение для следующей итерации (циклический перебор модулей)
    if (activeModules.length > 0) {
      this.moduleOffset = (this.moduleOffset + threadCount) % activeModules.length
    }
  }

  /**
   * Выполнение одного потока в итерации
   */
  private async executeThread (threadId: number): Promise<ThreadResult> {
    const startTime = Date.now()

    try {
      // Получаем кошелек с приоритетом неактивных
      const { privateKey } = await this.selectWalletWithPriority()

      // Создаем account для получения адреса
      const account = privateKeyToAccount(privateKey)

      // Выбираем модуль обычной ротацией (GM раздаётся как любой другой модуль)
      const module = this.getUniqueModule(threadId)

      // Специальная обработка для Jumper модуля (rate limit protection)
      if (module.name === 'Jumper') {
        await sleep(2000) // 2 секунды задержки
      }

      // Выполняем модуль
      const result = await module.execute(privateKey)
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      // Отмечаем транзакцию после успешного выполнения
      if (result.success) {
        this.markTransactionToday(account.address)
      }

      // Если кошелек пропущен (skipped), это не ошибка
      const isSkipped = result.skipped === true
      const isSuccess = result.success || isSkipped

      metrics.moduleRun(module.name, account.address, isSuccess, endTime - startTime, {
        txHash: result.transactionHash,
        error: isSkipped ? undefined : result.error
      })

      return {
        threadId,
        success: isSuccess,
        walletAddress: account.address,
        moduleName: module.name,
        executionTime,
        transactionHash: result.transactionHash,
        explorerUrl: result.explorerUrl,
        error: isSkipped ? undefined : result.error
      }

    } catch (error) {
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      metrics.moduleRun('unknown', 'unknown', false, endTime - startTime, {
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      })

      return {
        threadId,
        success: false,
        walletAddress: 'unknown',
        moduleName: 'unknown',
        executionTime,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Выбирает кошелек из предварительно проверенного списка для текущей итерации.
   * Возвращает { privateKey, isCompleted } — isCompleted=true означает
   * что для этого кошелька нужно форсировать Startale GM.
   */
  private async selectWalletWithPriority (recursionDepth: number = 0): Promise<{ privateKey: `0x${string}`, isCompleted: boolean }> {
    try {
      if (recursionDepth > 5) {
        return { privateKey: await this.getRandomPrivateKey(), isCompleted: false }
      }

      if (this.currentIterationWallets.length === 0) {
        return { privateKey: await this.getRandomPrivateKey(), isCompleted: false }
      }

      // Циклический перебор: берём первый и удаляем из списка
      const selectedWallet = this.currentIterationWallets[0]!
      this.currentIterationWallets.shift()

      return { privateKey: selectedWallet.privateKey, isCompleted: selectedWallet.isCompleted }

    } catch (error) {
      logger.error('Ошибка при выборе кошелька', error)
      return { privateKey: await this.getRandomPrivateKey(), isCompleted: false }
    }
  }

  /**
   * Получает все доступные кошельки
   */
  private async getAllWallets (): Promise<`0x${string}`[]> {
    return await this.getAllPrivateKeys()
  }

  /**
   * Распределяет модули между кошельками
   */
  private distributeModulesToWallets (wallets: `0x${string}`[]): WalletTask[] {
    const tasks: WalletTask[] = []

    wallets.forEach((privateKey, index) => {
      const moduleIndex = index % this.modules.length
      const assignedModule = this.modules[moduleIndex]!
      const account = privateKeyToAccount(privateKey)

      tasks.push({
        walletIndex: index,
        privateKey,
        walletAddress: account.address,
        assignedModule
      })
    })

    return tasks
  }

  /**
   * Показывает карту распределения модулей
   */
  private showDistributionMap (_tasks: WalletTask[]): void {
    // Карта распределения - минималистичное логирование
  }

  /**
   * Выполняет задачи с ограничением параллельных потоков
   */
  private async executeTasksWithConcurrency (tasks: WalletTask[], maxConcurrent: number): Promise<void> {
    const results: ThreadResult[] = []
    const startTime = Date.now()

    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent)

      const batchPromises = batch.map((task, batchIndex) =>
        this.executeWalletTask(task, i + batchIndex + 1)
      )

      const batchResults = await Promise.allSettled(batchPromises)

      // Обрабатываем результаты батча
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          const task = batch[index]!
          results.push({
            threadId: i + index + 1,
            success: false,
            walletAddress: task.walletAddress,
            moduleName: task.assignedModule.name,
            executionTime: 0,
            error: result.reason instanceof Error ? result.reason.message : 'Неизвестная ошибка'
          })
        }
      })

      if (i + maxConcurrent < tasks.length) {
        await sleep(2000)
      }
    }

    const endTime = Date.now()
    const totalTime = (endTime - startTime) / 1000

    // Показываем финальные результаты
    this.showFinalResults(results, totalTime)
  }

  /**
   * Выполняет задачу одного кошелька
   */
  private async executeWalletTask (task: WalletTask, threadId: number): Promise<ThreadResult> {
    const startTime = Date.now()

    try {
      // Специальная обработка для Jumper модуля (rate limit protection)
      if (task.assignedModule.name === 'Jumper') {
        await sleep(2000) // 2 секунды задержки
      }

      // Выполняем модуль
      const result = await task.assignedModule.execute(task.privateKey)
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      // Если кошелек пропущен (skipped), это не ошибка
      const isSkipped = result.skipped === true
      const isSuccess = result.success || isSkipped

      return {
        threadId,
        success: isSuccess,
        walletAddress: task.walletAddress,
        moduleName: task.assignedModule.name,
        executionTime,
        transactionHash: result.transactionHash,
        explorerUrl: result.explorerUrl,
        error: isSkipped ? undefined : result.error
      }

    } catch (error) {
      const endTime = Date.now()
      const executionTime = (endTime - startTime) / 1000

      return {
        threadId,
        success: false,
        walletAddress: task.walletAddress,
        moduleName: task.assignedModule.name,
        executionTime,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      }
    }
  }

  /**
   * Показывает финальные результаты выполнения
   */
  private showFinalResults (results: ThreadResult[], totalTime: number): void {
    let successCount = 0
    let errorCount = 0

    results.forEach(result => {
      if (result.success) {
        successCount++
      } else {
        if (result.moduleName === 'Arkada Check-in' && result.error?.includes('Check недоступен')) {
          successCount++
        } else {
          errorCount++
        }
      }
    })

    logger.info(`Уникальные действия завершены | Успешно: ${successCount}, Ошибок: ${errorCount}, Время: ${totalTime.toFixed(2)}с`)
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
   * Выбирает случайный модуль для выполнения
   */
  private getRandomModule (): Module {
    const randomIndex = Math.floor(Math.random() * this.modules.length)
    const selectedModule = this.modules[randomIndex]!

    return selectedModule
  }

  /**
   * Выбирает уникальный модуль для потока с циклическим перебором
   */
  private getUniqueModule (threadId: number): Module {
    const activeModules = this.getActiveModules()

    // Проверка: должен быть хотя бы 1 активный модуль
    if (activeModules.length === 0) {
      throw new Error('Нет доступных модулей для работы. Все модули исключены.')
    }

    // Циклическое распределение с учетом смещения по итерациям
    const moduleIndex = (this.moduleOffset + threadId - 1) % activeModules.length
    const selectedModule = activeModules[moduleIndex]!

    return selectedModule
  }

  /**
   * Получает случайный приватный ключ
   */
  private async getRandomPrivateKey (): Promise<`0x${string}`> {
    try {
      const privateKeys = await this.getAllPrivateKeys()
      const randomIndex = Math.floor(Math.random() * privateKeys.length)
      const selectedKey = privateKeys[randomIndex]!
      return selectedKey
    } catch (error) {
      logger.error('Ошибка при получении приватного ключа', error)
      throw error
    }
  }

  /**
   * Получает все приватные ключи (зашифрованные или открытые) с кэшированием
   */
  private async getAllPrivateKeys (): Promise<`0x${string}`[]> {
    try {
      // Если ключи уже загружены, возвращаем из кэша
      if (this.cachedPrivateKeys !== null) {
        return this.cachedPrivateKeys
      }

      const { KeyEncryption } = await import('./key-encryption.js')

      // Работаем с зашифрованными или открытыми ключами
      let privateKeys: string[] = []

      if (KeyEncryption.hasEncryptedKeys()) {
        privateKeys = await KeyEncryption.promptPasswordWithRetry()
      } else if (KeyEncryption.hasPlainKeys()) {
        privateKeys = KeyEncryption.loadPlainKeys()
      } else {
        throw new Error('Не найдены ключи!')
      }

      this.cachedPrivateKeys = privateKeys as `0x${string}`[]

      return this.cachedPrivateKeys
    } catch (error) {
      logger.error('Ошибка при получении всех приватных ключей', error)
      throw error
    }
  }

  /**
   * Показывает результаты итерации
   */
  private showIterationResults (
    threadResults: ThreadResult[],
    successCount: number,
    errorCount: number,
    totalTime: number
  ): void {
    const modulesUsed = threadResults.map(r => r.moduleName)
    logger.iterationStart(modulesUsed)
    logger.iterationResult(successCount, errorCount, totalTime)
    metrics.iteration(errorCount === 0, totalTime * 1000, { successCount, errorCount })

    threadResults.forEach(result => {
      logger.threadResult(
        result.threadId,
        result.moduleName,
        result.walletAddress,
        result.success,
        result.executionTime,
        result.transactionHash,
        result.error
      )
    })
  }

  /**
   * Проверка цены газа в ETH mainnet
   */
  private async checkGasPrice (gasChecker: GasChecker): Promise<void> {
    try {
      if (await gasChecker.isGasPriceTooHigh()) {
        await gasChecker.waitForGasPriceToDrop()
      }
    } catch (error) {
      logger.error('Ошибка проверки газа', error)
    }
  }
}
