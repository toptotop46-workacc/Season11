import { logger } from './logger.js'

type CleanupFn = () => void | Promise<void>

/**
 * Centralized graceful-shutdown manager.
 *
 * Modules register cleanup callbacks via `onShutdown()`.
 * When `shutdown()` is called (or SIGINT/SIGTERM is received),
 * all callbacks are executed in LIFO order before the process exits.
 */
class ShutdownManager {
  private static instance: ShutdownManager
  private readonly cleanupFns: CleanupFn[] = []
  private shuttingDown = false

  private constructor () {
    process.on('SIGINT', () => this.shutdown(0, 'SIGINT (Ctrl+C)'))
    process.on('SIGTERM', () => this.shutdown(0, 'SIGTERM'))
    process.on('unhandledRejection', (error) => {
      logger.error('Необработанная ошибка', error instanceof Error ? error : undefined)
      this.shutdown(1, 'unhandledRejection')
    })
  }

  static getInstance (): ShutdownManager {
    if (!ShutdownManager.instance) {
      ShutdownManager.instance = new ShutdownManager()
    }
    return ShutdownManager.instance
  }

  /** Register a cleanup function that runs on shutdown (LIFO order). */
  onShutdown (fn: CleanupFn): void {
    this.cleanupFns.push(fn)
  }

  /** Trigger graceful shutdown. Safe to call multiple times. */
  async shutdown (code: number = 0, reason?: string): Promise<never> {
    if (this.shuttingDown) {
      // Already shutting down — force exit on second signal
      process.exit(code)
    }
    this.shuttingDown = true

    if (reason) {
      logger.info(`Завершение: ${reason}`)
    }
    logger.info('Остановка приложения...')

    // Run cleanups in reverse order (LIFO)
    for (let i = this.cleanupFns.length - 1; i >= 0; i--) {
      try {
        await this.cleanupFns[i]!()
      } catch (err) {
        logger.error('Ошибка при очистке', err instanceof Error ? err : undefined)
      }
    }

    logger.info('До свидания!')
    process.exit(code)
  }
}

export const shutdownManager = ShutdownManager.getInstance()
