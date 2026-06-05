import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { Socket } from 'node:net'
import tls from 'node:tls'
import { logger } from '../logger.js'
import { ProxyManager, type ProxyConfig } from '../proxy-manager.js'
import { openProxyConnectTunnel } from './wot-ws-tunnel.js'

// ============================================================
// CONSTANTS
// ============================================================

const WOT_API_BASE = 'https://api.worldoftrinity.com'
const WOT_WS_URL_TEMPLATE = 'wss://api.worldoftrinity.com/?token='

const SONEIUM_PORTAL_API = 'https://portal.soneium.org/api'

/** dappId квеста World of Trinity в Soneium S10 */
const QUEST_DAPP_ID = 'worldoftrinity_10'

/** Индекс subtask'а "Join 3 games" в quests массиве (0 = Buy Pack, 1 = Join 3 games) */
const QUEST_INDEX = 1

const QUEST_REQUIRED = 3

/** typeId Starter Pack — им заполняется giftPacks для новых пользователей */
const STARTER_PACK_TYPE_ID = 1

const HTTP_TIMEOUT_MS = 30_000
const PORTAL_RETRY_ATTEMPTS = 5
const PORTAL_RETRY_DELAY_MS = 3_000
// 30s — совпадает с HTTP_TIMEOUT_MS. 15s оказалось мало для handshake'а
// через медленные webshare-прокси (категория failed.txt: WS open timeout
// на ~20s при работающем HTTP через тот же IP).
const WS_OPEN_TIMEOUT_MS = 30_000
const MATCHMAKING_TIMEOUT_MS = 90_000
// Retry для транзиентных WS-ошибок (ECONNRESET / unexpected close). Free
// battle не тратится до получения matchmaking.matched, поэтому повторные
// попытки безопасны. matchmaking.error НЕ retry'им — это ответ сервера.
const WS_RETRY_ATTEMPTS = 2
const WS_RETRY_DELAY_MS = 2_000

// ============================================================
// HTTP HELPERS
// ============================================================

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0'
]

function pickRandomUserAgent (): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!
}

/**
 * Axios-compatible HTTP клиент с .get/.post возвращающими `{ status, data }`.
 *
 * Используется undici-fetch (вместо axios) потому что webshare-прокси
 * блокируют axios+https-proxy-agent на portal.soneium.org/api.worldoftrinity.com
 * с ответом `403 client_connect_forbidden_host`. undici отправляет CONNECT
 * туннель с другим TLS fingerprint и проходит фильтр.
 *
 * Shape `{ status, data }` сохранён для совместимости с существующими тестами,
 * которые используют моки с похожим shape.
 */
export interface WotHttpClient {
  get: <T = unknown>(url: string, opts?: { headers?: Record<string, string> })
    => Promise<{ status: number, data: T }>
  post: <T = unknown>(url: string, body: unknown, opts?: { headers?: Record<string, string> })
    => Promise<{ status: number, data: T }>
}

class HttpResponseError extends Error {
  response: { status: number, data: unknown }
  constructor (status: number, data: unknown, message: string) {
    super(message)
    this.name = 'HttpResponseError'
    this.response = { status, data }
  }
}

/**
 * Парсит body как JSON, если возможно. Возвращает строку если parse не удался.
 */
