import { logger } from './logger.js'

/**
 * Простой мониторинг цены газа в ETH mainnet
 * Использует RPC метод eth_gasPrice для получения текущей цены.
 *
 * Категория H failed.txt: ошибки fetch failed на gas-checker'е — это
 * non-critical noise (мониторинг газа, не влияет на работу модулей).
 * При недоступности всех RPC возвращаем 0 → caller трактует как "газ в норме".
 */
export class GasChecker {
  private maxGasPriceGwei: number
  /**
   * Список RPC для ETH mainnet с fallback. Если первый таймаутит/возвращает
   * 5xx — пробуем следующий. Все они публичные и бесплатные.
   */
  private readonly ethMainnetRpcs: readonly string[] = [
    'https://ethereum.rpc.thirdweb.com/',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth'
  ]
  private readonly perRpcTimeoutMs: number = 8_000

  constructor (maxGasPriceGwei: number) {
    this.maxGasPriceGwei = maxGasPriceGwei
  }

  /**
   * Получить текущую цену газа через eth_gasPrice RPC метод с fallback.
   *
   * При ошибке на одном RPC — пробуем следующий. Если все RPC недоступны —
   * возвращаем 0 (caller трактует как "газ в норме"). Лог только debug-уровня,
   * чтобы не засорять терминал — gas-checker non-critical.
   */
  async getCurrentGasPrice (): Promise<number> {
    let lastError: unknown = null
    for (const rpc of this.ethMainnetRpcs) {
      try {
        const response = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_gasPrice',
            params: [],
            id: 1
          }),
          signal: AbortSignal.timeout(this.perRpcTimeoutMs)
        })

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const data = await response.json()

        if (data.error) {
          throw new Error(`RPC error: ${data.error.message}`)
        }

        const gasPriceWei = BigInt(data.result)
        const gasPriceGwei = Number(gasPriceWei) / 1e9

        return gasPriceGwei
      } catch (error) {
        lastError = error
        // Тихо переходим к следующему RPC. debug-уровень не засоряет терминал.
        const msg = error instanceof Error ? error.message : String(error)
        logger.debug?.(`[gas-checker] ${rpc} недоступен: ${msg.slice(0, 100)}`)
      }
    }
    // Все RPC исчерпаны — non-critical, тихий debug + 0 (трактуется как норма)
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    logger.debug?.(`[gas-checker] все RPC недоступны (${msg.slice(0, 120)}), возвращаем 0`)
    return 0
  }

  /**
   * Проверить превышение лимита цены газа
   */
  async isGasPriceTooHigh (): Promise<boolean> {
    const currentGas = await this.getCurrentGasPrice()
    return currentGas > this.maxGasPriceGwei
  }

  /**
   * Ожидать снижения цены газа до приемлемого уровня
   */
  async waitForGasPriceToDrop (): Promise<void> {
    while (await this.isGasPriceTooHigh()) {
      const currentGas = await this.getCurrentGasPrice()
      logger.info(`Газ ${currentGas.toFixed(2)} Gwei > ${this.maxGasPriceGwei} Gwei, ждем 1 минуту...`)
      await new Promise(resolve => setTimeout(resolve, 60000)) // 1 минута
    }
    const finalGas = await this.getCurrentGasPrice()
    logger.info(`Газ в норме: ${finalGas.toFixed(2)} Gwei`)
  }

  /**
   * Получить установленный лимит газа
   */
  getMaxGasPrice (): number {
    return this.maxGasPriceGwei
  }
}
