import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Простой класс для записи логов в файлы
 * Записывает успешные операции в successful.txt, неудачные в failed.txt
 */
export class FileLogger {
  private static instance: FileLogger
  private logsDir: string

  private constructor () {
    this.logsDir = join(process.cwd(), 'logs')
    this.ensureLogsDirectory()
  }

  static getInstance (): FileLogger {
    if (!FileLogger.instance) {
      FileLogger.instance = new FileLogger()
    }
    return FileLogger.instance
  }

  private ensureLogsDirectory (): void {
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }

  private formatTimestamp (): string {
    return new Date().toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  private formatLogEntry (module: string, operation: string, details: string): string {
    const timestamp = this.formatTimestamp()
    return `[${timestamp}] [${module}] [${operation}] ${details}\n`
  }

  /**
   * Записывает успешную операцию в successful.txt
   */
  logSuccess (module: string, operation: string, details: string): void {
    this.ensureLogsDirectory()
    const logEntry = this.formatLogEntry(module, operation, details)
    const filePath = join(this.logsDir, 'successful.txt')
    appendFileSync(filePath, logEntry, 'utf8')
  }

  /**
   * Записывает неудачную операцию в failed.txt
   */
  logFailed (module: string, operation: string, details: string): void {
    this.ensureLogsDirectory()
    const logEntry = this.formatLogEntry(module, operation, details)
    const filePath = join(this.logsDir, 'failed.txt')
    appendFileSync(filePath, logEntry, 'utf8')
  }

  /**
   * Записывает транзакцию (успешную или неудачную)
   */
  logTransaction (hash: string, success: boolean, module: string, details: string): void {
    const operation = success ? 'TX_SUCCESS' : 'TX_FAILED'
    // Используем details как есть, если они содержат адрес и ссылку
    // Иначе создаем ссылку из хэша
    const txDetails = details.includes(' - ') ? details : `https://soneium.blockscout.com/tx/${hash}`

    if (success) {
      this.logSuccess(module, operation, txDetails)
    } else {
      this.logFailed(module, operation, txDetails)
    }
  }

  /**
   * Записывает результат модуля
   */
  logModuleResult (moduleName: string, success: boolean, executionTime: number, details?: string): void {
    const operation = success ? 'MODULE_SUCCESS' : 'MODULE_FAILED'
    const timeInfo = `Время: ${executionTime.toFixed(2)}с`
    const fullDetails = details ? `${details} | ${timeInfo}` : timeInfo

    if (success) {
      this.logSuccess(moduleName, operation, fullDetails)
    } else {
      this.logFailed(moduleName, operation, fullDetails)
    }
  }

  /**
   * Записывает пополнение кошелька
   */
  logWalletTopup (success: boolean, walletAddress: string, amount: string, strategy: string, details?: string): void {
    const operation = success ? 'TOPUP_SUCCESS' : 'TOPUP_FAILED'
    const addr = walletAddress.slice(0, 8) + '...'
    const topupDetails = `Кошелек: ${addr} | Сумма: ${amount} | Стратегия: ${strategy}${details ? ` | ${details}` : ''}`

    if (success) {
      this.logSuccess('WALLET_TOPUP', operation, topupDetails)
    } else {
      this.logFailed('WALLET_TOPUP', operation, topupDetails)
    }
  }

  /**
   * Записывает bridge операцию
   */
  logBridge (success: boolean, fromNetwork: string, toNetwork: string, amount: string, txHash?: string, error?: string): void {
    const operation = success ? 'BRIDGE_SUCCESS' : 'BRIDGE_FAILED'
    const bridgeDetails = `${fromNetwork} → ${toNetwork} | Сумма: ${amount}${txHash ? ` | TX: ${txHash}` : ''}${error ? ` | Ошибка: ${error}` : ''}`

    if (success) {
      this.logSuccess('BRIDGE', operation, bridgeDetails)
    } else {
      this.logFailed('BRIDGE', operation, bridgeDetails)
    }
  }
}

// Экспорт для удобства
export const fileLogger = FileLogger.getInstance()