async function parseBodySafe (resp: Awaited<ReturnType<typeof undiciFetch>>): Promise<unknown> {
  const text = await resp.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Создаёт HTTP клиент через undici ProxyAgent + native fetch.
 * Паттерн bear-fingerprint совместим с webshare и Cloudflare-protected APIs.
 */
function createWotHttpClient (proxy: ProxyConfig): WotHttpClient {
  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  const dispatcher = new ProxyAgent({ uri: proxyUrl })
  const baseHeaders = {
    'User-Agent': pickRandomUserAgent(),
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
  }

  async function send (
    method: 'GET' | 'POST', url: string, body: unknown, extraHeaders?: Record<string, string>
  ): Promise<{ status: number, data: unknown }> {
    const init: Parameters<typeof undiciFetch>[1] = {
      method,
      headers: { ...baseHeaders, ...extraHeaders },
      dispatcher,
      // AbortSignal.timeout — нативная альтернатива axios timeout
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    }
    if (method === 'POST' && body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { ...init.headers, 'Content-Type': 'application/json' }
    }
    const resp = await undiciFetch(url, init)
    const data = await parseBodySafe(resp)
    if (resp.status >= 400) {
      throw new HttpResponseError(
        resp.status, data, `Request failed with status code ${resp.status}`
      )
    }
    return { status: resp.status, data }
  }

  return {
    get: async <T,>(url: string, opts?: { headers?: Record<string, string> }) => {
      const r = await send('GET', url, undefined, opts?.headers)
      return { status: r.status, data: r.data as T }
    },
    post: async <T,>(url: string, body: unknown, opts?: { headers?: Record<string, string> }) => {
      const r = await send('POST', url, body, opts?.headers)
      return { status: r.status, data: r.data as T }
    }
  }
}

/** Bearer-authorization header helper */
function authHeaders (jwt: string): { Authorization: string } {
  return { Authorization: `Bearer ${jwt}` }
}

// ============================================================
// TYPES
// ============================================================

export interface WorldOfTrinityResult {
  success: boolean
  walletAddress?: Address
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  roomId?: string
  [key: string]: unknown
}

interface BonusDappQuest {
  id: string
  season: number
  quests: Array<{ required: number, completed: number, isDone: boolean }>
}

interface DailyStatsResponse {
  battlesPlayedToday?: number
  freeBattlesLimit?: number
  freeBattlesRemaining?: number
  [key: string]: unknown
}

/** Абстракция подписи — для тестирования без приватных ключей */
export interface MessageSigner {
  address: Address
  signMessage (params: { message: string }): Promise<`0x${string}`>
}

// ============================================================
// QUEST PROGRESS PARSER
// ============================================================

export interface QuestProgress {
  found: boolean
  isDone: boolean
  completed: number
  required: number
}

/**
 * Парсит ответ Soneium portal /api/profile/bonus-dapp и извлекает прогресс
 * конкретного subtask'а по индексу. Для WoT "Join 3 games" это quests[1].
 *
 * found=false → dapp отсутствует в ответе (неактивен в текущей week) →
 * модуль должен skip и не делать действий.
 */
export function parseQuestProgress (
  bonusData: ReadonlyArray<BonusDappQuest>,
  questIndex: number
): QuestProgress {
  const dapp = bonusData.find(d => d.id === QUEST_DAPP_ID)
  if (!dapp) {
    return { found: false, isDone: false, completed: 0, required: 0 }
  }
  const quest = dapp.quests[questIndex]
  if (!quest) {
    return { found: true, isDone: false, completed: 0, required: 0 }
  }
  return {
    found: true,
    isDone: quest.isDone,
    completed: quest.completed,
    required: quest.required
  }
}

// ============================================================
// USER/CARDS PARSERS
// ============================================================

export interface UserState {
  address: string
  giftPacks: number[]
}

/**
 * Парсит /api/v1/user/me. Defensive к missing fields.
 * Throws если raw не объект или без address (критичная поломка API).
 */
export function parseUserMe (raw: unknown): UserState {
  if (!raw || typeof raw !== 'object') {
    throw new Error('parseUserMe: expected object user response')
  }
  const obj = raw as Record<string, unknown>
  const address = obj['address']
  if (typeof address !== 'string' || address.length === 0) {
    throw new Error('parseUserMe: missing or invalid address field')
  }
  const rawPacks = obj['giftPacks']
  const giftPacks = Array.isArray(rawPacks)
    ? rawPacks.filter((x): x is number => typeof x === 'number')
    : []
  return { address, giftPacks }
}

/**
 * Парсит /api/v1/cards/me. Возвращает количество cards.
 * Defensive: non-array → 0.
 */
export function parseCardsMe (raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0
}

// ============================================================
// AUTH RESPONSE VALIDATION
// ============================================================

export interface AuthValidationResult {
  ok: boolean
  token?: string
  error?: string
}

/**
 * Sanity-check ответа /api/v1/auth/verify.
 * JWT должен содержать 3 base64url-сегмента через 2 точки (header.payload.sig).
 */
export function validateAuthVerifyResponse (raw: unknown): AuthValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Empty/non-object auth response' }
  }
  const obj = raw as Record<string, unknown>
  const token = obj['token']
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'Missing or invalid token field' }
  }
  const dotCount = (token.match(/\./g) ?? []).length
  if (dotCount !== 2) {
    return { ok: false, error: `Invalid JWT shape: expected 2 dots, got ${dotCount}` }
  }
  return { ok: true, token }
}

