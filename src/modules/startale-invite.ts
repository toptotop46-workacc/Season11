import type { Address } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../logger.js'
import { ProxyManager, type ProxyConfig } from '../proxy-manager.js'

// ============================================================
// CONSTANTS
// ============================================================

/**
 * DynamicAuth environment Startale (постоянный — не меняется между сезонами,
 * подтверждено образцом из Bonus_9 / Easters).
 */
const DYNAMIC_ENV_ID = '740c1c57-7fa3-4da0-99f7-bae832bfe159'
const DYNAMIC_BASE = `https://app.dynamicauth.com/api/v0/sdk/${DYNAMIC_ENV_ID}`

const STARTALE_API_BASE = 'https://api-app.startale.com/api/v1'
const ORIGIN = 'https://app.startale.com'

const SONEIUM_PORTAL_API = 'https://portal.soneium.org/api'

/** dappId квеста Startale в Soneium S10 */
const QUEST_DAPP_ID = 'startale_10'

/** Индекс subtask'а "Invite friend" в quests массиве (0 = GM, 1 = Invite) */
const QUEST_INDEX = 1

const CHAIN_ID = 1868

const HTTP_TIMEOUT_MS = 60_000
const HTTP_MAX_ATTEMPTS = 8

const PORTAL_RETRY_ATTEMPTS = 5
const PORTAL_RETRY_DELAY_MS = 3_000

/** Polling портала после регистрации invitee */
const PORTAL_POLL_TIMEOUT_MS = 7 * 60 * 1000  // 7 минут
const PORTAL_POLL_INTERVAL_MS = 22 * 1000      // 22 секунды
const PORTAL_POLL_JITTER_LO = 0.75
const PORTAL_POLL_JITTER_HI = 1.35

/** Pause между авторизацией main и invitee — anti-correlation (как в Bonus_9). */
const AUTH_GAP_MIN_MS = 14_000
const AUTH_GAP_MAX_MS = 42_000

/** Лимит ротации прокси при auth (как `BONUS9_REFERRAL_MAIN_PROXY_TRIES` / `BONUS9_REFERRAL_REF_PROXY_TRIES`). */
const AUTH_PROXY_ROTATION_MAX = 15

const PROXY_ROTATION_PAUSE_MIN_MS = 400
const PROXY_ROTATION_PAUSE_MAX_MS = 1_500

const PRE_AUTH_PAUSE_MIN_MS = 800
const PRE_AUTH_PAUSE_MAX_MS = 2_800

const POST_AUTH_PAUSE_MIN_MS = 350
const POST_AUTH_PAUSE_MAX_MS = 1_200

const PRE_REGISTER_PAUSE_MIN_MS = 400
const PRE_REGISTER_PAUSE_MAX_MS = 1_500

const POST_REGISTER_PAUSE_MIN_MS = 1_500
const POST_REGISTER_PAUSE_MAX_MS = 4_000

// ============================================================
// HTTP HELPERS
// ============================================================

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
]

function pickRandomUserAgent (): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!
}

/**
 * Axios-compatible HTTP клиент с .get/.post возвращающими `{ status, data }`.
 *
 * Используется undici-fetch (вместо axios) потому что webshare-прокси
 * блокируют axios+https-proxy-agent на portal.soneium.org/app.dynamicauth.com
 * с ответом `403 client_connect_forbidden_host`. undici отправляет CONNECT
 * туннель с другим TLS fingerprint и проходит фильтр (паттерн world-of-trinity).
 */
export interface StartaleHttpClient {
  get: <T = unknown>(url: string, opts?: { headers?: Record<string, string> })
    => Promise<{ status: number, data: T }>
  post: <T = unknown>(url: string, body: unknown, opts?: { headers?: Record<string, string> })
    => Promise<{ status: number, data: T }>
}

class HttpResponseError extends Error {
  response: { status: number, data: unknown, headers: Record<string, string> }
  constructor (status: number, data: unknown, headers: Record<string, string>, message: string) {
    super(message)
    this.name = 'HttpResponseError'
    this.response = { status, data, headers }
  }
}

