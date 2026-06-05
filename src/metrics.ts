import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface MetricEntry {
  timestamp: string
  event: 'module_run' | 'transaction' | 'iteration' | 'error'
  module?: string | undefined
  wallet?: string | undefined
  success: boolean
  durationMs?: number | undefined
  txHash?: string | undefined
  gasUsed?: string | undefined
  error?: string | undefined
  extra?: Record<string, unknown> | undefined
}

/**
 * Lightweight JSON-Lines metrics logger.
 * Appends one JSON object per line to `logs/metrics.jsonl`.
 */
class MetricsCollector {
  private static instance: MetricsCollector
  private readonly filePath: string

  private constructor () {
    const logsDir = join(process.cwd(), 'logs')
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true })
    }
    this.filePath = join(logsDir, 'metrics.jsonl')
  }

  static getInstance (): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector()
    }
    return MetricsCollector.instance
  }

  /** Record a metric entry */
  record (entry: Omit<MetricEntry, 'timestamp'>): void {
    const line: MetricEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    }
    try {
      appendFileSync(this.filePath, JSON.stringify(line) + '\n', 'utf8')
    } catch {
      // Silently ignore write errors to avoid crashing the app
    }
  }

  /** Convenience: record a module execution result */
  moduleRun (module: string, wallet: string, success: boolean, durationMs: number, opts?: { txHash?: string | undefined, gasUsed?: string | undefined, error?: string | undefined }): void {
    this.record({
      event: 'module_run',
      module,
      wallet,
      success,
      durationMs,
      ...opts
    })
  }

  /** Convenience: record an iteration summary */
  iteration (success: boolean, durationMs: number, extra?: Record<string, unknown>): void {
    this.record({
      event: 'iteration',
      success,
      durationMs,
      ...(extra ? { extra } : {})
    })
  }
}

export const metrics = MetricsCollector.getInstance()