// ============================================================
// AUTHENTICATION
// ============================================================

interface NonceResponse {
  requestId: string
  message: string
}

/**
 * Sign-message аутентификация WoT:
 *   POST /api/v1/auth/nonce {address} → {requestId, message}
 *   signature = await signer.signMessage({message})
 *   POST /api/v1/auth/verify {requestId, signature} → {token}
 *
 * Возвращает JWT (exp = iat + 24h). Не кэширует — кэш делает caller.
 */
export async function authenticate (
  signer: MessageSigner,
  http: WotHttpClient
): Promise<string> {
  // Step 1: запросить nonce
  const nonceResp = await http.post(
    `${WOT_API_BASE}/api/v1/auth/nonce`,
    { address: signer.address }
  )
  const nonce = nonceResp.data as Partial<NonceResponse>
  if (typeof nonce.requestId !== 'string' || typeof nonce.message !== 'string' ||
      nonce.requestId.length === 0 || nonce.message.length === 0) {
    throw new Error(`auth nonce: invalid response shape (${JSON.stringify(nonce).slice(0, 200)})`)
  }

  // Step 2: подписать message
  const signature = await signer.signMessage({ message: nonce.message })

  // Step 3: отправить signature на verify
  const verifyResp = await http.post(
    `${WOT_API_BASE}/api/v1/auth/verify`,
    { requestId: nonce.requestId, signature }
  )
  const validation = validateAuthVerifyResponse(verifyResp.data)
  if (!validation.ok || !validation.token) {
    throw new Error(`auth verify failed: ${validation.error ?? 'unknown'}`)
  }
  return validation.token
}

// ============================================================
// DECK BOOTSTRAP
// ============================================================

export interface EnsureDeckResult {
  ok: boolean
  cardsCount: number
  bootstrapped: boolean
  reason?: string
}

/**
 * Проверяет что у кошелька есть ≥3 cards (минимум для battle).
 * Если cards<3 и есть giftPack — открывает его (free action).
 * Если после open всё равно <3 → возвращает ok=false.
 */
export async function ensureDeck (
  jwt: string,
  http: WotHttpClient
): Promise<EnsureDeckResult> {
  const userResp = await http.get(
    `${WOT_API_BASE}/api/v1/user/me`,
    { headers: authHeaders(jwt) }
  )
  const user = parseUserMe(userResp.data)

  let cardsResp = await http.get(
    `${WOT_API_BASE}/api/v1/cards/me`,
    { headers: authHeaders(jwt) }
  )
  let cardsCount = parseCardsMe(cardsResp.data)

  if (cardsCount >= 3) {
    return { ok: true, cardsCount, bootstrapped: false }
  }

  // cards < 3 — пробуем открыть giftPack
  if (!user.giftPacks.includes(STARTER_PACK_TYPE_ID)) {
    return {
      ok: false, cardsCount, bootstrapped: false,
      reason: `no cards (${cardsCount}) and no giftPack`
    }
  }

  try {
    await http.post(
      `${WOT_API_BASE}/api/v1/user/gift-packs/open`,
      { packIds: [STARTER_PACK_TYPE_ID] },
      { headers: authHeaders(jwt) }
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      ok: false, cardsCount, bootstrapped: false,
      reason: `gift-packs/open failed: ${msg}`
    }
  }

  // Re-fetch cards после open
  cardsResp = await http.get(
    `${WOT_API_BASE}/api/v1/cards/me`,
    { headers: authHeaders(jwt) }
  )
  cardsCount = parseCardsMe(cardsResp.data)

  if (cardsCount < 3) {
    return {
      ok: false, cardsCount, bootstrapped: true,
      reason: `gift opened but cards still insufficient (${cardsCount} < 3)`
    }
  }

  return { ok: true, cardsCount, bootstrapped: true }
}

