/**
 * Centralized runtime configuration.
 *
 * Values come from environment variables (`.env`) when set,
 * falling back to sensible defaults so the app works out-of-the-box.
 *
 * Usage: `import { config } from './config.js'`
 */

function envInt (key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function envString (key: string, fallback: string): string {
  return process.env[key] || fallback
}

function envList (key: string, fallback: string[]): string[] {
  const v = process.env[key]
  if (!v) return fallback
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

export const config = {
  /** RPC endpoints (comma-separated in env) */
  rpcUrls: envList('SONEIUM_RPC_URLS', [
    'https://soneium-rpc.publicnode.com',
    'https://1868.rpc.thirdweb.com',
    'https://soneium.drpc.org',
    'https://soneium.rpc.hypersync.xyz'
  ]),

  /** Per-request timeout for RPC calls (ms) */
  rpcTimeout: envInt('RPC_TIMEOUT_MS', 10000),

  /** RPC retry count per node */
  rpcRetryCount: envInt('RPC_RETRY_COUNT', 3),

  /** RPC retry delay (ms) */
  rpcRetryDelay: envInt('RPC_RETRY_DELAY_MS', 1000),

  /** Soneium portal API base URL */
  statsApiBaseUrl: envString('STATS_API_BASE_URL', 'https://portal.soneium.org/api'),

  /** Timeout for stats API requests (ms) */
  statsApiTimeout: envInt('STATS_API_TIMEOUT_MS', 10000),

  /** How many times to retry a failed stats API call */
  statsApiRetryAttempts: envInt('STATS_API_RETRY_ATTEMPTS', 5),

  /** Max concurrent wallet fetches for statistics */
  statsConcurrency: envInt('STATS_CONCURRENCY', 15),

  /** Block explorer base URL */
  explorerUrl: envString('EXPLORER_URL', 'https://soneium.blockscout.com')
} as const
