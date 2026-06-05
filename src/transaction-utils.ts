import { isHash, isHex, keccak256, TransactionNotFoundError, type PublicClient, type WalletClient } from 'viem'
import { logger } from './logger.js'
import { rpcManager } from './rpc-manager.js'
import { SIMULATE_BEFORE_SEND, STRICT_SIMULATION } from './season-config.js'

/**
 * Per-attempt таймаут симуляции на ОДНОМ RPC.
 *
 * Должен быть согласован с `viem.timeout * viem.retryCount` для одного RPC, иначе
 * наш wrapper будет резать viem раньше, чем он успеет ретрайнуть. У нас в
 * `RpcManager.createPublicClientForUrl` дефолт `timeout=10000, retryCount=1`,
 * поэтому 12с — короткий буфер сверх viem-таймаута.
 *
 * При исчерпании всех RPC из списка наш собственный fallback всё равно перебирает
 * следующий RPC, поэтому суммарное время симуляции = SIMULATION_PER_RPC * N_RPC.
 */
const SIMULATION_PER_RPC_TIMEOUT_MS = 12000

export interface SafeWriteContractOptions {
  allowSimulationFailure?: boolean
  simulationFailureContext?: string
}

/**
 * Тип ошибки симуляции — нужен чтобы различать «транзакция точно упадёт на цепочке»
 * от «RPC не ответил, ничего не знаем про транзакцию».
 *
 * - `revert`        — контракт явно реверторил (execution reverted / require failed).
 *                     Транзакция гарантированно упадёт → блокировать отправку.
 * - `insufficient`  — недостаточно средств для оплаты gas/value. Тоже блокировать.
 * - `timeout`       — наш собственный таймаут (RPC не успел ответить).
 *                     НЕ блокировать: повторная отправка обычно проходит.
 * - `network`       — сетевая ошибка RPC (5xx, ECONNRESET, ECONNREFUSED, fetch failed).
 *                     НЕ блокировать: это проблема конкретного RPC, не транзакции.
 * - `unknown`       — всё остальное. Консервативно: блокируем при STRICT_SIMULATION.
 */
export type SimulationFailureKind =
  | 'revert'
  | 'insufficient'
  | 'timeout'
  | 'network'
  | 'unknown'

export interface SimulationOutcome {
  success: boolean
  error?: string
  kind?: SimulationFailureKind
}

interface NormalizedTransactionIdentifier {
  hash?: `0x${string}`
  normalizedFromRaw: boolean
}

/**
 * 4-byte selectors error'ов "уже выполнено сегодня" из контрактов чек-инов.
 * Эти селекторы НЕ присутствуют в нашем ABI (viem дампит их как
 * `reverted with the following signature: 0x...`), поэтому детектим по
 * подстроке в сообщении. Контракт-консистентность важнее ABI-точности:
 * один и тот же селектор означает одну и ту же логику для разных контрактов
 * только потому, что эти контракты используют одинаковые имена error'ов
 * (`AlreadyCheckedIn()`/`OncePerDay()` → одинаковый keccak256).
 *
 * Список расширяется при появлении новых селекторов в `logs/failed.txt`.
 */
const DAILY_DONE_REVERT_SELECTORS: readonly string[] = [
  '0xd3d38ea7' // Lootcoin (0x21Be1...) checkIn + Captain (0xedCb...) checkIn
]

/**
 * 4-byte selectors error'ов "дневной лимит исчерпан".
 * Для модулей, где это означает skip (а не fail) и не нужно ретраить.
 */
const DAILY_LIMIT_REVERT_SELECTORS: readonly string[] = [
  '0x106cfcb1' // Burrow Bash (0x6f55...) createGame — DailyLimitReached/AlreadyInGame
]

/**
 * Текстовые revert reasons "уже выполнено сегодня" (когда контракт делает
 * `require(..., "checked today")` вместо custom error).
 */
const DAILY_DONE_REVERT_REASONS: readonly RegExp[] = [
  /execution reverted:?\s*checked today/i, // Arkada DailyCheck (0x9882...)
  /execution reverted:?\s*already checked/i,
  /execution reverted:?\s*already claimed/i
]

/**
 * Возвращает true если revert означает «пользователь уже выполнил daily-action».
 *
 * Используется в модулях чек-инов чтобы не считать такой revert ошибкой
 * (kотируем как success с message «уже выполнено сегодня»).
 *
 * Детектит:
 * 1. Селекторы custom-error'ов из `DAILY_DONE_REVERT_SELECTORS`
 *    (например `0xd3d38ea7` от Lootcoin/Captain).
 * 2. Текстовые revert reasons из `DAILY_DONE_REVERT_REASONS`
 *    (например `execution reverted: checked today` от Arkada).
 */
export function isDailyDoneRevert (errorMessage: string): boolean {
  for (const sel of DAILY_DONE_REVERT_SELECTORS) {
    if (errorMessage.includes(sel)) return true
  }
  for (const re of DAILY_DONE_REVERT_REASONS) {
    if (re.test(errorMessage)) return true
  }
  return false
}