// ============================================================
// HTTP WRAPPERS
// ============================================================

/**
 * Запрашивает прогресс квеста с Soneium portal API.
 *
 * Retry до PORTAL_RETRY_ATTEMPTS раз: на КАЖДОЙ попытке вызываем
 * `httpFactory()` чтобы получить НОВЫЙ HTTP-клиент со СВЕЖИМ прокси
 * (паттерн startale-gm). Один забаненный Cloudflare IP больше не зафейлит
 * весь модуль. Throws если все попытки провалились.
 */
export async function checkPortalProgress (
  httpFactory: () => WotHttpClient,
  address: Address
): Promise<QuestProgress> {
  let lastError = ''
  for (let attempt = 1; attempt <= PORTAL_RETRY_ATTEMPTS; attempt++) {
    try {
      const http = httpFactory()
      const url = `${SONEIUM_PORTAL_API}/profile/bonus-dapp?address=${address}`
      const response = await http.get(url)
      const data = response.data
      if (!Array.isArray(data)) {
        throw new Error(`Unexpected portal response shape: ${typeof data}`)
      }
      return parseQuestProgress(data, QUEST_INDEX)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`Portal API попытка ${attempt}/${PORTAL_RETRY_ATTEMPTS} (новый прокси) неудачна: ${lastError}`)
      if (attempt < PORTAL_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, PORTAL_RETRY_DELAY_MS))
      }
    }
  }
  throw new Error(`Не удалось проверить прогресс квеста после ${PORTAL_RETRY_ATTEMPTS} попыток: ${lastError}`)
}

export interface DailyStats {
  freeBattlesLimit: number
  freeBattlesRemaining: number
}

/**
 * GET /api/v1/battles/daily-stats + Bearer JWT.
 * Missing fields → 0 (defensive).
 */
export async function checkDailyStats (
  jwt: string,
  http: WotHttpClient
): Promise<DailyStats> {
  const response = await http.get(
    `${WOT_API_BASE}/api/v1/battles/daily-stats`,
    { headers: authHeaders(jwt) }
  )
  const raw = response.data as DailyStatsResponse
  return {
    freeBattlesLimit: typeof raw.freeBattlesLimit === 'number' ? raw.freeBattlesLimit : 0,
    freeBattlesRemaining: typeof raw.freeBattlesRemaining === 'number' ? raw.freeBattlesRemaining : 0
  }
}

// ============================================================
// WEBSOCKET ABSTRACTION
// ============================================================

export interface WsClientHandle {
  send (payload: string): void
  close (): void
}

export interface WsEvents {
  onOpen: () => void
  onMessage: (data: string) => void
  onError: (err: Error) => void
  onClose: () => void
}

export type WsFactory = (url: string, events: WsEvents) => WsClientHandle

