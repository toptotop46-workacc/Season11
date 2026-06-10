import type { SeasonBadgeMintConfig } from './modules/season-badge-mint.js'

/**
 * Единая конфигурация текущего сезона.
 * Смена сезона и порога завершённости — в одном месте.
 */
export const CURRENT_SEASON = 11
/** Порог поинтов для статуса «завершён» (>= включительно). */
export const POINTS_LIMIT_SEASON = 81

/**
 * Если `true`, completed-кошельки (`seasonScore >= POINTS_LIMIT_SEASON`)
 * НЕ исключаются из работы parallel-executor: они продолжают попадать в
 * итерацию с обычной ротацией модулей.
 *
 * Если `false` — completed-кошельки полностью
 * исключаются из работы.
 */
export const GM_IGNORE_POINTS_LIMIT = false

/** Минимальный процент от баланса ETH для свапа в USDC.e (через Jumper). Дробные значения допустимы, например 0.1 = 0.1%, 1 = 1%, 15 = 15%. */
export const LIQUIDITY_SWAP_PERCENT_MIN = 1.1
/** Максимальный процент от баланса ETH для свапа в USDC.e (через Jumper). Дробные значения допустимы. */
export const LIQUIDITY_SWAP_PERCENT_MAX = 5.1

/** Симулировать транзакцию перед отправкой (eth_call / simulateContract). Отключить при глючном RPC. */
export const SIMULATE_BEFORE_SEND = true

/** Строгая симуляция: блокировать транзакции при ошибке симуляции. false = только предупреждение. */
export const STRICT_SIMULATION = true

/**
 * Конфигурация активного минта SBT-бейджа предыдущего сезона.
 *
 * При наступлении нового сезона достаточно обновить только этот блок:
 * - `season` — номер сезона (UI таблицы, Excel и логов берётся отсюда)
 * - `nftContract` — адрес ERC721-контракта бейджа
 * - `mintPhase1Date` — старт Stage 1 (для 84+ поинтов)
 * - `mintPhase2Date` — старт Stage 2 (для threshold..83 поинтов)
 * - `threshold` — минимальный score для eligibility (по умолчанию 80)
 * - `txLabel` — метка для логов транзакций
 */
export const BADGE_MINT_CONFIG: SeasonBadgeMintConfig = {
  season: 10,
  nftContract: '0x28DDd4926D0A40c8AFE191e3748FEbcF03e842Fa',
  mintPhase1Date: new Date('2026-06-10T10:00:00+03:00'), // Stage 1 для 84-100
  mintPhase2Date: new Date('2026-06-24T10:00:00+03:00'), // Stage 2 для 80-83
  threshold: 80,
  txLabel: 'SEASON10_BADGE_MINT'
}