/**
 * Возвращает true если revert означает «исчерпан дневной лимит» (контракт
 * не примет tx до завтра, но это НЕ ошибка пользователя).
 *
 * Используется в модулях с дневным лимитом действий (Burrow Bash createGame).
 * Модуль должен возвращать `success: true, skipped: true` для такого revert,
 * а не FAILED — иначе executor неоправданно ретраит на других кошельках.
 */
export function isDailyLimitRevert (errorMessage: string): boolean {
  for (const sel of DAILY_LIMIT_REVERT_SELECTORS) {
    if (errorMessage.includes(sel)) return true
  }
  return false
}

/**
 * Нормализует сообщение об ошибке симуляции, сохраняя настоящий revert reason
 * контракта (если viem его вернул) для диагностики в логах.
 */
function normalizeSimulationError (message: string): string {
  // Пытаемся извлечь чистый revert reason из viem metaMessages
  const reasonMatch = message.match(/revert\s*:\s*([a-zA-Z0-9_ ]+)/)
  if (reasonMatch && reasonMatch[1]) {
    return `Транзакция откатится (revert): ${reasonMatch[1].trim()}`
  }
  if (message.includes('revert') || message.includes('execution reverted')) {
    return `Транзакция откатится (revert): ${message}`
  }
  if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
    return `Недостаточно средств: ${message}`
  }
  if (message.includes('timeout') || message.includes('Таймаут')) {
    return `Таймаут симуляции: ${message}`
  }
  return message
}

/**
 * Маркер локального таймаута симуляции (наш AbortController, не viem).
 * Используется внутри `runSimulationWithFallback` чтобы корректно классифицировать
 * собственный таймаут как `timeout`, а не `network` (AbortError из fetch).
 */
class SimulationTimeoutError extends Error {
  constructor () {
    super('Таймаут симуляции транзакции')
    this.name = 'SimulationTimeoutError'
  }
}

/**
 * Классифицирует ошибку симуляции в один из `SimulationFailureKind`.
 *
 * Важно отделить «транзакция упадёт на цепочке» (revert/insufficient) от
 * «RPC не ответил» (timeout/network) — потому что во втором случае не имеет
 * смысла блокировать отправку: транзакция могла бы пройти на другом RPC.
 */
export function classifySimulationError (err: unknown): SimulationFailureKind {
  if (err instanceof SimulationTimeoutError) return 'timeout'

  // viem TimeoutError ИЛИ DOMException(AbortError) от нашего AbortController
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
  }

  const message = err instanceof Error ? err.message : String(err ?? '')
  const lower = message.toLowerCase()

  // 1. Явный revert (контракт ответил, но execution reverted)
  if (
    lower.includes('execution reverted') ||
    lower.includes('reverted') ||
    lower.includes('revert reason') ||
    lower.includes('contractfunctionrevertederror')
  ) {
    return 'revert'
  }

  // 2. Недостаточно средств — тоже terminal failure для этой транзакции
  if (
    lower.includes('insufficient funds') ||
    lower.includes('insufficient balance')
  ) {
    return 'insufficient'
  }

  // 3. Таймаут — наш или viem'овский, или fetch
  if (
    lower.includes('таймаут') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted') ||
    lower.includes('the operation was aborted')
  ) {
    return 'timeout'
  }

  // 4. Сетевые ошибки RPC — не блокируем транзакцию
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('network request failed') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    lower.includes('service unavailable') ||
    lower.includes('httpversionnotsupported') ||
    lower.includes('rpc') && (lower.includes('error') || lower.includes('failed'))
  ) {
    return 'network'
  }

  return 'unknown'
}

function isTransientSimulationKind (kind: SimulationFailureKind): boolean {
  return kind === 'timeout' || kind === 'network'
}

/**
 * Выполняет симуляцию `op(client)` с автоматическим fallback по списку RPC.
 *
 * Ключевые свойства:
 * 1. На каждом RPC создаётся одноразовый publicClient с собственным AbortController,
 *    чтобы наш таймаут (`SIMULATION_PER_RPC_TIMEOUT_MS`) реально отменял in-flight
 *    fetch — а не оставлял зомби-промис от Promise.race.
 * 2. При revert/insufficient/unknown сразу возвращаем результат — нет смысла
 *    переключать RPC, ошибка детерминирована.
 * 3. При timeout/network пробуем следующий RPC из списка.
 * 4. Если все RPC выдали timeout/network — возвращаем последнюю transient-ошибку
 *    (вызывающая сторона решит, можно ли отправлять транзакцию без симуляции).
 */