/**
 * Default WS factory — использует `ws` package (dynamically imported для
 * test isolation — тесты override deps.wsFactory).
 *
 * WS ОБЯЗАТЕЛЬНО идёт через тот же прокси что и HTTP. Прямое соединение
 * с домашнего IP запрещено — webshare/CF/anti-fraud сервер WoT валит
 * сессии с IP-mismatch'ем (JWT выдан на proxy-IP, WS приходит с home-IP)
 * или rate-limit'ом по IP при нескольких параллельных wallet'ах.
 *
 * Туннель строится через `openProxyConnectTunnel` (undici). Для `wss://`
 * мы САМИ оборачиваем туннель в TLS (`tls.connect({ socket })`) и передаём
 * готовый TLSSocket в `ws` через опцию `createConnection`. КРИТИЧЕСКИ
 * ВАЖНО: `ws` v8.x НЕ оборачивает socket в TLS если задан `createConnection`
 * (см. node_modules/ws/lib/websocket.js, opts.createConnection || tlsConnect).
 * Без ручного TLS-wrap'а WebSocket handshake летит plaintext на TLS-порт 443
 * → Cloudflare возвращает `HTTP 400 — plain HTTP sent to HTTPS port`.
 */
function createDefaultWsFactory (proxy: ProxyConfig | null): WsFactory {
  return (url, events) => {
    let handle: WsClientHandle | null = null
    const pendingSends: string[] = []
    let closed = false
    void (async () => {
      try {
        if (!proxy) {
          throw new Error(
            'WS: прокси обязателен (direct connection запрещён). ' +
            'Убедитесь что performWorldOfTrinity подменяет d.wsFactory с прокси.'
          )
        }
        const parsedUrl = new URL(url)
        const host = parsedUrl.hostname
        const isSecure = parsedUrl.protocol === 'wss:'
        const port = Number.parseInt(parsedUrl.port, 10) ||
          (isSecure ? 443 : 80)

        const tunnel = await openProxyConnectTunnel(proxy, host, port)
        if (closed) { tunnel.destroy(); return }

        // Для wss:// оборачиваем туннель в TLS вручную и ждём secureConnect.
        // ws+createConnection НЕ накладывает TLS сам, поэтому без обёртки
        // CF/Cloudflare вернёт 400 на plaintext upgrade-request.
        let upstream: Socket
        if (isSecure) {
          const tlsSocket = tls.connect({
            socket: tunnel as unknown as Socket,
            servername: host,
            ALPNProtocols: ['http/1.1']
          })
          await new Promise<void>((resolve, reject) => {
            const onSecure = (): void => { cleanup(); resolve() }
            const onError = (err: Error): void => { cleanup(); reject(err) }
            const cleanup = (): void => {
              tlsSocket.off('secureConnect', onSecure)
              tlsSocket.off('error', onError)
            }
            tlsSocket.once('secureConnect', onSecure)
            tlsSocket.once('error', onError)
          })
          if (closed) { tlsSocket.destroy(); return }
          upstream = tlsSocket as unknown as Socket
        } else {
          upstream = tunnel as unknown as Socket
        }

        const { WebSocket } = await import('ws')
        if (closed) { upstream.destroy(); return }

        // Передаём готовый (TLS-обёрнутый для wss) socket через createConnection.
        // Дополнительные headers (User-Agent, Origin) имитируют браузер чтобы
        // не вылететь на CF bot-detection.
        const ws = new WebSocket(url, {
          createConnection: () => upstream,
          headers: {
            'User-Agent': pickRandomUserAgent(),
            Origin: 'https://app.worldoftrinity.com'
          }
        })
        ws.on('open', () => events.onOpen())
        ws.on('message', (data) => events.onMessage(data.toString()))
        ws.on('error', (err) => events.onError(err))
        ws.on('close', () => events.onClose())
        handle = {
          send: (payload) => ws.send(payload),
          close: () => ws.close()
        }
        for (const p of pendingSends) handle.send(p)
        pendingSends.length = 0
      } catch (err) {
        events.onError(err instanceof Error ? err : new Error(String(err)))
      }
    })()
    return {
      send: (p) => { if (handle) handle.send(p); else pendingSends.push(p) },
      close: () => { closed = true; if (handle) handle.close() }
    }
  }
}

// ============================================================
// RUN BATTLE VIA WS
// ============================================================

export interface BattleResult {
  matched: boolean
  roomId?: string
  error?: string
}