async function parseBodySafe (resp: Awaited<ReturnType<typeof undiciFetch>>): Promise<unknown> {
  const text = await resp.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function headersToObject (h: Awaited<ReturnType<typeof undiciFetch>>['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => { out[k.toLowerCase()] = v })
  return out
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomBetween (minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs))
}

/**
 * Backoff для 429/5xx ответов DynamicAuth и Startale API.
 * Соответствует логике `_request_with_retry` из Bonus_9 startale_auth.py.
 */
function computeBackoffMs (status: number, retryAfterHeader: string | undefined, attempt: number): number {
  if (status === 429) {
    if (retryAfterHeader) {
      const ra = parseFloat(retryAfterHeader)
      if (Number.isFinite(ra) && ra > 0) return Math.min(120_000, Math.floor(ra * 1000))
    }
    return Math.min(120_000, 5_000 * Math.pow(2, Math.min(attempt, 5)))
  }
  // 5xx
  return Math.min(60_000, 1_000 * Math.pow(2, attempt))
}

/**
 * Создаёт HTTP клиент через undici ProxyAgent + native fetch.
 * Все запросы внутри клиента ретраятся при 429 и 5xx.
 */
function createStartaleHttpClient (proxy: ProxyConfig): StartaleHttpClient {
  const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
  const dispatcher = new ProxyAgent({ uri: proxyUrl })
  const ua = pickRandomUserAgent()
  const baseHeaders = {
    'User-Agent': ua,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`
  }

  async function send (
    method: 'GET' | 'POST', url: string, body: unknown, extraHeaders?: Record<string, string>
  ): Promise<{ status: number, data: unknown, headers: Record<string, string> }> {
    let lastStatus = 0
    let lastData: unknown = null
    let lastHeaders: Record<string, string> = {}

    for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
      const init: Parameters<typeof undiciFetch>[1] = {
        method,
        headers: { ...baseHeaders, ...extraHeaders },
        dispatcher,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      }
      if (method === 'POST' && body !== undefined) {
        init.body = JSON.stringify(body)
        init.headers = { ...init.headers, 'Content-Type': 'application/json' }
      }

      const resp = await undiciFetch(url, init)
      lastStatus = resp.status
      lastData = await parseBodySafe(resp)
      lastHeaders = headersToObject(resp.headers)

      if (lastStatus === 429) {
        const wait = computeBackoffMs(lastStatus, lastHeaders['retry-after'], attempt)
        logger.warn(`[Startale] 429 ${url} → пауза ${(wait / 1000).toFixed(0)}s (${attempt + 1}/${HTTP_MAX_ATTEMPTS})`)
        await sleep(wait)
        continue
      }
      if (lastStatus >= 500 && lastStatus < 600 && attempt < HTTP_MAX_ATTEMPTS - 1) {
        const wait = computeBackoffMs(lastStatus, undefined, attempt)
        logger.warn(`[Startale] HTTP ${lastStatus} → пауза ${(wait / 1000).toFixed(0)}s`)
        await sleep(wait)
        continue
      }
      return { status: lastStatus, data: lastData, headers: lastHeaders }
    }
    return { status: lastStatus, data: lastData, headers: lastHeaders }
  }

  return {
    get: async <T,>(url: string, opts?: { headers?: Record<string, string> }) => {
      const r = await send('GET', url, undefined, opts?.headers)
      if (r.status >= 400) {
        throw new HttpResponseError(r.status, r.data, r.headers, `GET ${url} failed with status ${r.status}`)
      }
      return { status: r.status, data: r.data as T }
    },
    post: async <T,>(url: string, body: unknown, opts?: { headers?: Record<string, string> }) => {
      const r = await send('POST', url, body, opts?.headers)
      if (r.status >= 400) {
        throw new HttpResponseError(r.status, r.data, r.headers, `POST ${url} failed with status ${r.status}`)
      }
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

export interface StartaleInviteResult {
  success: boolean
  walletAddress?: Address
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  inviteeAddress?: Address
  referralCode?: string
  [key: string]: unknown
}

interface BonusDappQuest {
  id: string
  season: number
  quests: Array<{ required: number, completed: number, isDone: boolean }>
}

interface NonceResponse {
  nonce: string
}

interface VerifyResponse {
  jwt?: string
  token?: string
  user?: {
    id?: string
    referral?: { referral_code?: string, referral_code_used?: string }
    [k: string]: unknown
  }
  [k: string]: unknown
}

interface StartaleUser {
  id?: string
  referral?: { referral_code?: string, referral_code_used?: string }
  [k: string]: unknown
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
 * subtask'а "Invite friend" (quests[1]) у dapp `startale_10`.
 *
 * found=false → dapp отсутствует в ответе (неактивен в текущей week) →
 * модуль должен skip и не делать действий.
 */
export function parseQuestProgress (
  bonusData: ReadonlyArray<BonusDappQuest>,
  questIndex: number = QUEST_INDEX
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
// AUTH RESPONSE VALIDATION
// ============================================================

export interface AuthValidationResult {
  ok: boolean
  token?: string
  user?: StartaleUser
  error?: string
}

/**
 * Sanity-check ответа /verify.
 * JWT должен содержать 3 base64url-сегмента через 2 точки (header.payload.sig).
 */
export function validateAuthVerifyResponse (raw: unknown): AuthValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Empty/non-object auth response' }
  }
  const obj = raw as VerifyResponse
  const token = obj.jwt ?? obj.token ?? obj.user?.['jwt']
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'Missing or invalid token field' }
  }
  const dotCount = (token.match(/\./g) ?? []).length
  if (dotCount !== 2) {
    return { ok: false, error: `Invalid JWT shape: expected 2 dots, got ${dotCount}` }
  }
  const user = obj.user && typeof obj.user === 'object' ? obj.user : undefined
  return { ok: true, token, ...(user ? { user } : {}) }
}

// ============================================================
// SIWE BUILDER
// ============================================================

/**
 * SIWE-сообщение точно по шаблону Easters/Bonus_9 (`startale_auth._build_siwe_message`).
 * Текст 1:1 (включая длинный preamble), порядок строк, отступы.
 *
 * Issued At: ISO-8601 c миллисекундами и Z. JS new Date().toISOString() даёт
 * именно `YYYY-MM-DDTHH:MM:SS.mmmZ` — формат совпадает с Python
 * datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z".
 */
export function buildSiweMessage (
  address: Address,
  nonce: string,
  issuedAt: string = new Date().toISOString()
): string {
  const lines = [
    'app.startale.com wants you to sign in with your Ethereum account:',
    address,
    '',
    'Welcome to Startale. Signing is the only way we can truly know that you are the owner of the wallet you are connecting. Signing is a safe, gas-less transaction that does not in any way give Startale permission to perform any transactions with your wallet.',
    '',
    `URI: ${ORIGIN}/log-in`,
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Request ID: ${DYNAMIC_ENV_ID}`
  ]
  return lines.join('\n')
}

// ============================================================
// JWT HELPERS
// ============================================================

/**
 * Распаковка payload JWT (base64url) без проверки подписи — нужно только
 * для извлечения user_id из claims если /user/me не отвечает.
 */
export function decodeJwtPayload (jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return {}
    const b64 = parts[1]!
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const normalized = padded.replace(/-/g, '+').replace(/_/g, '/')
    const raw = Buffer.from(normalized, 'base64').toString('utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Поиск user_id в claims JWT (см. `_extract_user_id_from_claims` в Bonus_9).
 * Startale кладёт ID в разные ключи в зависимости от версии Dynamic SDK.
 */
export function extractUserIdFromClaims (claims: Record<string, unknown>): string {
  const directKeys = ['startale_user_id', 'startaleUserId', 'user_id', 'userId']
  for (const k of directKeys) {
    const v = claims[k]
    if (typeof v === 'string' && v.length > 4) return v
  }
  const meta = claims['metadata']
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>
    for (const k of ['user_id', 'userId', 'id']) {
      const v = m[k]
      if (typeof v === 'string' && v.length > 4) return v
    }
  }
  const u = claims['user']
  if (u && typeof u === 'object') {
    const id = (u as Record<string, unknown>)['id']
    if (typeof id === 'string' && id.length > 0) return id
  }
  const sub = claims['sub']
  if (typeof sub === 'string' && sub.length >= 32 && (sub.match(/-/g) ?? []).length >= 4) return sub
  return ''
}

// ============================================================
// USER PROFILE PARSER
// ============================================================

/**
 * Разбор ответа GET /user/me. У Startale разные обёртки между версиями API:
 *   { user: {...} } или { data: { user: {...} } }
 */
export function parseUserMeResponse (raw: unknown): StartaleUser | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const direct = obj['user']
  if (direct && typeof direct === 'object') return direct as StartaleUser
  const inner = obj['data']
  if (inner && typeof inner === 'object') {
    const u = (inner as Record<string, unknown>)['user']
    if (u && typeof u === 'object') return u as StartaleUser
  }
  return null
}

// ============================================================
// AUTHENTICATION
// ============================================================

/**
 * Полный SIWE-flow аутентификации Startale через DynamicAuth.
 *   GET  /nonce  → {nonce}
 *   POST /connect {address, walletName: "metamask", chain: "EVM", provider: "browserExtension", authMode: "connect-and-sign"}
 *   локально: SIWE message + signMessage(EIP-191) → 0x-hex
 *   POST /verify {signedMessage, messageToSign, publicWalletAddress, network: "1868", ...} → {jwt, user?}
 *
 * Возвращает {jwt, verifyResponse}. verifyResponse часто содержит user.id.
 */
export async function authenticate (
  signer: MessageSigner,
  http: StartaleHttpClient
): Promise<{ jwt: string, verifyResponse: VerifyResponse }> {
  // Step 1: nonce
  const nonceResp = await http.get<NonceResponse>(`${DYNAMIC_BASE}/nonce`)
  const nonce = nonceResp.data?.nonce
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error(`auth nonce: invalid response (${JSON.stringify(nonceResp.data).slice(0, 200)})`)
  }

  // Step 2: /connect
  await http.post(`${DYNAMIC_BASE}/connect`, {
    address: signer.address,
    chain: 'EVM',
    provider: 'browserExtension',
    walletName: 'metamask',
    authMode: 'connect-and-sign'
  })

  // Step 3: build SIWE + sign
  const message = buildSiweMessage(signer.address, nonce)
  const signature = await signer.signMessage({ message })

  // Step 4: /verify
  const verifyResp = await http.post(`${DYNAMIC_BASE}/verify`, {
    signedMessage: signature,
    messageToSign: message,
    publicWalletAddress: signer.address,
    chain: 'EVM',
    walletName: 'metamask',
    walletProvider: 'browserExtension',
    network: String(CHAIN_ID),
    additionalWalletAddresses: []
  })
  const validation = validateAuthVerifyResponse(verifyResp.data)
  if (!validation.ok || !validation.token) {
    throw new Error(`auth verify failed: ${validation.error ?? 'unknown'}`)
  }

  return { jwt: validation.token, verifyResponse: verifyResp.data as VerifyResponse }
}