async function runSimulationWithFallback (
  basePublicClient: PublicClient,
  op: (client: PublicClient) => Promise<unknown>,
  context: string
): Promise<SimulationOutcome> {
  const chain = basePublicClient.chain
  if (!chain) {
    return { success: false, error: 'Не удалось определить chain для симуляции', kind: 'unknown' }
  }

  const rpcUrls = rpcManager.getAllRpcUrls()
  if (rpcUrls.length === 0) {
    return { success: false, error: 'Нет доступных RPC для симуляции', kind: 'unknown' }
  }

  let lastTransient: SimulationOutcome | null = null

  for (let i = 0; i < rpcUrls.length; i++) {
    const rpcUrl = rpcUrls[i]!
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), SIMULATION_PER_RPC_TIMEOUT_MS)

    const client = rpcManager.createPublicClientForUrl(chain, rpcUrl, {
      signal: controller.signal,
      timeout: 10000,
      retryCount: 1
    })

    try {
      // Если AbortController сработает быстрее, чем fetch начнётся — viem кинет
      // AbortError. Если уже летит — отменит fetch.
      const opPromise = op(client)
      const racePromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new SimulationTimeoutError())
        }, { once: true })
      })
      await Promise.race([opPromise, racePromise])
      return { success: true }
    } catch (err) {
      const kind = classifySimulationError(err)
      const message = err instanceof Error ? err.message : String(err)
      const normalized = normalizeSimulationError(message)
      const outcome: SimulationOutcome = { success: false, error: normalized, kind }

      // Терминальные ошибки контракта — не имеет смысла пробовать другие RPC
      if (kind === 'revert' || kind === 'insufficient' || kind === 'unknown') {
        return outcome
      }

      // transient: попробуем следующий RPC
      lastTransient = outcome
      if (i < rpcUrls.length - 1) {
        logger.warn(
          `${context}: симуляция на RPC #${i + 1} (${rpcUrl}) — ${kind} (${normalized}); пробуем следующий`
        )
      }
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  return lastTransient ?? {
    success: false,
    error: 'Все RPC для симуляции исчерпаны',
    kind: 'network'
  }
}

function normalizeTransactionIdentifier (
  value: unknown,
  context: string
): NormalizedTransactionIdentifier {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    return { normalizedFromRaw: false }
  }

  if (isHash(value)) {
    return { hash: value as `0x${string}`, normalizedFromRaw: false }
  }

  if (value.length > 66 && isHex(value, { strict: false })) {
    logger.warn(`${context}: RPC вернул raw transaction вместо tx hash, вычисляем hash локально`)
    return {
      hash: keccak256(value as `0x${string}`),
      normalizedFromRaw: true
    }
  }

  return { normalizedFromRaw: false }
}

/**
 * Проверяет, что хэш реально существует в сети или mempool.
 *
 * Защищает от ложных хэшей, попадающих в error-объекты viem из-за того,
 * что в metaMessages дампятся аргументы контракта (например `bytes32 gameSeedHash`).
 *
 * Семантика:
 * - true: RPC подтвердил наличие транзакции (mined или pending)
 * - false: явный TransactionNotFoundError — такой tx нет в сети
 * - true: сетевая/RPC ошибка — статус неясен, доверяем структурированному полю (best-effort)
 */
async function transactionExistsOnNetwork (
  publicClient: PublicClient,
  hash: `0x${string}`,
  context: string
): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash })
    return true
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      logger.warn(`${context}: extracted hash ${hash} not found on-chain/mempool, ignoring`)
      return false
    }
    // Сетевая/RPC ошибка — статус неясен. Не можем уверенно сказать "нет",
    // поэтому доверяем структурированному полю viem.
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn(`${context}: RPC недоступен для проверки хэша ${hash}, доверяем источнику: ${msg}`)
    return true
  }
}

/**
 * Извлекает tx hash из error-объекта viem.
 *
 * Использует ТОЛЬКО структурированные поля (`error.hash`, `error.data.hash`,
 * `error.cause.hash`) — viem выставляет их когда уверен в хэше.
 *
 * Каждый кандидат валидируется через `eth_getTransactionByHash`, чтобы отсечь
 * случаи, когда viem кладёт в error-поле какой-то другой 32-байтовый идентификатор.
 *
 * НЕ использует regex по `error.message`: это небезопасно — message viem дампит
 * args контрактного вызова, и `bytes32`-аргумент (н-р gameSeedHash в Burrow Bash
 * createGame) выглядит как валидный tx hash. Это и был корень бага: бот возвращал
 * `gameSeedHash` как «хэш транзакции» и зависал в waitForTransactionReceipt.
 */
async function extractHashFromError (
  error: unknown,
  context: string,
  publicClient: PublicClient
): Promise<`0x${string}` | undefined> {
  const candidates: unknown[] = []

  if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>
    candidates.push(errorObj['hash'])

    if (errorObj['data'] && typeof errorObj['data'] === 'object') {
      candidates.push((errorObj['data'] as Record<string, unknown>)['hash'])
    }

    if (errorObj['cause'] && typeof errorObj['cause'] === 'object') {
      candidates.push((errorObj['cause'] as Record<string, unknown>)['hash'])
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeTransactionIdentifier(candidate, context)
    if (!normalized.hash) continue
    if (await transactionExistsOnNetwork(publicClient, normalized.hash, context)) {
      return normalized.hash
    }
  }

  return undefined
}

/**
 * Per-attempt таймаут для broadcast'а raw tx на ОДНОМ RPC.
 *
 * 25с — короче дефолтного timeout viem (на случай если RPC лагает),
 * но достаточно для прохождения eth_sendRawTransaction через медленный mempool.
 * Соответствует категории G failed.txt (RPC publicnode.com timeout 30s+).
 */
const BROADCAST_PER_RPC_TIMEOUT_MS = 25_000