export interface RunBattleOptions {
  wsFactory: WsFactory
  openTimeoutMs: number
  timeoutMs: number
}

/**
 * Транзиентные WS-ошибки, которые имеет смысл retry'ить. Не включаем
 * matchmaking.* (это ответы сервера — повтор не поможет) и timeout'ы
 * (если matchmaking занимает >90s, это не транзиентная проблема).
 */
export function isTransientWsError (error: string | undefined): boolean {
  if (!error) return false
  return /ECONNRESET|EPIPE|closed unexpectedly|socket hang up/i.test(error)
}

/**
 * Одна попытка matchmaking через WS: connect → matchmaking.search →
 * matchmaking.matched. Возвращает результат вне зависимости от исхода.
 */
async function runBattleViaWSAttempt (
  jwt: string,
  opts: RunBattleOptions
): Promise<BattleResult> {
  const url = `${WOT_WS_URL_TEMPLATE}${jwt}`

  return new Promise<BattleResult>((resolve) => {
    let settled = false
    let handle: WsClientHandle | null = null
    let openTimer: NodeJS.Timeout | null = null
    let matchTimer: NodeJS.Timeout | null = null

    const finish = (result: BattleResult): void => {
      if (settled) return
      settled = true
      if (openTimer) clearTimeout(openTimer)
      if (matchTimer) clearTimeout(matchTimer)
      try { handle?.close() } catch { /* ignore */ }
      resolve(result)
    }

    const events: WsEvents = {
      onOpen: () => {
        if (settled) return
        if (openTimer) { clearTimeout(openTimer); openTimer = null }
        const payload = JSON.stringify({
          event: 'matchmaking.search',
          data: { training: false, realtime: true }
        })
        try { handle?.send(payload) } catch (err) {
          finish({ matched: false, error: `WS send failed: ${err instanceof Error ? err.message : err}` })
          return
        }
        matchTimer = setTimeout(
          () => finish({ matched: false, error: 'matchmaking timeout' }),
          opts.timeoutMs
        )
      },
      onMessage: (data) => {
        if (settled) return
        let parsed: unknown
        try { parsed = JSON.parse(data) } catch { return }
        if (!parsed || typeof parsed !== 'object') return
        const msg = parsed as Record<string, unknown>
        if (msg['event'] === 'matchmaking.matched') {
          const roomId = typeof msg['roomId'] === 'string' ? msg['roomId'] : undefined
          finish(roomId ? { matched: true, roomId } : { matched: true })
        } else if (msg['event'] === 'matchmaking.error') {
          const reason = typeof msg['reason'] === 'string' ? msg['reason'] : 'unknown'
          finish({ matched: false, error: `matchmaking.error: ${reason}` })
        }
        // ping/waiting/прочие события игнорируем
      },
      onError: (err) => finish({ matched: false, error: `WS error: ${err.message}` }),
      onClose: () => {
        if (!settled) finish({ matched: false, error: 'WS closed unexpectedly' })
      }
    }

    try {
      handle = opts.wsFactory(url, events)
    } catch (err) {
      finish({ matched: false, error: `WS factory failed: ${err instanceof Error ? err.message : err}` })
      return
    }

    openTimer = setTimeout(
      () => finish({ matched: false, error: 'WS open timeout' }),
      opts.openTimeoutMs
    )
  })
}

/**
 * Соединяется с WS, посылает matchmaking.search, ждёт matchmaking.matched
 * или matchmaking.error. WS закрывается сразу после matched.
 *
 * Backend portal-индексер сам зачитает квест "Join 3 games" даже если мы
 * не дожидаемся AutoLose — достаточно факта успешного matchmaking.matched.
 *
 * Wrapping retry: на транзиентных WS-ошибках (ECONNRESET, unexpected close)
 * повторяет попытку до `WS_RETRY_ATTEMPTS` раз с задержкой `WS_RETRY_DELAY_MS`.
 * Free battle на сервере тратится ТОЛЬКО после matchmaking.matched, поэтому
 * retry до этого события безопасен.
 */