// ============================================================
// USER PROFILE RESOLUTION
// ============================================================

/**
 * Достаёт user-объект Startale.
 *   1. Если verify-response уже содержит user.id — возвращаем его.
 *   2. Иначе GET /user/me с retries (Startale-индексер async).
 *   3. Иначе extract user_id из JWT claims → GET /user/{id}.
 */
export async function resolveUserProfile (
  jwt: string,
  http: StartaleHttpClient,
  verifyResponse: VerifyResponse | null,
  meRetryAttempts: number = 8,
  meRetryDelayMs: number = 500
): Promise<StartaleUser | null> {
  // 1. Из verify
  if (verifyResponse?.user && typeof verifyResponse.user === 'object' && verifyResponse.user.id) {
    return verifyResponse.user
  }

  // 2. /user/me с retries
  for (let attempt = 0; attempt < meRetryAttempts; attempt++) {
    try {
      const resp = await http.get(`${STARTALE_API_BASE}/user/me`, { headers: authHeaders(jwt) })
      const user = parseUserMeResponse(resp.data)
      if (user && user.id) return user
    } catch {
      // continue
    }
    if (attempt < meRetryAttempts - 1) {
      await sleep(meRetryDelayMs + 150 * attempt)
    }
  }

  // 3. JWT claims → GET /user/{id}
  const claims = decodeJwtPayload(jwt)
  const uid = extractUserIdFromClaims(claims)
  if (uid) {
    try {
      const resp = await http.get(`${STARTALE_API_BASE}/user/${uid}`, { headers: authHeaders(jwt) })
      const obj = resp.data as { user?: StartaleUser } | undefined
      if (obj?.user && typeof obj.user === 'object') {
        logger.debug?.(`[Startale] профиль по JWT id=${uid.slice(0, 12)}…`)
        return obj.user
      }
    } catch {
      // ignore
    }
  }

  return null
}