/**
 * Broadcast raw transaction с автоматическим fallback по всем RPC из RpcManager.
 *
 * Решает проблему категории G failed.txt: publicnode.com иногда таймаутит
 * на `eth_sendRawTransaction` (главный RPC), а viem не переключается на
 * fallback URL внутри одного publicClient — он retry'ит только тот же URL.
 *
 * Алгоритм:
 * 1. На каждом RPC создаётся одноразовый publicClient с собственным AbortController
 *    и timeout 25с.
 * 2. Перед попыткой следующего RPC проверяем, не оказалась ли tx уже в mempool
 *    через `expectedHash` (recovery: предыдущий RPC мог принять tx, но не успеть
 *    вернуть нам ответ — viem отвалился по timeout, а tx на цепочке).
 * 3. При revert/already-known — fail-fast или success (нет смысла пробовать другие).
 * 4. При timeout/network — следующий RPC.
 *
 * Возвращает hash при успехе или throw'ит последнюю transient-ошибку,
 * если все RPC исчерпаны. Терминальные ошибки (revert) тоже throw'аются.
 */
export async function broadcastRawTransactionWithFallback (
  basePublicClient: PublicClient,
  serializedTransaction: `0x${string}`,
  expectedHash: `0x${string}`
): Promise<`0x${string}`> {
  const chain = basePublicClient.chain
  if (!chain) {
    throw new Error('broadcastRawTransactionWithFallback: chain не определён в publicClient')
  }

  const rpcUrls = rpcManager.getAllRpcUrls()
  if (rpcUrls.length === 0) {
    throw new Error('broadcastRawTransactionWithFallback: нет доступных RPC для broadcast')
  }

  let lastError: unknown = null

  for (let i = 0; i < rpcUrls.length; i++) {
    const rpcUrl = rpcUrls[i]!

    // Recovery-check: возможно предыдущий RPC принял tx, но мы не получили ответ.
    // Проверяем через текущий RPC — если tx уже в mempool/цепочке, считаем success.
    if (i > 0) {
      try {
        const checkClient = rpcManager.createPublicClientForUrl(chain, rpcUrl, {
          timeout: 8000, retryCount: 1
        })
        if (await transactionExistsOnNetwork(
          checkClient, expectedHash, 'broadcastRawTransactionWithFallback-recovery'
        )) {
          logger.warn(
            `broadcast: tx ${expectedHash} уже на цепочке (предыдущий RPC принял, но не ответил) — success`
          )
          return expectedHash
        }
      } catch {
        // recovery-check сам упал — двигаемся дальше
      }
    }

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), BROADCAST_PER_RPC_TIMEOUT_MS)

    const client = rpcManager.createPublicClientForUrl(chain, rpcUrl, {
      signal: controller.signal,
      timeout: 10_000,
      retryCount: 1
    })

    try {
      const broadcastPromise = client.sendRawTransaction({ serializedTransaction })
      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`broadcast: таймаут на RPC ${rpcUrl} (${BROADCAST_PER_RPC_TIMEOUT_MS}ms)`))
        }, { once: true })
      })
      const broadcastedHash = await Promise.race([broadcastPromise, abortPromise])

      // Sanity check: RPC должен вернуть тот же хэш
      if (broadcastedHash !== expectedHash) {
        logger.warn(
          `broadcast: RPC ${rpcUrl} вернул hash ${broadcastedHash}, ожидали ${expectedHash}`
        )
      }
      if (i > 0) {
        logger.info(`broadcast: success на fallback RPC #${i + 1} (${rpcUrl})`)
      }
      return expectedHash
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const lower = message.toLowerCase()

      // "already known" / "nonce too low" / "replacement underpriced" — tx, вероятно,
      // уже была отправлена. Делаем recovery-check на следующем RPC.
      if (
        lower.includes('already known') ||
        lower.includes('alreadyknown')
      ) {
        logger.info(`broadcast: ${rpcUrl} вернул "already known" → tx уже в mempool, считаем success`)
        return expectedHash
      }

      // Revert / insufficient funds — терминальные. Throw'аем сразу.
      if (
        lower.includes('execution reverted') ||
        lower.includes('insufficient funds') ||
        lower.includes('insufficient balance') ||
        lower.includes('nonce too low')
      ) {
        throw err
      }

      // transient: timeout/network — следующий RPC
      if (i < rpcUrls.length - 1) {
        logger.warn(
          `broadcast: RPC #${i + 1} (${rpcUrl}) failed (${message.slice(0, 120)}); пробуем следующий`
        )
      }
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`broadcast: все ${rpcUrls.length} RPC исчерпаны`)
}

/**
 * Симулирует writeContract через publicClient.simulateContract.
 *
 * Использует `runSimulationWithFallback`, который:
 * - перебирает все RPC из RpcManager при transient-ошибках (timeout/network)
 * - отменяет in-flight fetch через AbortController при срабатывании нашего таймаута
 *   (вместо «зомби-промиса», который оставлял старый Promise.race)
 *
 * Возвращает `SimulationOutcome` с `kind`, чтобы вызывающий мог различить
 * детерминированные сбои (revert/insufficient — блокируем) от transient
 * (timeout/network — пропускаем симуляцию, отправляем транзакцию).
 */