export async function runBattleViaWS (
  jwt: string,
  opts: RunBattleOptions
): Promise<BattleResult> {
  let last: BattleResult = { matched: false, error: 'no attempts' }
  for (let attempt = 1; attempt <= WS_RETRY_ATTEMPTS; attempt++) {
    last = await runBattleViaWSAttempt(jwt, opts)
    if (last.matched) return last
    if (attempt < WS_RETRY_ATTEMPTS && isTransientWsError(last.error)) {
      logger.warn(
        `WS попытка ${attempt}/${WS_RETRY_ATTEMPTS} провалена: ${last.error}, ` +
        `retry через ${WS_RETRY_DELAY_MS}ms`
      )
      await new Promise(r => setTimeout(r, WS_RETRY_DELAY_MS))
      continue
    }
    return last
  }
  return last
}

// ============================================================
// MAIN
// ============================================================

/** DI для тестирования. Все поля optional — defaults в `defaultDeps`. */
export interface WorldOfTrinityDeps {
  authenticate?: typeof authenticate
  checkPortalProgress?: typeof checkPortalProgress
  ensureDeck?: typeof ensureDeck
  checkDailyStats?: typeof checkDailyStats
  runBattleViaWS?: typeof runBattleViaWS
  getProxy?: () => ProxyConfig | null
  createHttpClient?: (proxy: ProxyConfig) => WotHttpClient
  makeSigner?: (privateKey: `0x${string}`) => MessageSigner
  wsFactory?: WsFactory
  wsOpenTimeoutMs?: number
  wsMatchTimeoutMs?: number
}

const defaultDeps: Required<WorldOfTrinityDeps> = {
  authenticate,
  checkPortalProgress,
  ensureDeck,
  checkDailyStats,
  runBattleViaWS,
  getProxy: () => {
    const pm = ProxyManager.getInstance()
    if (!pm.hasProxies()) {
      throw new Error(
        'World of Trinity требует прокси: proxy.txt пуст или не содержит валидных записей.'
      )
    }
    return pm.getRandomProxy()
  },
  createHttpClient: createWotHttpClient,
  makeSigner: (pk) => privateKeyToAccount(pk),
  // Placeholder без прокси — performWorldOfTrinity ПЕРЕЗАПИШЕТ его на
  // proxy-aware factory как только resolve'нет proxy. Если пользователь
  // не override'нул wsFactory через deps, default'ный без proxy кинет
  // ошибку (что и ожидается — WS обязан идти через прокси).
  wsFactory: createDefaultWsFactory(null),
  wsOpenTimeoutMs: WS_OPEN_TIMEOUT_MS,
  wsMatchTimeoutMs: MATCHMAKING_TIMEOUT_MS
}

/**
 * Главный flow для квеста "Join 3 games":
 *  1. Portal → если 3/3 уже выполнен → skipped
 *  2. Auth → JWT
 *  3. ensureDeck → giftPack open если нужно
 *  4. checkDailyStats → если free battles = 0 → skipped
 *  5. WS matchmaking.search → ждём matchmaking.matched → success
 *
 * НЕ ждём AutoLose, НЕ опрашиваем carnival progress — backend portal
 * сам зачитает участие в battle (квест "Join 3 games") по факту матча.
 * За 3 запуска подряд (3 free battles в день) портал инкрементирует
 * "Join 3 games": 0/3 → 1/3 → 2/3 → 3/3.
 */