/**
 * GET /user/{id} → user.referral.referral_code.
 * Возвращает undefined если код не найден.
 */
export async function getReferralCode (
  jwt: string,
  userId: string,
  http: StartaleHttpClient
): Promise<string | undefined> {
  if (!userId) return undefined
  try {
    const resp = await http.get(`${STARTALE_API_BASE}/user/${userId}`, { headers: authHeaders(jwt) })
    const obj = resp.data as { user?: StartaleUser } | undefined
    return obj?.user?.referral?.referral_code
  } catch (err) {
    logger.warn(`[Startale] реф.код: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * Регистрация invitee с referrer_code: POST /user.
 *
 * 200 → user объект (referral.referral_code_used должен совпадать с переданным кодом).
 * 409 Conflict → пытаемся прочитать профиль (бывает race с одновременным /user/me).
 */
export async function registerInvitee (
  jwt: string,
  http: StartaleHttpClient,
  referrerCode: string
): Promise<StartaleUser> {
  try {
    const resp = await http.post(
      `${STARTALE_API_BASE}/user`,
      { referrer_code: referrerCode },
      { headers: authHeaders(jwt) }
    )
    const obj = resp.data as { user?: StartaleUser } | undefined
    if (obj?.user && typeof obj.user === 'object') return obj.user
    return {}
  } catch (err) {
    if (err instanceof HttpResponseError && err.response.status === 409) {
      logger.debug?.('[Startale] POST /user 409 → повторный профиль')
      const profile = await resolveUserProfile(jwt, http, null)
      if (profile) return profile
      // последний шанс: ответ 409 может содержать user
      const errBody = err.response.data as { user?: StartaleUser } | undefined
      if (errBody?.user && typeof errBody.user === 'object') return errBody.user
    }
    throw err
  }
}

// ============================================================
// PORTAL CHECK
// ============================================================

/**
 * GET portal.soneium.org/api/profile/bonus-dapp?address=<addr> — прогресс
 * квестов адреса. Retry на network/5xx.
 *
 * Retry до PORTAL_RETRY_ATTEMPTS раз: на КАЖДОЙ попытке вызываем
 * `httpFactory()` чтобы получить НОВЫЙ HTTP-клиент со СВЕЖИМ прокси.
 * Один забаненный Cloudflare IP больше не зафейлит весь модуль (паттерн startale-gm).
 */
export async function checkPortalProgress (
  httpFactory: () => StartaleHttpClient,
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
      return parseQuestProgress(data as ReadonlyArray<BonusDappQuest>)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`Portal API попытка ${attempt}/${PORTAL_RETRY_ATTEMPTS} (новый прокси) неудачна: ${lastError}`)
      if (attempt < PORTAL_RETRY_ATTEMPTS) {
        await sleep(PORTAL_RETRY_DELAY_MS)
      }
    }
  }
  throw new Error(`Не удалось проверить прогресс квеста после ${PORTAL_RETRY_ATTEMPTS} попыток: ${lastError}`)
}

export interface PollPortalOptions {
  timeoutMs: number
  intervalMs: number
  jitterLo: number
  jitterHi: number
}

/**
 * Polling портала после регистрации invitee — ждём пока quests[1].isDone=true
 * у `startale_10` для main-адреса. Backend-индексер async, может не успеть
 * сразу после POST /user.
 *
 * `httpFactory` вызывается внутри `checkPortalProgress` на каждом retry attempt
 * и возвращает свежий HTTP-клиент со свежим прокси (паттерн startale-gm).
 *
 * Возвращает true если квест засчитан до timeout, false — если timeout.
 */
export async function pollPortalReferralDone (
  httpFactory: () => StartaleHttpClient,
  mainAddress: Address,
  opts: PollPortalOptions = {
    timeoutMs: PORTAL_POLL_TIMEOUT_MS,
    intervalMs: PORTAL_POLL_INTERVAL_MS,
    jitterLo: PORTAL_POLL_JITTER_LO,
    jitterHi: PORTAL_POLL_JITTER_HI
  }
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs
  let attempt = 0

  while (Date.now() < deadline) {
    attempt += 1
    try {
      const progress = await checkPortalProgress(httpFactory, mainAddress)
      if (progress.isDone || progress.completed >= progress.required) {
        return true
      }
    } catch (err) {
      logger.warn(`[Startale] portal poll #${attempt}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const waitMs = Math.floor(
      opts.intervalMs * (opts.jitterLo + Math.random() * (opts.jitterHi - opts.jitterLo))
    )
    if (Date.now() + waitMs >= deadline) break
    logger.info(`[Startale] portal жду ~${(waitMs / 1000).toFixed(0)}s #${attempt}`)
    await sleep(waitMs)
  }
  return false
}