async function simulateWriteContract (
  publicClient: PublicClient,
  accountAddress: `0x${string}`,
  contractParams: Record<string, unknown>
): Promise<SimulationOutcome> {
  const { nonce: _n, ...params } = contractParams
  const config = {
    ...params,
    account: (params['account'] as `0x${string}`) ?? accountAddress
  }

  return runSimulationWithFallback(
    publicClient,
    (client) => client.simulateContract(config as Parameters<PublicClient['simulateContract']>[0]),
    'simulateWriteContract'
  )
}

/**
 * Симулирует сырую транзакцию через publicClient.call.
 *
 * Использует ту же `runSimulationWithFallback`-инфраструктуру, что и
 * `simulateWriteContract` — см. документацию там.
 */
async function simulateSendTransaction (
  publicClient: PublicClient,
  accountAddress: `0x${string}`,
  transactionParams: Record<string, unknown>
): Promise<SimulationOutcome> {
  const to = transactionParams['to'] as `0x${string}` | undefined
  const data = transactionParams['data'] as `0x${string}` | undefined
  if (!to || !data) {
    return { success: false, error: 'Отсутствуют to или data для симуляции', kind: 'unknown' }
  }

  // value может прийти как bigint, string, number или undefined — нормализуем безопасно.
  // Старый код делал `BigInt(transactionParams['value'] as string ?? '0')`, что
  // в рантайме работает (BigInt принимает bigint/string/number), но при value=null
  // (а такое теоретически возможно от внешнего источника типа LiFi) кинул бы
  // TypeError. Делаем явную нормализацию.
  const rawValue = transactionParams['value']
  let value: bigint
  if (rawValue == null) {
    value = 0n
  } else if (typeof rawValue === 'bigint') {
    value = rawValue
  } else if (typeof rawValue === 'number' || typeof rawValue === 'string') {
    value = BigInt(rawValue)
  } else {
    value = 0n
  }

  return runSimulationWithFallback(
    publicClient,
    (client) => client.call({ to, data, value, account: accountAddress }),
    'simulateSendTransaction'
  )
}

/**
 * Утилиты для безопасной отправки транзакций с проверкой nonce и симуляцией
 */

export interface TransactionSafetyCheck {
  canProceed: boolean
  pendingTransactions: string[]
  currentNonce: number
  recommendedNonce: number
  warnings: string[]
}

export function shouldBypassFailedSimulationInStrictMode (params: {
  strictSimulation: boolean
  allowSimulationFailure?: boolean
}): boolean {
  const { strictSimulation, allowSimulationFailure = false } = params

  return strictSimulation && allowSimulationFailure
}

/**
 * Проверяет безопасность отправки транзакции
 */