export async function performWorldOfTrinity (
  privateKey: `0x${string}`,
  deps: WorldOfTrinityDeps = {}
): Promise<WorldOfTrinityResult> {
  const d: Required<WorldOfTrinityDeps> = { ...defaultDeps, ...deps }
  const signer = d.makeSigner(privateKey)
  logger.info(`World of Trinity: запуск для ${signer.address}`)

  try {
    const proxy = d.getProxy()
    if (!proxy) {
      return { success: false, walletAddress: signer.address, error: 'Нет доступных прокси' }
    }
    const http = d.createHttpClient(proxy)

    // WS должен идти через тот же прокси что и HTTP — иначе сервер WoT
    // валит сессии с IP-mismatch или rate-limit'ом (см. createDefaultWsFactory).
    // Пользователь может override'нуть wsFactory через deps (для тестов) —
    // тогда не трогаем.
    if (deps.wsFactory == null) {
      d.wsFactory = createDefaultWsFactory(proxy)
    }

    // httpFactory создаёт новый HTTP-клиент со свежим прокси на каждый вызов.
    // Используется только portal pre-check для ротации прокси per retry attempt
    // (Cloudflare иногда блокирует определённые data-center IP'ы для portal API).
    // Auth/ensureDeck/dailyStats используют ОДИН стабильный `http` клиент — у них
    // сессия привязана к JWT и нет смысла менять прокси.
    const httpFactory = (): WotHttpClient => {
      const fresh = d.getProxy()
      return fresh ? d.createHttpClient(fresh) : http
    }

    // 1. Проверить прогресс квеста — если уже выполнен, не тратим попытки
    const portal = await d.checkPortalProgress(httpFactory, signer.address)
    if (!portal.found) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: 'Quest worldoftrinity_10 not active in current week'
      }
    }
    if (portal.isDone || portal.completed >= portal.required) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: `Quest already ${portal.completed}/${portal.required}`
      }
    }
    logger.info(`Quest progress: ${portal.completed}/${portal.required} → играем 1 battle`)

    // 2. Auth → JWT
    const jwt = await d.authenticate(signer, http)

    // 3. Bootstrap deck (giftPack open если cards<3)
    const deck = await d.ensureDeck(jwt, http)
    if (!deck.ok) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: deck.reason ?? 'deck unavailable'
      }
    }
    if (deck.bootstrapped) {
      logger.info(`Gift pack открыт, cards: ${deck.cardsCount}`)
    }

    // 4. Daily stats — если 0 free battles, нет смысла подключаться к WS
    const stats = await d.checkDailyStats(jwt, http)
    if (stats.freeBattlesRemaining === 0) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: 'Daily battle limit reached (0 free remaining)'
      }
    }
    logger.info(`Free battles remaining: ${stats.freeBattlesRemaining}/${stats.freeBattlesLimit}`)

    // 5. WS battle: matchmaking.search → matchmaking.matched → close
    const battle = await d.runBattleViaWS(jwt, {
      wsFactory: d.wsFactory,
      openTimeoutMs: d.wsOpenTimeoutMs,
      timeoutMs: d.wsMatchTimeoutMs
    })
    if (!battle.matched) {
      return {
        success: false, walletAddress: signer.address,
        error: battle.error ?? 'battle not matched'
      }
    }

    logger.info(`Matchmaking matched: roomId=${battle.roomId ?? '<unknown>'}`)
    return {
      success: true,
      walletAddress: signer.address,
      ...(battle.roomId ? { roomId: battle.roomId } : {}),
      message: `Battle started (matched), portal зачтёт +1 к "Join 3 games"`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка World of Trinity', msg)
    return { success: false, walletAddress: signer.address, error: msg }
  }
}

// ============================================================
// TESTING EXPORTS
// ============================================================

export const __testing = {
  pickRandomUserAgent,
  USER_AGENTS,
  WOT_API_BASE,
  WOT_WS_URL_TEMPLATE,
  SONEIUM_PORTAL_API,
  QUEST_DAPP_ID,
  QUEST_INDEX,
  QUEST_REQUIRED,
  STARTER_PACK_TYPE_ID,
  WS_RETRY_ATTEMPTS,
  WS_RETRY_DELAY_MS,
  authHeaders,
  createWotHttpClient,
  parseQuestProgress,
  createDefaultWsFactory,
  runBattleViaWSAttempt
}