// ============================================================
// PROXY ROTATION
// ============================================================

/** Ключ прокси для дедупликации/исключения (host:port). */
function proxyKey (p: ProxyConfig): string {
  return `${p.host}:${p.port}`
}

/** Маска прокси для логов (host:port без user/pass). */
function proxyHostPort (p: ProxyConfig): string {
  return proxyKey(p)
}

/**
 * Возвращает перемешанный список прокси из ProxyManager, исключая указанный.
 * Используется для ротации при auth — Cloudflare на app.dynamicauth.com блокирует
 * часть data-center'ов прокси (получаем 403 даже когда IP сам по себе работает).
 */
export function pickProxyCandidates (
  pm: ProxyManager,
  exclude?: ProxyConfig
): ProxyConfig[] {
  const all = pm.getAllProxies()
  const excludeKey = exclude ? proxyKey(exclude) : null
  const candidates = all.filter(p => proxyKey(p) !== excludeKey)
  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = candidates[i]!
    candidates[i] = candidates[j]!
    candidates[j] = tmp
  }
  return candidates
}

/**
 * Сheck transient ошибок auth-вызовов: следует пробовать другой прокси.
 *   - 403/451/429 — Cloudflare блокирует конкретный IP/data-center или rate-limit.
 *   - 5xx — серверная флакотерапия.
 *   - timeout/ECONN* — сетевые проблемы прокси.
 *
 * 4xx (кроме 403/451/429) — hard error, дальше пробовать бесполезно.
 */