export async function checkTransactionSafety (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`
): Promise<TransactionSafetyCheck> {
  const warnings: string[] = []
  const pendingTransactions: string[] = []

  try {
    // Получаем текущий nonce
    const currentNonce = await publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: 'latest'
    })

    // Получаем pending nonce
    const pendingNonce = await publicClient.getTransactionCount({
      address: accountAddress,
      blockTag: 'pending'
    })

    // Рекомендуемый nonce должен быть pendingNonce (следующий доступный)
    const recommendedNonce = pendingNonce

    // Проверяем, есть ли pending транзакции
    if (pendingNonce > currentNonce) {
      warnings.push(`Обнаружено ${pendingNonce - currentNonce} pending транзакций`)
    }

    // Проверяем, можно ли безопасно отправить транзакцию
    // Если есть pending транзакции, лучше подождать
    const canProceed = pendingNonce === currentNonce

    if (!canProceed) {
      warnings.push('Нельзя отправить транзакцию - есть pending операции')
    }

    return {
      canProceed,
      pendingTransactions,
      currentNonce: Number(currentNonce),
      recommendedNonce: Number(recommendedNonce),
      warnings
    }

  } catch (error) {
    logger.error('Ошибка при проверке безопасности транзакции', error)
    return {
      canProceed: false,
      pendingTransactions: [],
      currentNonce: 0,
      recommendedNonce: 0,
      warnings: ['Ошибка при проверке nonce']
    }
  }
}

/**
 * Ждет завершения всех pending транзакций
 */
export async function waitForPendingTransactions (
  publicClient: PublicClient,
  accountAddress: `0x${string}`,
  maxWaitTime: number = 60000 // 60 секунд
): Promise<boolean> {
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const currentNonce = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'latest'
      })

      const pendingNonce = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (pendingNonce === currentNonce) {
        return true
      }

      await new Promise(resolve => setTimeout(resolve, 15000))

    } catch (error) {
      logger.error('Ошибка при ожидании pending транзакций', error)
      return false
    }
  }

  logger.warn('Таймаут ожидания pending транзакций')
  return false
}

/**
 * Безопасная отправка транзакции с проверкой nonce.
 *
 * Резильентная схема:
 * 1. Локально подписываем tx через `walletClient.signTransaction` →
 *    знаем `expectedHash = keccak256(serialized)` ДО broadcast'а.
 *    Это критично: если RPC моргнёт между «приёмом raw tx» и «отдачей hash клиенту»,
 *    у нас всё равно есть hash на руках.
 * 2. Broadcast через `publicClient.sendRawTransaction`.
 * 3. Если broadcast кинул error → ждём 3 сек и проверяем `getTransaction(expectedHash)`.
 *    Если tx нашлась в mempool/цепочке — broadcast реально прошёл, RPC просто
 *    не вернул нам ответ. Возвращаем success.
 * 4. На каждом attempt'е перед симуляцией проверяем `lastBroadcastedHash` —
 *    если она уже на цепочке, return success (даёт recovery когда attempt 1
 *    провалился по timeout, а tx в mempool).
 *
 * Это устраняет существующий до этого баг: если первый sendTransaction отправил
 * raw tx, но viem не получил ответ и кинул error, мы делали retry attempt с тем
 * же nonce → mempool отвергал (или симуляция показывала revert из-за нового
 * state после fact-ной нашей же tx) → транзакция «потеряна» для учёта,
 * хотя на цепочке прошла.
 */
export async function safeSendTransaction (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`,
  transactionParams: Record<string, unknown>,
  maxRetries: number = 3
): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {
  // Все hash'и, которые мы пытались broadcast'нуть в рамках этого вызова.
  // На каждом retry мы перепрепарируем + переподписываем tx (gas может измениться,
  // nonce может сменился), что даёт другой hash. Чтобы не потерять успех от
  // предыдущего attempt'а, проверяем КАЖДЫЙ из них в recovery-check'ах.
  const broadcastedHashes: `0x${string}`[] = []

  const findExistingBroadcast = async (context: string): Promise<`0x${string}` | undefined> => {
    for (const h of broadcastedHashes) {
      try {
        if (await transactionExistsOnNetwork(publicClient, h, context)) return h
      } catch {
        // recovery-check сам упал — двигаемся дальше, не блокируем основной flow
      }
    }
    return undefined
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Recovery-check: на attempt > 1, если прошлый attempt уже broadcast'нул raw tx
      // (даже если viem кинул error), проверим, не на цепочке ли любая из них.
      const recovered = await findExistingBroadcast('safeSendTransaction-retry-recovery')
      if (recovered) {
        logger.warn(`Предыдущий attempt уже broadcast'нул tx ${recovered}, считаем success`)
        return { hash: recovered, success: true }
      }

      if (SIMULATE_BEFORE_SEND) {
        const sim = await simulateSendTransaction(publicClient, accountAddress, transactionParams)
        if (!sim.success) {
          // transient (timeout/network) — НЕ блокируем отправку: симуляция упала
          // из-за RPC, а не из-за самой транзакции. Газ будет оценён viem на стадии
          // sendTransaction; если транзакция действительно reverted, она упадёт там
          // (или на цепочке). Это корректнее, чем зря отказываться от валидной tx.
          if (sim.kind && isTransientSimulationKind(sim.kind)) {
            logger.warn(
              `Симуляция недоступна (${sim.kind}: ${sim.error}). Отправляем транзакцию без симуляции.`
            )
          } else {
            // revert / insufficient / unknown — это сигнал «транзакция упадёт».
            // Daily-done/daily-limit revert'ы — нормальное состояние контракта,
            // НЕ ошибка. Caller обработает через isDailyDoneRevert/isDailyLimitRevert.
            // Логируем тихо (debug) чтобы не засорять терминал ложными WARN'ами.
            const isExpectedRevert = sim.kind === 'revert' &&
              (isDailyDoneRevert(sim.error ?? '') || isDailyLimitRevert(sim.error ?? ''))
            if (isExpectedRevert) {
              logger.debug?.(`Симуляция: daily-done/limit revert (ожидаемо): ${sim.error}`)
            } else {
              logger.warn(`Симуляция неудачна: ${sim.error}`)
            }
            if (STRICT_SIMULATION) {
              return {
                hash: '0x' as `0x${string}`,
                success: false,
                error: `Симуляция: ${sim.error}`
              }
            }
            if (!isExpectedRevert) {
              logger.warn('Продолжаем отправку несмотря на ошибку симуляции (STRICT_SIMULATION=false)')
            }
          }
        }
      }

      const safetyCheck = await checkTransactionSafety(publicClient, walletClient, accountAddress)

      if (!safetyCheck.canProceed) {
        const waited = await waitForPendingTransactions(publicClient, accountAddress)

        if (!waited) {
          if (attempt === maxRetries) {
            return {
              hash: '0x' as `0x${string}`,
              success: false,
              error: 'Не удалось дождаться завершения pending транзакций'
            }
          }
          continue
        }
      }

      const finalNonceCheck = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (finalNonceCheck !== safetyCheck.recommendedNonce) {
        safetyCheck.recommendedNonce = finalNonceCheck
      }

      // 1. Подготовить tx (fill in gas, fees, type, etc) и подписать ЛОКАЛЬНО.
      //    Делаем sign отдельно от broadcast, чтобы знать hash до broadcast'а.
      const preparedParams = {
        ...transactionParams,
        nonce: safetyCheck.recommendedNonce
      }

      const prepared = await walletClient.prepareTransactionRequest(
        preparedParams as Parameters<typeof walletClient.prepareTransactionRequest>[0]
      )
      const serializedTx = await walletClient.signTransaction(
        prepared as Parameters<typeof walletClient.signTransaction>[0]
      ) as `0x${string}`
      const expectedHash = keccak256(serializedTx)
      broadcastedHashes.push(expectedHash)

      // 2. Broadcast через fallback по всем RPC из RpcManager (категория G failed.txt):
      //    publicnode.com иногда таймаутит на eth_sendRawTransaction, а viem не
      //    переключается на fallback URL внутри одного publicClient. Наш helper
      //    перебирает все 4 RPC последовательно, делая recovery-check между ними.
      try {
        const broadcastedHash = await broadcastRawTransactionWithFallback(
          publicClient, serializedTx, expectedHash
        )
        return { hash: broadcastedHash, success: true }
      } catch (broadcastErr) {
        // Broadcast мог фактически дойти до одного из RPC, но recovery-check
        // не успел его поймать. Ждём короткий слот и финально проверяем по hash
        // через основной publicClient (последний шанс).
        await new Promise(resolve => setTimeout(resolve, 3000))
        if (await transactionExistsOnNetwork(
          publicClient, expectedHash, 'safeSendTransaction-broadcast-recovery'
        )) {
          const broadcastMsg = broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr)
          logger.warn(
            `Broadcast вернул ошибку (${broadcastMsg}), но tx ${expectedHash} нашлась на цепочке — считаем success`
          )
          return { hash: expectedHash, success: true }
        }
        // Реально не прошла — пробросим, чтобы попасть в общий catch ниже.
        throw broadcastErr
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'

      // Recovery: возможно raw tx уже broadcast'нулась на текущей или прошлой
      // итерации. (Это та же проверка, что и в начале loop'а, но catch может
      // сработать в любой точке внутри try — например, в prepareTransactionRequest
      // на attempt 2 или сразу после sendRawTransaction.)
      const recoveredInCatch = await findExistingBroadcast('safeSendTransaction-catch-recovery')
      if (recoveredInCatch) {
        logger.warn(
          `Ошибка попытки ${attempt} (${errorMessage}), но tx ${recoveredInCatch} уже на цепочке — считаем success`
        )
        return { hash: recoveredInCatch, success: true }
      }

      // Может быть, viem всё-таки положил hash в error.hash / error.data.hash
      // (это используется в safeWriteContract). Используем тот же приём здесь.
      const extractedHash = await extractHashFromError(error, 'safeSendTransaction', publicClient)
      if (extractedHash) {
        return { hash: extractedHash, success: true }
      }

      // Если это ошибка nonce, не логируем полную ошибку
      if (errorMessage.includes('nonce') || errorMessage.includes('replacement')) {
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue
      }

      // Contract revert детерминирован — повторные попытки бессмысленны
      if (errorMessage.includes('reverted') || errorMessage.includes('revert')) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      logger.error(`Ошибка попытки ${attempt}: ${errorMessage}`)

      if (attempt === maxRetries) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      await new Promise(resolve => setTimeout(resolve, 15000))
    }
  }

  return {
    hash: '0x' as `0x${string}`,
    success: false,
    error: 'Исчерпаны все попытки'
  }
}

