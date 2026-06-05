/**
 * Startale GM (Daily Check-In) — прямая EOA-транзакция.
 *
 * Flow (БЕЗ playwright / Smart Account / paymaster / UserOp):
 *  1. EOA → privateKeyToAccount.
 *  2. Portal bonus-dapp → quests[0] прогресс сезона. Если сезонный лимит
 *     достигнут (isDone || completed >= required, обычно 10/10) → skip,
 *     GM больше НЕ отправляется. Portal недоступен / квест не найден →
 *     fail-open (продолжаем; от дабла в день защищает on-chain guard ниже).
 *  3. On-chain DailyCheckIn.hasCheckedInToday(EOA) → если true → skip
 *     (контракт считает "сегодня" по UTC, reset в 00:00 UTC).
 *  4. Проверка баланса ETH на газ.
 *  5. simulateContract(checkIn) — AlreadyCheckedIn revert (0xd3d38ea7) → skip.
 *  6. safeWriteContract(checkIn) → waitForTransactionReceipt.
 *
 * Контракт DailyCheckIn (verified):
 *   https://soneium.blockscout.com/address/0x0B9f730bF4C1Bf1c0D5B548556a239d5eC0A1D3e
 *   function checkIn()                        // selector 0x183ff085
 *   function hasCheckedInToday(address) view  // selector 0x3504f52b
 *
 * Пример прямой EOA-транзакции (засчитывается порталом Startale):
 *   https://soneium.blockscout.com/tx/0x978b4eadf83ce5ba756420ccb524cce22e40089f1802f5dc12033f39cc39b3de
 */

import { parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { logger } from '../logger.js'
import { ProxyManager, type ProxyConfig } from '../proxy-manager.js'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyDoneRevert } from '../transaction-utils.js'

// ============================================================
// CONSTANTS
// ============================================================

/** Soneium portal — quest progress (прогресс сезона по GM). */
const SONEIUM_PORTAL_API = 'https://portal.soneium.org/api'

/** Origin для CF-friendly headers (browser-like). */
const STARTALE_ORIGIN = 'https://app.startale.com'

/**
 * GM-контракт на Soneium (DailyCheckIn, verified).
 *
 * Source: https://soneium.blockscout.com/address/0x0B9f730bF4C1Bf1c0D5B548556a239d5eC0A1D3e
 *   function checkIn()                        — selector 0x183ff085
 *   function hasCheckedInToday(address) view  — selector 0x3504f52b
 */
const GM_CONTRACT_ADDRESS: Address = '0x0B9f730bF4C1Bf1c0D5B548556a239d5eC0A1D3e'

/** ABI для write/simulate checkIn() (прямой вызов от EOA). */
const GM_ABI = [
  {
    inputs: [],
    name: 'checkIn',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

/** dappId квеста Startale в Soneium S10 (как в startale-invite.ts). */
const QUEST_DAPP_ID = 'startale_10'

/** Индекс subtask "Send Daily GM" в quests массиве. 0 = GM, 1 = Invite. */
const QUEST_INDEX_GM = 0

const HTTP_TIMEOUT_MS = 60_000
const HTTP_MAX_ATTEMPTS = 8

const PORTAL_RETRY_ATTEMPTS = 5
const PORTAL_RETRY_DELAY_MS = 3_000

// ============================================================
// HTTP HELPERS (undici + ProxyAgent — паттерн startale-invite)
// ============================================================

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0'
]

function pickRandomUserAgent (): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!
}

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Оставляет только первую непустую строку сообщения — viem/undici иногда
 * отдают многострочные ошибки (стек, call-log), которые загаживают лог.
 */