export function isProxyTransientError (err: unknown): boolean {
  if (err instanceof HttpResponseError) {
    const s = err.response.status
    return s === 403 || s === 451 || s === 429 || (s >= 500 && s < 600)
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    return m.includes('timeout') ||
           m.includes('timed out') ||
           m.includes('econnrefused') ||
           m.includes('econnreset') ||
           m.includes('enetunreach') ||
           m.includes('econnaborted') ||
           m.includes('aborted') ||
           m.includes('network')
  }
  return false
}

export interface AuthRotationResult {
  jwt: string
  verifyResponse: VerifyResponse
  proxy: ProxyConfig
  http: StartaleHttpClient
}

/**
 * Auth с ротацией прокси. Перебирает candidates до первого успеха.
 * При transient ошибке (Cloudflare 403/timeout/...) переходит к следующему прокси.
 * При hard ошибке (например, неверная подпись) — пробрасывает.
 *
 * Соответствует логике из `do_referral`/Bonus_9 (проверка `_transient_proxy_error`
 * в цикле `for rot in range(...)`).
 */
export async function authenticateWithRotation (
  signer: MessageSigner,
  candidates: ProxyConfig[],
  createHttpClient: (proxy: ProxyConfig) => StartaleHttpClient,
  authFn: typeof authenticate,
  label: string,
  maxAttempts: number = AUTH_PROXY_ROTATION_MAX
): Promise<AuthRotationResult> {
  const tries = Math.min(maxAttempts, candidates.length)
  if (tries === 0) {
    throw new Error(`auth ${label}: нет прокси-кандидатов`)
  }
  let lastError: unknown = null
  for (let i = 0; i < tries; i++) {
    const proxy = candidates[i]!
    const http = createHttpClient(proxy)
    try {
      logger.info(`[Startale] auth ${label} попытка ${i + 1}/${tries} via ${proxyHostPort(proxy)}`)
      const result = await authFn(signer, http)
      return { jwt: result.jwt, verifyResponse: result.verifyResponse, proxy, http }
    } catch (err) {
      lastError = err
      if (isProxyTransientError(err) && i < tries - 1) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(`[Startale] auth ${label} via ${proxyHostPort(proxy)}: ${errMsg.slice(0, 120)} → следующий прокси`)
        await sleep(randomBetween(PROXY_ROTATION_PAUSE_MIN_MS, PROXY_ROTATION_PAUSE_MAX_MS))
        continue
      }
      throw err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`auth ${label}: все ${tries} прокси исчерпаны`)
}

// ============================================================
// MAIN
// ============================================================

/** DI для тестирования. Все поля optional — defaults в `defaultDeps`. */
export interface StartaleInviteDeps {
  authenticate?: typeof authenticate
  authenticateWithRotation?: typeof authenticateWithRotation
  resolveUserProfile?: typeof resolveUserProfile
  getReferralCode?: typeof getReferralCode
  registerInvitee?: typeof registerInvitee
  checkPortalProgress?: typeof checkPortalProgress
  pollPortalReferralDone?: typeof pollPortalReferralDone
  /** Возвращает перемешанный список прокси-кандидатов, исключая `exclude` если задан. */
  pickProxyCandidates?: (exclude?: ProxyConfig) => ProxyConfig[]
  createHttpClient?: (proxy: ProxyConfig) => StartaleHttpClient
  makeSigner?: (privateKey: `0x${string}`) => MessageSigner
  generateInviteeKey?: () => `0x${string}`
  pollOptions?: PollPortalOptions
  authGapMs?: { min: number, max: number }
  /** Лимит попыток ротации прокси на каждый auth (main и invitee отдельно). */
  authMaxAttempts?: number
}