/**
 * Безопасная отправка writeContract с проверкой nonce (БЕЗ симуляции)
 * Используется для контрактов, где simulateContract дает false negative
 */
export async function safeWriteContractWithoutSimulation (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`,
  contractParams: Record<string, unknown>,
  maxRetries: number = 3
): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Пропускаем симуляцию - отправляем транзакцию напрямую

      const safetyCheck = await checkTransactionSafety(publicClient, walletClient, accountAddress)

      if (!safetyCheck.canProceed) {
        const waited = await waitForPendingTransactions(publicClient, accountAddress)

        if (!waited) {
          if (attempt === maxRetries) {
            return {
              hash: '0x' as `0x${string}`,
              success: false,
              error: 'Не удалось дождаться завершения pending транзакций'
            }
          }
          continue
        }
      }

      const finalNonceCheck = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (finalNonceCheck !== safetyCheck.recommendedNonce) {
        safetyCheck.recommendedNonce = finalNonceCheck
      }

      const returnedIdentifier = await walletClient.writeContract({
        ...contractParams,
        nonce: safetyCheck.recommendedNonce
      } as Parameters<typeof walletClient.writeContract>[0])

      const normalized = normalizeTransactionIdentifier(returnedIdentifier, 'safeWriteContractWithoutSimulation')
      if (!normalized.hash) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: 'RPC вернул некорректный идентификатор транзакции'
        }
      }

      return { hash: normalized.hash, success: true }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      const extractedHash = await extractHashFromError(error, 'safeWriteContractWithoutSimulation', publicClient)

      if (extractedHash) {
        return { hash: extractedHash, success: true }
      }

      if (errorMessage.includes('nonce') || errorMessage.includes('replacement')) {
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue
      }

      // Contract revert детерминирован — повторные попытки бессмысленны
      if (errorMessage.includes('reverted') || errorMessage.includes('revert')) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      logger.error(`Ошибка попытки ${attempt}: ${errorMessage}`)

      if (attempt === maxRetries) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      await new Promise(resolve => setTimeout(resolve, 15000))
    }
  }

  return {
    hash: '0x' as `0x${string}`,
    success: false,
    error: 'Исчерпаны все попытки'
  }
}

/**
 * Безопасная отправка writeContract с проверкой nonce
 */
export async function safeWriteContract (
  publicClient: PublicClient,
  walletClient: WalletClient,
  accountAddress: `0x${string}`,
  contractParams: Record<string, unknown>,
  maxRetries: number = 3,
  options: SafeWriteContractOptions = {}
): Promise<{ hash: `0x${string}`; success: boolean; error?: string }> {
  const { allowSimulationFailure = false, simulationFailureContext } = options

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (SIMULATE_BEFORE_SEND) {
        const sim = await simulateWriteContract(publicClient, accountAddress, contractParams)
        if (!sim.success) {
          // transient (timeout/network) — НЕ блокируем отправку. Это самый частый
          // случай, который раньше выкатывался как «Ошибка approve: Симуляция:
          // Таймаут симуляции» при перегруженном publicnode.com. На стадии
          // writeContract viem сам сделает eth_estimateGas; если транзакция
          // действительно reverted, она упадёт там. Если же RPC просто медленный —
          // транзакция нормально пройдёт.
          if (sim.kind && isTransientSimulationKind(sim.kind)) {
            logger.warn(
              `Симуляция недоступна (${sim.kind}: ${sim.error}). Отправляем транзакцию без симуляции.`
            )
          } else {
            // revert / insufficient / unknown — это сигнал «транзакция упадёт».
            // Сохраняем существующее поведение allowSimulationFailure / STRICT_SIMULATION.
            // Daily-done/daily-limit revert'ы — нормальное состояние контракта,
            // НЕ ошибка. Caller обработает через isDailyDoneRevert/isDailyLimitRevert.
            // Логируем тихо (debug), чтобы не засорять терминал ложными WARN'ами.
            const isExpectedRevert = sim.kind === 'revert' &&
              (isDailyDoneRevert(sim.error ?? '') || isDailyLimitRevert(sim.error ?? ''))
            if (isExpectedRevert) {
              logger.debug?.(`Симуляция: daily-done/limit revert (ожидаемо): ${sim.error}`)
            } else {
              logger.warn(`Симуляция неудачна: ${sim.error}`)
            }
            if (shouldBypassFailedSimulationInStrictMode({
              strictSimulation: STRICT_SIMULATION,
              allowSimulationFailure
            })) {
              logger.warn(
                simulationFailureContext ??
                'Продолжаем отправку несмотря на ошибку симуляции (verified fallback policy)'
              )
            } else if (STRICT_SIMULATION) {
              return {
                hash: '0x' as `0x${string}`,
                success: false,
                error: `Симуляция: ${sim.error}`
              }
            } else if (!isExpectedRevert) {
              logger.warn('Продолжаем отправку несмотря на ошибку симуляции (STRICT_SIMULATION=false)')
            }
          }
        }
      }

      const safetyCheck = await checkTransactionSafety(publicClient, walletClient, accountAddress)

      if (!safetyCheck.canProceed) {
        const waited = await waitForPendingTransactions(publicClient, accountAddress)

        if (!waited) {
          if (attempt === maxRetries) {
            return {
              hash: '0x' as `0x${string}`,
              success: false,
              error: 'Не удалось дождаться завершения pending транзакций'
            }
          }
          continue
        }
      }

      const finalNonceCheck = await publicClient.getTransactionCount({
        address: accountAddress,
        blockTag: 'pending'
      })

      if (finalNonceCheck !== safetyCheck.recommendedNonce) {
        safetyCheck.recommendedNonce = finalNonceCheck
      }

      const returnedIdentifier = await walletClient.writeContract({
        ...contractParams,
        nonce: safetyCheck.recommendedNonce
      } as Parameters<typeof walletClient.writeContract>[0])

      const normalized = normalizeTransactionIdentifier(returnedIdentifier, 'safeWriteContract')
      if (!normalized.hash) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: 'RPC вернул некорректный идентификатор транзакции'
        }
      }

      // Не логируем здесь - это будет сделано в модулях через logger.transaction()
      // Убираем дублирование логов
      return { hash: normalized.hash, success: true }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      const extractedHash = await extractHashFromError(error, 'safeWriteContract', publicClient)

      if (extractedHash) {
        return { hash: extractedHash, success: true }
      }

      if (errorMessage.includes('nonce') || errorMessage.includes('replacement')) {
        await new Promise(resolve => setTimeout(resolve, 30000))
        continue
      } else {
        // Для других ошибок логируем полную информацию
        logger.error(`Ошибка попытки ${attempt}: ${errorMessage}`)
      }

      if (attempt === maxRetries) {
        return {
          hash: '0x' as `0x${string}`,
          success: false,
          error: errorMessage
        }
      }

      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, 15000))
    }
  }

  return {
    hash: '0x' as `0x${string}`,
    success: false,
    error: 'Исчерпаны все попытки'
  }
}