function firstLine (s: string): string {
  for (const line of s.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
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

/**
 * Backoff для 429/5xx — startale-invite-совместимая логика.
 */
function computeBackoffMs (status: number, retryAfterHeader: string | undefined, attempt: number): number {
  if (status === 429) {
    if (retryAfterHeader) {
      const ra = parseFloat(retryAfterHeader)
      if (Number.isFinite(ra) && ra > 0) return Math.min(120_000, Math.floor(ra * 1000))
    }
    return Math.min(120_000, 5_000 * Math.pow(2, Math.min(attempt, 5)))
  }
  return Math.min(60_000, 1_000 * Math.pow(2, attempt))
}

interface StartaleGmHttpClient {
  get: <T = unknown>(url: string, opts?: { headers?: Record<string, string> })
    => Promise<{ status: number, data: T }>
  /** Прокси-конфиг или null (если использовался прямой fetch). */
  proxy: ProxyConfig | null
}

/**
 * Создаёт HTTP клиент через undici ProxyAgent + native fetch.
 * Cloudflare на portal.soneium.org часто блокирует axios+https-proxy-agent с
 * 403; undici отправляет CONNECT-туннель с другим TLS fingerprint и проходит.
 *
 * Используется только для portal-API (/api/profile/bonus-dapp).
 */
function createStartaleGmHttpClient (proxy: ProxyConfig | null): StartaleGmHttpClient {
  const dispatcher = proxy
    ? new ProxyAgent({ uri: `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}` })
    : undefined
  const ua = pickRandomUserAgent()
  const baseHeaders: Record<string, string> = {
    'User-Agent': ua,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    Origin: STARTALE_ORIGIN,
    Referer: `${STARTALE_ORIGIN}/`,
    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    priority: 'u=1, i'
  }

  async function send (
    method: 'GET', url: string, extraHeaders?: Record<string, string>
  ): Promise<{ status: number, data: unknown, headers: Record<string, string> }> {
    let lastStatus = 0
    let lastData: unknown = null
    let lastHeaders: Record<string, string> = {}

    for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
      const init: Parameters<typeof undiciFetch>[1] = {
        method,
        headers: { ...baseHeaders, ...extraHeaders },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      }
      if (dispatcher) init.dispatcher = dispatcher

      let resp: Awaited<ReturnType<typeof undiciFetch>>
      try {
        resp = await undiciFetch(url, init)
      } catch (err) {
        if (attempt < HTTP_MAX_ATTEMPTS - 1) {
          const wait = computeBackoffMs(0, undefined, attempt)
          logger.warn(`[Startale GM] network error ${url}: ${err instanceof Error ? err.message : err} → retry ${(wait / 1000).toFixed(0)}s`)
          await sleep(wait)
          continue
        }
        throw err
      }
      lastStatus = resp.status
      lastData = await parseBodySafe(resp)
      lastHeaders = headersToObject(resp.headers)

      if (lastStatus === 429) {
        const wait = computeBackoffMs(lastStatus, lastHeaders['retry-after'], attempt)
        logger.warn(`[Startale GM] 429 ${url} → ${(wait / 1000).toFixed(0)}s (${attempt + 1}/${HTTP_MAX_ATTEMPTS})`)
        await sleep(wait)
        continue
      }
      if (lastStatus >= 500 && lastStatus < 600 && attempt < HTTP_MAX_ATTEMPTS - 1) {
        const wait = computeBackoffMs(lastStatus, undefined, attempt)
        logger.warn(`[Startale GM] HTTP ${lastStatus} → ${(wait / 1000).toFixed(0)}s`)
        await sleep(wait)
        continue
      }
      return { status: lastStatus, data: lastData, headers: lastHeaders }
    }
    return { status: lastStatus, data: lastData, headers: lastHeaders }
  }

  return {
    get: async <T,>(url: string, opts?: { headers?: Record<string, string> }) => {
      const r = await send('GET', url, opts?.headers)
      if (r.status >= 400) {
        throw new HttpResponseError(r.status, r.data, r.headers, `GET ${url} failed (${r.status})`)
      }
      return { status: r.status, data: r.data as T }
    },
    proxy
  }
}

// ============================================================
// PORTAL: Quest progress (прогресс сезона по GM)
// ============================================================

interface BonusDappQuest {
  id: string
  season: number
  quests: Array<{ required: number, completed: number, isDone: boolean }>
}

interface QuestProgress {
  found: boolean
  isDone: boolean
  completed: number
  required: number
}

/**
 * Парсер ответа /api/profile/bonus-dapp. Извлекает quests[QUEST_INDEX_GM]
 * у dapp 'startale_10' (subtask "Send Daily GM").
 *
 * found=false → dapp отсутствует (смена сезона / неактивен) → fail-open.
 */
function parseQuestProgress (
  bonusData: ReadonlyArray<BonusDappQuest>,
  questIndex: number = QUEST_INDEX_GM
): QuestProgress {
  const dapp = bonusData.find(d => d.id === QUEST_DAPP_ID)
  if (!dapp) return { found: false, isDone: false, completed: 0, required: 0 }
  const quest = dapp.quests[questIndex]
  if (!quest) return { found: true, isDone: false, completed: 0, required: 0 }
  return {
    found: true,
    isDone: quest.isDone,
    completed: quest.completed,
    required: quest.required
  }
}

/**
 * GET portal.soneium.org/api/profile/bonus-dapp?address=<eoa>.
 *
 * Retry до PORTAL_RETRY_ATTEMPTS раз: на КАЖДОЙ попытке `httpFactory()`
 * отдаёт НОВЫЙ HTTP-клиент со СВЕЖИМ прокси, чтобы один забаненный
 * Cloudflare IP не зафейлил проверку.
 */
async function checkPortalProgress (
  httpFactory: () => StartaleGmHttpClient,
  eoa: Address
): Promise<QuestProgress> {
  let lastError = ''
  for (let attempt = 1; attempt <= PORTAL_RETRY_ATTEMPTS; attempt++) {
    try {
      const http = httpFactory()
      const url = `${SONEIUM_PORTAL_API}/profile/bonus-dapp?address=${eoa}`
      const resp = await http.get(url)
      if (!Array.isArray(resp.data)) {
        throw new Error(`Unexpected portal response shape: ${typeof resp.data}`)
      }
      return parseQuestProgress(resp.data as ReadonlyArray<BonusDappQuest>)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      logger.warn(`[Startale GM] portal bonus-dapp #${attempt} (новый прокси): ${firstLine(lastError)}`)
      if (attempt < PORTAL_RETRY_ATTEMPTS) await sleep(PORTAL_RETRY_DELAY_MS)
    }
  }
  throw new Error(`portal bonus-dapp failed after ${PORTAL_RETRY_ATTEMPTS} attempts: ${lastError}`)
}

// ============================================================
// ON-CHAIN: hasCheckedInToday
// ============================================================

/**
 * On-chain idempotency check: вернёт `true` если EOA уже сделал GM в текущий
 * UTC-день. Verified ABI DailyCheckIn:
 *
 *   function hasCheckedInToday(address user) external view returns (bool)
 *
 * Контракт сам считает "сегодня" по `block.timestamp / 1 days`, reset 00:00 UTC.
 */
async function hasCheckedInToday (
  publicClient: PublicClient,
  address: Address
): Promise<boolean> {
  const abi = parseAbi(['function hasCheckedInToday(address) view returns (bool)'])
  return await publicClient.readContract({
    address: GM_CONTRACT_ADDRESS,
    abi,
    functionName: 'hasCheckedInToday',
    args: [address]
  }) as boolean
}

// ============================================================
// MODULE ENTRY
// ============================================================

export interface StartaleGmResult {
  success: boolean
  walletAddress?: Address
  transactionHash?: Hex
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  [key: string]: unknown
}

interface StartaleGmDeps {
  /** Создание HTTP клиента под portal API. */
  createHttpClient?: (proxy: ProxyConfig | null) => StartaleGmHttpClient
  /** Возвращает прокси для portal API или null если прямой fetch. */
  pickProxy?: () => ProxyConfig | null
  /** publicClient (RPC fallback через rpc-manager). */
  publicClient?: PublicClient
  /** Override portal-progress (для тестов). */
  checkPortalProgress?: typeof checkPortalProgress
  /** Override on-chain idempotency check (для тестов). */
  hasCheckedInToday?: typeof hasCheckedInToday
}

/**
 * Lazy-init publicClient через rpcManager (fallback на несколько RPC).
 */
let _defaultPublicClient: PublicClient | null = null
function getDefaultPublicClient (): PublicClient {
  if (!_defaultPublicClient) {
    _defaultPublicClient = rpcManager.createPublicClient(soneiumChain)
  }
  return _defaultPublicClient
}

function getDefaultDeps (): Required<StartaleGmDeps> {
  return {
    createHttpClient: createStartaleGmHttpClient,
    pickProxy: () => {
      const pm = ProxyManager.getInstance()
      if (!pm.hasProxies()) return null
      return pm.getRandomProxy()
    },
    publicClient: getDefaultPublicClient(),
    checkPortalProgress,
    hasCheckedInToday
  }
}

/**
 * Основной flow модуля startale-gm — прямой вызов checkIn() от EOA.
 *
 *  1. Portal bonus-dapp → если сезонный лимит достигнут (isDone ||
 *     completed >= required, обычно 10/10) → skip, GM НЕ отправляем.
 *     Portal недоступен / квест не найден → fail-open (продолжаем).
 *  2. On-chain hasCheckedInToday(EOA) → true → skip (reset 00:00 UTC).
 *  3. Баланс ETH на газ.
 *  4. simulateContract(checkIn) → AlreadyCheckedIn revert → skip.
 *  5. safeWriteContract(checkIn) → waitForTransactionReceipt.
 */
export async function performStartaleGm (
  privateKey: `0x${string}`,
  deps: StartaleGmDeps = {}
): Promise<StartaleGmResult> {
  const d: Required<StartaleGmDeps> = { ...getDefaultDeps(), ...deps }
  const owner = privateKeyToAccount(privateKey)
  const eoa = owner.address
  logger.info(`Startale GM: запуск для ${eoa}`)

  try {
    const walletClient = rpcManager.createWalletClient(soneiumChain, owner)
    // httpFactory создаёт новый HTTP-клиент со свежим прокси на каждый вызов
    // (ротация per retry attempt внутри checkPortalProgress).
    const httpFactory = (): StartaleGmHttpClient => d.createHttpClient(d.pickProxy())

    // 1. Сезонный лимит по порталу (БЛОКИРУЮЩАЯ проверка, fail-open на ошибке).
    //    Если уже выполнено 10+ GM в сезоне — больше не отправляем.
    try {
      const portal = await d.checkPortalProgress(httpFactory, eoa)
      if (portal.found && (portal.isDone || portal.completed >= portal.required)) {
        const reason = `Сезонный лимит GM достигнут (${portal.completed}/${portal.required}) → больше не отправляем`
        logger.info(`[Startale GM] ${reason}`)
        return { success: true, walletAddress: eoa, skipped: true, reason }
      }
      if (portal.found) {
        logger.info(`[Startale GM] прогресс сезона: ${portal.completed}/${portal.required}`)
      } else {
        logger.warn('[Startale GM] квест startale_10 не найден на портале (смена сезона?) → fail-open, продолжаю')
      }
    } catch (err) {
      const msg = firstLine(err instanceof Error ? err.message : String(err))
      logger.warn(`[Startale GM] portal недоступен (${msg}) → fail-open, продолжаю`)
    }

    // 2. On-chain дневная идемпотентность (reset 00:00 UTC).
    let alreadyToday = false
    try {
      alreadyToday = await d.hasCheckedInToday(d.publicClient, eoa)
    } catch (err) {
      const msg = firstLine(err instanceof Error ? err.message : String(err))
      logger.warn(`[Startale GM] hasCheckedInToday failed: ${msg} → продолжаю (защитит симуляция/revert)`)
    }
    if (alreadyToday) {
      const reason = 'GM уже отправлен сегодня on-chain (hasCheckedInToday=true, reset 00:00 UTC)'
      logger.info(`[Startale GM] ${reason} → skip`)
      return { success: true, walletAddress: eoa, skipped: true, reason }
    }

    // 3. Баланс ETH на газ.
    const balanceWei = await d.publicClient.getBalance({ address: eoa })
    if (balanceWei === 0n) {
      return { success: false, walletAddress: eoa, error: 'Недостаточно ETH для оплаты газа' }
    }

    // 4. Симуляция checkIn() — AlreadyCheckedIn (0xd3d38ea7) → skip.
    try {
      await d.publicClient.simulateContract({
        address: GM_CONTRACT_ADDRESS,
        abi: GM_ABI,
        functionName: 'checkIn',
        account: owner
      })
    } catch (simErr) {
      const m = firstLine(simErr instanceof Error ? simErr.message : String(simErr))
      if (isDailyDoneRevert(m)) {
        const reason = 'GM уже отправлен сегодня (AlreadyCheckedIn revert в симуляции)'
        logger.info(`[Startale GM] ${reason} → skip`)
        return { success: true, walletAddress: eoa, skipped: true, reason }
      }
      logger.error('[Startale GM] симуляция checkIn() упала', m)
      return { success: false, walletAddress: eoa, error: m, message: m }
    }

    // 5. Отправка транзакции checkIn() напрямую от EOA.
    const txResult = await safeWriteContract(
      d.publicClient,
      walletClient,
      eoa,
      {
        chain: soneiumChain,
        account: owner,
        address: GM_CONTRACT_ADDRESS,
        abi: GM_ABI,
        functionName: 'checkIn'
      }
    )

    if (!txResult.success) {
      const msg = txResult.error || 'Ошибка отправки транзакции'
      // AlreadyCheckedIn revert (0xd3d38ea7) — не ошибка, а «уже сделано сегодня».
      if (isDailyDoneRevert(msg)) {
        const reason = 'GM уже отправлен сегодня (revert detected)'
        logger.warn(`[Startale GM] ${reason}`)
        return { success: true, walletAddress: eoa, skipped: true, reason }
      }
      logger.error('[Startale GM] отправка не удалась', msg)
      return { success: false, walletAddress: eoa, error: msg, message: msg }
    }

    const hash = txResult.hash
    const receipt = await d.publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.success(`[Startale GM] GM отправлен и подтверждён on-chain (EOA=${eoa})`)
      logger.transaction(hash, 'confirmed', 'STARTALE_GM')
      return { success: true, walletAddress: eoa, transactionHash: hash, message: 'GM sent' }
    }

    return {
      success: false,
      walletAddress: eoa,
      transactionHash: hash,
      error: 'Транзакция не прошла (revert)',
      message: 'Транзакция отклонилась (revert)'
    }
  } catch (error) {
    const msg = firstLine(error instanceof Error ? error.message : 'Неизвестная ошибка')
    if (isDailyDoneRevert(msg)) {
      logger.warn('[Startale GM] GM уже отправлен сегодня (revert detected в catch)')
      return { success: true, walletAddress: eoa, skipped: true, reason: 'GM уже отправлен сегодня' }
    }
    logger.error('Ошибка Startale GM', msg)
    return { success: false, walletAddress: eoa, error: msg }
  }
}

export { GM_CONTRACT_ADDRESS, GM_ABI }