const defaultDeps: Required<StartaleInviteDeps> = {
  authenticate,
  authenticateWithRotation,
  resolveUserProfile,
  getReferralCode,
  registerInvitee,
  checkPortalProgress,
  pollPortalReferralDone,
  pickProxyCandidates: (exclude) => {
    const pm = ProxyManager.getInstance()
    if (!pm.hasProxies()) {
      throw new Error('Startale Invite требует прокси: proxy.txt пуст или не содержит валидных записей.')
    }
    return pickProxyCandidates(pm, exclude)
  },
  createHttpClient: createStartaleHttpClient,
  makeSigner: (pk) => privateKeyToAccount(pk),
  generateInviteeKey: () => generatePrivateKey(),
  pollOptions: {
    timeoutMs: PORTAL_POLL_TIMEOUT_MS,
    intervalMs: PORTAL_POLL_INTERVAL_MS,
    jitterLo: PORTAL_POLL_JITTER_LO,
    jitterHi: PORTAL_POLL_JITTER_HI
  },
  authGapMs: { min: AUTH_GAP_MIN_MS, max: AUTH_GAP_MAX_MS },
  authMaxAttempts: AUTH_PROXY_ROTATION_MAX
}

/**
 * Главный flow реферального квеста Startale (`startale_10`/`quests[1]`):
 *  1. Pre-check портала → если уже isDone → skipped.
 *  2. Authenticate(main) с ротацией прокси → JWT_main → user_id → referral_code.
 *  3. Generate invitee privateKey (выбрасывается после регистрации).
 *  4. Pause 14-42s (anti-correlation).
 *  5. Authenticate(invitee) через прокси-кандидаты, исключая main proxy.
 *  6. POST /user {referrer_code} с JWT_invitee.
 *  7. Polling portal.soneium.org → ждём quests[1].isDone === true.
 *
 * Cloudflare на app.dynamicauth.com блокирует часть прокси по data-center
 * (403 на /nonce). При transient ошибке (403/timeout/5xx) меняем прокси и
 * повторяем — паттерн из Bonus_9 `do_referral`.
 *
 * Idempotency: проверяется только portal status (без локальной БД).
 */
