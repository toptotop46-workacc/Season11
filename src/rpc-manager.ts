import { createPublicClient, createWalletClient, http, type Chain, type Account, type PublicClient, type WalletClient } from 'viem'
import { config } from './config.js'
import { backoffDelay, sleep } from './backoff.js'

/**
 * Опции для одноразового public client (используется в simulate-обёртках с AbortSignal).
 * - timeout: per-attempt таймаут viem (default 10000)
 * - retryCount: ретраи viem на ОДНОМ RPC. По умолчанию 1, потому что наш собственный
 *   fallback в transaction-utils перебирает несколько RPC; viem-уровневые ретраи
 *   только удлиняли бы наш таймаут симуляции.
 * - signal: AbortSignal для отмены in-flight fetch (нужен для нашего timeout)
 */
export interface PublicClientOptions {
  timeout?: number
  retryCount?: number
  signal?: AbortSignal
}

/**
 * Менеджер RPC с fallback системой для сети Soneium
 */
export class RpcManager {
  private readonly rpcUrls: string[]
  private currentIndex: number = 0

  constructor () {
    this.rpcUrls = config.rpcUrls
  }

  /**
   * Получает текущий RPC URL
   */
  getCurrentRpc (): string {
    return this.rpcUrls[this.currentIndex] || this.rpcUrls[0] || ''
  }

  /**
   * Переключается на следующий RPC при ошибке
   */
  switchToNextRpc (): string | null {
    this.currentIndex++
    if (this.currentIndex >= this.rpcUrls.length) {
      return null // Все RPC исчерпаны
    }
    return this.getCurrentRpc()
  }

  /**
   * Сбрасывает индекс на первый RPC
   */
  reset (): void {
    this.currentIndex = 0
  }

  /**
   * Получает все доступные RPC URL
   */
  getAllRpcUrls (): string[] {
    return [...this.rpcUrls]
  }

  /**
   * Создает public client с текущим RPC
   */
  createPublicClient (chain: Chain): PublicClient {
    return createPublicClient({
      chain,
      transport: http(this.getCurrentRpc(), {
        timeout: config.rpcTimeout,
        retryCount: config.rpcRetryCount,
        retryDelay: config.rpcRetryDelay
      })
    })
  }

  /**
   * Создает одноразовый public client под конкретный RPC URL.
   *
   * Используется в `transaction-utils` для симуляции с собственным fallback по списку
   * RPC + AbortSignal: на каждой попытке симуляции мы создаём отдельный клиент с
   * новым signal, чтобы корректно отменить in-flight fetch при срабатывании нашего
   * таймаута (вместо «зомби-промиса» от Promise.race).
   */
  createPublicClientForUrl (
    chain: Chain,
    rpcUrl: string,
    opts: PublicClientOptions = {}
  ): PublicClient {
    const { timeout = 10000, retryCount = 1, signal } = opts
    return createPublicClient({
      chain,
      transport: http(rpcUrl, {
        timeout,
        retryCount,
        retryDelay: 500,
        ...(signal ? { fetchOptions: { signal } } : {})
      })
    })
  }

  /**
   * Создает wallet client с текущим RPC
   */
  createWalletClient (chain: Chain, account: Account): WalletClient {
    return createWalletClient({
      account,
      chain,
      transport: http(this.getCurrentRpc(), {
        timeout: config.rpcTimeout,
        retryCount: config.rpcRetryCount,
        retryDelay: config.rpcRetryDelay
      })
    })
  }

  /**
   * Выполняет операцию с автоматическим переключением RPC при ошибках
   */
  async executeWithFallback<T> (
    operation: (rpc: string) => Promise<T>,
    maxRetries: number = this.rpcUrls.length
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const currentRpc = this.getCurrentRpc()
        const result = await operation(currentRpc)

        return result
      } catch (error) {
        lastError = error as Error

        const nextRpc = this.switchToNextRpc()
        if (!nextRpc) {
          break // Все RPC исчерпаны
        }

        await sleep(backoffDelay(attempt))
      }
    }

    throw new Error(`Все RPC провайдеры недоступны. Последняя ошибка: ${lastError?.message}`)
  }
}

// Экспортируем singleton instance
export const rpcManager = new RpcManager()

// Экспортируем конфигурацию сети Soneium
export const SONEIUM_CHAIN_ID = 1868

export const soneiumChain: Chain = {
  id: SONEIUM_CHAIN_ID,
  name: 'Soneium',
  nativeCurrency: {
    decimals: 18,
    name: 'Ethereum',
    symbol: 'ETH'
  },
  rpcUrls: {
    default: {
      http: rpcManager.getAllRpcUrls()
    },
    public: {
      http: rpcManager.getAllRpcUrls()
    }
  },
  blockExplorers: {
    default: {
      name: 'Soneium Explorer',
      url: 'https://soneium.blockscout.com'
    }
  }
}
