/**
 * Unified exponential backoff with jitter.
 *
 * Usage:
 *   const delay = backoffDelay(attempt)   // attempt starts at 0
 *   await sleep(delay)
 *
 * Or use the higher-level helper:
 *   const result = await retryWithBackoff(() => fetchData(), { maxAttempts: 5 })
 */

export interface BackoffOptions {
  /** Base delay in ms (default 1000) */
  baseMs?: number
  /** Maximum delay cap in ms (default 60 000) */
  maxMs?: number
  /** Jitter factor 0..1 — fraction of delay added randomly (default 0.25) */
  jitter?: number
}

/**
 * Returns the delay (ms) for the given 0-based attempt number.
 * Formula: min(baseMs × 2^attempt + random jitter, maxMs)
 */
export function backoffDelay (attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 60_000, jitter = 0.25 } = opts
  const exponential = baseMs * Math.pow(2, attempt)
  const withJitter = exponential + exponential * jitter * Math.random()
  return Math.min(withJitter, maxMs)
}

/** Promise-based sleep */
export function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface RetryOptions extends BackoffOptions {
  /** Max number of attempts (default 3) */
  maxAttempts?: number
  /** Optional callback invoked on each retry with (error, attemptIndex) */
  onRetry?: (error: unknown, attempt: number) => void
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff + jitter.
 * Throws the last error if all attempts fail.
 */
export async function retryWithBackoff<T> (fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, onRetry, ...backoffOpts } = opts
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt + 1 >= maxAttempts) break
      onRetry?.(err, attempt)
      await sleep(backoffDelay(attempt, backoffOpts))
    }
  }

  throw lastError
}