export async function performStartaleInvite (
  privateKey: `0x${string}`,
  deps: StartaleInviteDeps = {}
): Promise<StartaleInviteResult> {
  const d: Required<StartaleInviteDeps> = { ...defaultDeps, ...deps }
  const signer = d.makeSigner(privateKey)
  logger.info(`Startale Invite: запуск для ${signer.address}`)

  try {
    // 1. Получить список прокси-кандидатов (≥2 разных)
    let allCandidates: ProxyConfig[]
    try {
      allCandidates = d.pickProxyCandidates()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(`[Startale] ${msg}`)
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: 'no proxies available'
      }
    }
    if (allCandidates.length < 2) {
      logger.warn(`[Startale] требуется ≥2 разных прокси: загружено ${allCandidates.length}`)
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: 'requires ≥2 different proxies'
      }
    }

    // 2. Pre-check портала с ротацией прокси per attempt — portal.soneium.org
    //    иногда тормозит/возвращает 5xx через определённые прокси (Cloudflare).
    //    httpFactory создаёт новый HTTP-клиент со свежим прокси на каждый вызов.
    const httpFactory = (): StartaleHttpClient => {
      const fresh = d.pickProxyCandidates()
      return d.createHttpClient(fresh[0]!)
    }
    logger.info(`[Startale] portal pre-check (с ротацией прокси per attempt)`)

    const portalBefore = await d.checkPortalProgress(httpFactory, signer.address)
    if (!portalBefore.found) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: `Quest ${QUEST_DAPP_ID} not active in current week`
      }
    }
    if (portalBefore.isDone || portalBefore.completed >= portalBefore.required) {
      return {
        success: true, walletAddress: signer.address, skipped: true,
        reason: `Quest already ${portalBefore.completed}/${portalBefore.required}`
      }
    }
    logger.info(`[Startale] quest progress: ${portalBefore.completed}/${portalBefore.required} → играем referral`)

    await sleep(randomBetween(PRE_AUTH_PAUSE_MIN_MS, PRE_AUTH_PAUSE_MAX_MS))

    // 3. Auth(main) с ротацией — Cloudflare может вернуть 403 на части прокси.
    const mainAuth = await d.authenticateWithRotation(
      signer, allCandidates, d.createHttpClient, d.authenticate, 'main', d.authMaxAttempts
    )
    const jwtMain = mainAuth.jwt
    const verifyMain = mainAuth.verifyResponse
    const httpMain = mainAuth.http
    const usedMainProxy = mainAuth.proxy
    logger.success(`[Startale] auth main OK via ${proxyHostPort(usedMainProxy)}`)

    await sleep(randomBetween(POST_AUTH_PAUSE_MIN_MS, POST_AUTH_PAUSE_MAX_MS))

    // 4. Resolve user_id и referral_code
    const userMain = await d.resolveUserProfile(jwtMain, httpMain, verifyMain)
    if (!userMain || !userMain.id) {
      return {
        success: false, walletAddress: signer.address,
        error: 'Не удалось получить user.id (Startale /user/me + JWT claims)'
      }
    }
    let refCode = userMain.referral?.referral_code
    if (!refCode) {
      refCode = await d.getReferralCode(jwtMain, userMain.id, httpMain)
    }
    if (!refCode) {
      return {
        success: false, walletAddress: signer.address,
        error: `Нет referral_code у ${signer.address} (user.id=${userMain.id})`
      }
    }
    logger.info(`[Startale] реф.код: ${refCode}`)

    await sleep(randomBetween(PRE_REGISTER_PAUSE_MIN_MS, PRE_REGISTER_PAUSE_MAX_MS))

    // 5. Generate invitee privateKey
    const inviteeKey = d.generateInviteeKey()
    const inviteeSigner = d.makeSigner(inviteeKey)
    logger.info(`[Startale] invitee: ${inviteeSigner.address}`)

    // 6. Pause 14-42s между main и invitee — anti-correlation
    const gapMs = randomBetween(d.authGapMs.min, d.authGapMs.max)
    logger.info(`[Startale] пауза ${(gapMs / 1000).toFixed(0)}s → invitee`)
    await sleep(gapMs)

    // 7. Auth(invitee) с ротацией, исключая main proxy
    const inviteeCandidates = d.pickProxyCandidates(usedMainProxy)
    if (inviteeCandidates.length === 0) {
      return {
        success: false, walletAddress: signer.address,
        error: 'нет прокси-кандидатов для invitee (отличных от main)'
      }
    }
    const inviteeAuth = await d.authenticateWithRotation(
      inviteeSigner, inviteeCandidates, d.createHttpClient, d.authenticate, 'invitee', d.authMaxAttempts
    )
    const jwtInvitee = inviteeAuth.jwt
    const httpInvitee = inviteeAuth.http
    logger.success(`[Startale] auth invitee OK via ${proxyHostPort(inviteeAuth.proxy)}`)

    await sleep(randomBetween(POST_AUTH_PAUSE_MIN_MS, POST_AUTH_PAUSE_MAX_MS))

    // 8. POST /user {referrer_code}
    const userInvitee = await d.registerInvitee(jwtInvitee, httpInvitee, refCode)
    const usedCode = userInvitee.referral?.referral_code_used
    if (usedCode) {
      logger.success(`[Startale] API OK ${refCode} → ${inviteeSigner.address} used=${usedCode}`)
    } else {
      logger.info(`[Startale] API регистрация ${inviteeSigner.address} → жду портал`)
    }

    await sleep(randomBetween(POST_REGISTER_PAUSE_MIN_MS, POST_REGISTER_PAUSE_MAX_MS))

    // 9. Polling portal с ротацией прокси per attempt (httpFactory).
    //    Свежий прокси per retry — резильентность к Cloudflare-блокировкам portal API.
    const counted = await d.pollPortalReferralDone(httpFactory, signer.address, d.pollOptions)
    if (!counted) {
      return {
        success: false, walletAddress: signer.address,
        inviteeAddress: inviteeSigner.address, referralCode: refCode,
        error: 'Portal timeout: реферальный квест не отметился за 7 минут'
      }
    }

    logger.success(`[Startale] портал OK ${signer.address}`)
    return {
      success: true,
      walletAddress: signer.address,
      inviteeAddress: inviteeSigner.address,
      referralCode: refCode,
      message: 'Referral counted'
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('Ошибка Startale Invite', msg)
    return { success: false, walletAddress: signer.address, error: msg }
  }
}

// ============================================================
// TESTING EXPORTS
// ============================================================

export const __testing = {
  pickRandomUserAgent,
  USER_AGENTS,
  DYNAMIC_ENV_ID,
  DYNAMIC_BASE,
  STARTALE_API_BASE,
  ORIGIN,
  CHAIN_ID,
  QUEST_DAPP_ID,
  QUEST_INDEX,
  SONEIUM_PORTAL_API,
  AUTH_PROXY_ROTATION_MAX,
  authHeaders,
  buildSiweMessage,
  parseQuestProgress,
  validateAuthVerifyResponse,
  parseUserMeResponse,
  decodeJwtPayload,
  extractUserIdFromClaims,
  computeBackoffMs,
  createStartaleHttpClient,
  randomBetween,
  pickProxyCandidates,
  isProxyTransientError,
  authenticateWithRotation,
  HttpResponseError
}
