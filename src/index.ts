import { setupEncoding } from './encoding-setup.js'
import { KeyEncryption } from './key-encryption.js'
import { TransactionChecker } from './modules/transaction-checker.js'
import { MenuSystem } from './menu-system.js'
import { ParallelExecutor } from './parallel-executor.js'
import { Banner } from './banner.js'
import { logger } from './logger.js'
import { shutdownManager } from './shutdown.js'
import { validateAndLogKeys } from './validators/key-validator.js'

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

    // Загружаем и валидируем ключи при старте
    let privateKeys: string[]
    if (KeyEncryption.hasEncryptedKeys()) {
      privateKeys = await KeyEncryption.promptPasswordWithRetry()
    } else {
      privateKeys = KeyEncryption.loadPlainKeys()
    }

    if (!validateAndLogKeys(privateKeys)) {
      logger.error('Исправьте невалидные ключи и перезапустите приложение.')
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
      await shutdownManager.shutdown(0, 'Неверный пароль')
    } else {
      logger.error('КРИТИЧЕСКАЯ ОШИБКА ПРИЛОЖЕНИЯ', error instanceof Error ? error : undefined)
      await shutdownManager.shutdown(1, 'Критическая ошибка')
    }
  }
}

// Запуск приложения (SIGINT/SIGTERM handled by shutdownManager)
main().catch(async (error) => {
  logger.error('Необработанная ошибка', error)
  await shutdownManager.shutdown(1, 'Необработанная ошибка')
})
