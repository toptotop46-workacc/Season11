import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { TransactionChecker } from './modules/transaction-checker.js'
import { MenuSystem } from './menu-system.js'
import { ParallelExecutor } from './parallel-executor.js'
import { Banner } from './banner.js'
import { logger } from './logger.js'

// Глобальные экземпляры систем
let transactionChecker: TransactionChecker | null = null

/**
 * Основная функция приложения
 */
async function main (): Promise<void> {
  try {
    // Настройка кодировки для корректного отображения кириллицы
    setupEncoding()

    // Показываем заставку
    Banner.show()

    // Проверяем и предлагаем шифрование ключей
    const shouldExit = await KeyEncryption.checkAndOfferEncryption()
    if (shouldExit) {
      logger.info('До свидания!')
      return
    }

    // Проверяем наличие ключей (зашифрованных или открытых)
    if (!KeyEncryption.hasEncryptedKeys() && !KeyEncryption.hasPlainKeys()) {
      logger.error('Не найдены ключи!')
      logger.info('Создайте файл keys.txt с приватными ключами и перезапустите приложение.')
      return
    }

    // Инициализируем checker для индивидуальных проверок
    transactionChecker = new TransactionChecker()

    // Создаем экземпляр параллельного исполнителя
    const parallelExecutor = new ParallelExecutor(transactionChecker)

    // Создаем экземпляр системы меню
    const menuSystem = new MenuSystem(parallelExecutor)

    // Запускаем главное меню
    await menuSystem.showMainMenu()

  } catch (error) {
    if (error instanceof Error && error.message === 'WRONG_PASSWORD') {
      logger.info('До свидания!')
      process.exit(0)
    } else {
      logger.error('КРИТИЧЕСКАЯ ОШИБКА ПРИЛОЖЕНИЯ', error instanceof Error ? error : undefined)
      process.exit(1)
    }
  }
}

// Обработка сигналов завершения
process.on('SIGINT', () => {
  logger.info('Получен сигнал завершения (Ctrl+C)')
  logger.info('Остановка приложения...')
  logger.info('До свидания!')
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('Получен сигнал завершения (SIGTERM)')
  logger.info('Остановка приложения...')
  logger.info('До свидания!')
  process.exit(0)
})

// Запуск приложения
main().catch((error) => {
  logger.error('Необработанная ошибка', error)
  process.exit(1)
})
