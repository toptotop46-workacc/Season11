import { fileLogger } from './file-logger.js'

// ANSI-коды цветов для терминала
const RESET = '\x1b[0m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const GRAY = '\x1b[90m'

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

export class Logger {
  private static instance: Logger
  private level: LogLevel = LogLevel.INFO

  private constructor () {}

  static getInstance (): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger()
    }
    return Logger.instance
  }

  setLevel (level: LogLevel): void {
    this.level = level
  }

  private formatTimestamp (): string {
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }

  private fmt (level: string, message: string, color: string): string {
    return `${color}${this.formatTimestamp()} | ${level.padEnd(5)} | ${message}${RESET}`
  }

  error (message: string, error?: unknown): void {
    if (this.level >= LogLevel.ERROR) {
      const rawDetail = error instanceof Error ? error.message : error != null ? String(error) : ''
      const firstLine = rawDetail.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
      const errorDetail = firstLine ? `: ${firstLine}` : ''
      const fullMessage = `${message}${errorDetail}`
      console.error(this.fmt('ERROR', fullMessage, RED))
      fileLogger.logFailed('SYSTEM', 'ERROR', fullMessage)
    }
  }

  warn (message: string): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(this.fmt('WARN', message, YELLOW))
    }
  }

  info (message: string): void {
    if (this.level >= LogLevel.INFO) {
      console.log(this.fmt('INFO', message, RESET))
    }
  }

  debug (message: string): void {
    if (this.level >= LogLevel.DEBUG) {
      console.log(this.fmt('DEBUG', message, GRAY))
    }
  }

  success (message: string): void {
    if (this.level >= LogLevel.INFO) {
      console.log(this.fmt('INFO', message, GREEN))
    }
  }

  moduleStart (moduleName: string): void {
    this.info(`[${moduleName}] Старт`)
  }

  moduleEnd (moduleName: string, success: boolean, executionTime?: number): void {
    const time = executionTime ? ` за ${executionTime.toFixed(2)}с` : ''
    const status = success ? 'Завершен' : 'Завершен с ошибкой'
    if (success) {
      this.success(`[${moduleName}] ${status}${time}`)
    } else {
      this.error(`[${moduleName}] ${status}${time}`)
    }

    if (executionTime) {
      fileLogger.logModuleResult(moduleName, success, executionTime)
    }
  }

  transaction (
    hash: string,
    type: 'sent' | 'confirmed' | 'failed' = 'sent',
    moduleName?: string,
    walletAddressOrAction?: string,
    action?: string
  ): void {
    const link = `https://soneium.blockscout.com/tx/${hash}`
    const maybeAddress = walletAddressOrAction?.startsWith('0x') ? walletAddressOrAction : undefined
    const resolvedAction = action ?? (walletAddressOrAction && !walletAddressOrAction.startsWith('0x')
      ? walletAddressOrAction
      : undefined)
    const module = moduleName ? `[${moduleName}]` : ''
    const actionLabel = resolvedAction ? `[${resolvedAction}]` : ''
    const prefix = `${module}${actionLabel}${module || actionLabel ? ' ' : ''}`

    if (type === 'sent') {
      this.info(`${prefix}TX отправлена: ${link}`)
    } else if (type === 'confirmed') {
      this.success(`${prefix}TX подтверждена: ${link}`)
    } else {
      this.error(`${prefix}TX не удалась: ${link}`)
    }

    if (type === 'confirmed' || type === 'failed') {
      const success = type === 'confirmed'
      const details = maybeAddress ? `${maybeAddress} - ${link}` : link
      const mod = moduleName || 'UNKNOWN'
      fileLogger.logTransaction(hash, success, mod, details)
    }
  }

  balance (token: string, amount: string, address?: string): void {
    const addr = address ? ` (${address.slice(0, 8)}...)` : ''
    this.info(`${token} баланс${addr}: ${amount}`)
  }

  operation (operation: string, status: 'start' | 'success' | 'error', details?: string): void {
    const action = status === 'start' ? 'Начало' : status === 'success' ? 'OK' : 'Ошибка'
    this.info(`${action}: ${operation}${details ? ` | ${details}` : ''}`)
  }

  iterationStart (modules: string[]): void {
    this.info(`Итерация | Модули: ${modules.join(', ')}`)
  }

  iterationResult (successCount: number, errorCount: number, totalTime: number): void {
    this.info(`Итерация завершена | Успешно: ${successCount}, Ошибок: ${errorCount}, Время: ${totalTime.toFixed(2)}с`)
  }

  threadResult (threadId: number, moduleName: string, walletAddress: string, success: boolean, executionTime: number, transactionHash?: string, error?: string): void {
    const time = executionTime.toFixed(2)
    const addr = walletAddress.slice(0, 8) + '...'
    const status = success ? 'OK' : 'Ошибка'
    const tx = transactionHash ? ` | TX: ${transactionHash}` : ''
    const err = error ? ` | ${error}` : ''

    if (success) {
      this.success(`Поток #${threadId} | ${moduleName} | ${addr}: ${status} за ${time}с${tx}`)
    } else {
      this.warn(`Поток #${threadId} | ${moduleName} | ${addr}: ${status} за ${time}с${err}`)
    }

    const details = `Поток #${threadId} | ${walletAddress} | Время: ${time}с${tx}${err}`
    if (success) {
      fileLogger.logSuccess(moduleName, 'THREAD_SUCCESS', details)
    } else {
      fileLogger.logFailed(moduleName, 'THREAD_FAILED', details)
    }
  }

  logToFile (success: boolean, module: string, operation: string, details: string): void {
    if (success) {
      fileLogger.logSuccess(module, operation, details)
    } else {
      fileLogger.logFailed(module, operation, details)
    }
  }

  logTransactionToFile (hash: string, success: boolean, module: string, details: string): void {
    fileLogger.logTransaction(hash, success, module, details)
  }

  logModuleToFile (moduleName: string, success: boolean, executionTime: number, details?: string): void {
    fileLogger.logModuleResult(moduleName, success, executionTime, details)
  }

  logTopupToFile (success: boolean, walletAddress: string, amount: string, strategy: string, details?: string): void {
    fileLogger.logWalletTopup(success, walletAddress, amount, strategy, details)
  }

  logBridgeToFile (success: boolean, fromNetwork: string, toNetwork: string, amount: string, txHash?: string, error?: string): void {
    fileLogger.logBridge(success, fromNetwork, toNetwork, amount, txHash, error)
  }

  dailyCheck (address: string, hasTransacted: boolean, lastDate?: string): void {
    if (hasTransacted) {
      this.info(`${address.slice(0, 8)}...: уже выполнено сегодня (${lastDate})`)
    } else {
      this.info(`${address.slice(0, 8)}...: нужен daily streak`)
    }
  }
}

export const logger = Logger.getInstance()
