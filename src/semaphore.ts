/**
 * Concurrency limiter (counting semaphore).
 * Controls how many async tasks can run simultaneously.
 */
export class Semaphore {
  private running = 0
  private readonly queue: Array<() => void> = []

  constructor (private maxConcurrency: number) {}

  /** Current concurrency limit */
  get limit (): number { return this.maxConcurrency }

  /** How many tasks are currently running */
  get active (): number { return this.running }

  /** Dynamically adjust the concurrency limit */
  setLimit (n: number): void { this.maxConcurrency = Math.max(1, n) }

  /** Acquire a slot — resolves when a slot is available */
  async acquire (): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++
      return
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.running++
        resolve()
      })
    })
  }

  /** Release a slot */
  release (): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }

  /** Run `fn` with a concurrency slot */
  async run<T> (fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/**
 * Maps items through `fn` with at most `concurrency` in-flight at a time.
 */
export async function mapConcurrent<T, R> (
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const sem = new Semaphore(concurrency)
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))))
}
