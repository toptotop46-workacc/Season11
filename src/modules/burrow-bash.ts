import type { Address } from 'viem'
import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import axios, { type AxiosInstance } from 'axios'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract, isDailyLimitRevert } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager, type ProxyConfig } from '../proxy-manager.js'

// ============================================================
// CONSTANTS
// ============================================================

/** BurrowBashDemo TransparentUpgradeableProxy на Soneium */
const CONTRACT_ADDRESS = '0x6f559dAaBce79d05E3Ae7B5Cf554296A0e094De2' as const

const CHAIN_ID = 1868

/** dappId квеста "Play 10 games" в Soneium S10 */
const QUEST_DAPP_ID = 'burrowbash_10'

const BURROW_API_BASE = 'https://startale-api.kyo.finance'
const SONEIUM_PORTAL_API = 'https://portal.soneium.org/api'

const HTTP_TIMEOUT_MS = 20_000
const PORTAL_RETRY_ATTEMPTS = 5
const PORTAL_RETRY_DELAY_MS = 2_000

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
 * Axios instance с прокси и случайным UA.
 * Использует тот же паттерн что и menu-system.ts.createStatsAxiosInstance.
 */
function createBurrowAxiosInstance (proxy: ProxyConfig): AxiosInstance {
  const proxyAgents = ProxyManager.getInstance().createProxyAgents(proxy)
  return axios.create({
    timeout: HTTP_TIMEOUT_MS,
    headers: {
      'User-Agent': pickRandomUserAgent(),
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

// ============================================================
// ABI
// ============================================================

const CONTRACT_ABI = [{
  inputs: [
    { name: 'preliminaryGameId', type: 'string' },
    { name: 'gameSeedHash',      type: 'bytes32' },
    { name: 'algoVersion',       type: 'string' },
    { name: 'gameConfig',        type: 'string' },
    { name: 'deadline',          type: 'uint256' },
    { name: 'serverSignature',   type: 'bytes' }
  ],
  name: 'createGame',
  outputs: [],
  stateMutability: 'payable',
  type: 'function'
}] as const

// ============================================================
// TYPES
// ============================================================

export interface BurrowBashResult {
  success: boolean
  walletAddress?: Address
  transactionHash?: `0x${string}`
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
  [key: string]: unknown
}

interface CreateGameApiResponse {
  preliminaryGameId: string
  gameSeedHash: `0x${string}`
  algoVersion: string
  gameConfig: string
  signatureDeadline: number
  serverSignature: `0x${string}`
  contractAddress: `0x${string}`
  daily_hammers_remaining: number
}

interface BonusDappQuest {
  id: string
  season: number
  quests: Array<{ required: number, completed: number, isDone: boolean }>
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
 * квеста burrowbash_10 (Play 10 games).
 *
 * Возвращает found=false если dapp отсутствует в ответе (значит не активен —
 * скорее всего уже не текущий week, надо в этом случае не делать tx).
 */
export function parseQuestProgress (
  bonusData: ReadonlyArray<BonusDappQuest>
): QuestProgress {
  const dapp = bonusData.find(d => d.id === QUEST_DAPP_ID)
  if (!dapp) {
    return { found: false, isDone: false, completed: 0, required: 0 }
  }
  const quest = dapp.quests[0]
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
// VALIDATION
// ============================================================

const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/ // 65 bytes ECDSA signature

export interface ValidationResult {
  ok: boolean
  error?: string
  hammersDepleted?: boolean
}

/**
 * Sanity-check ответа /api/game/create. Не доверяем серверу слепо: проверяем
 * что contractAddress, форматы подписи/хэша и deadline валидны, иначе откажемся
 * слать tx.
 */
export function validateCreateGameResponse (raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Empty/non-object API response' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r['contractAddress'] !== 'string' ||
      r['contractAddress'].toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
    return { ok: false, error: `contractAddress mismatch: got ${String(r['contractAddress'])}, expected ${CONTRACT_ADDRESS}` }
  }
  if (typeof r['preliminaryGameId'] !== 'string' || r['preliminaryGameId'].length === 0) {
    return { ok: false, error: 'Missing/invalid preliminaryGameId' }
  }
  if (typeof r['gameSeedHash'] !== 'string' || !HEX_BYTES32_RE.test(r['gameSeedHash'])) {
    return { ok: false, error: 'Invalid gameSeedHash format (expected 0x + 64 hex chars)' }
  }
  if (typeof r['algoVersion'] !== 'string' || r['algoVersion'].length === 0) {
    return { ok: false, error: 'Missing/invalid algoVersion' }
  }
  if (typeof r['gameConfig'] !== 'string' || r['gameConfig'].length === 0) {
    return { ok: false, error: 'Missing/invalid gameConfig' }
  }
  if (typeof r['serverSignature'] !== 'string' || !HEX_SIGNATURE_RE.test(r['serverSignature'])) {
    return { ok: false, error: 'Invalid serverSignature format (expected 0x + 130 hex chars)' }
  }
  if (typeof r['signatureDeadline'] !== 'number' || !Number.isFinite(r['signatureDeadline'])) {
    return { ok: false, error: 'Missing/invalid signatureDeadline' }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (r['signatureDeadline'] <= nowSec) {
    return { ok: false, error: `signatureDeadline already in past (${r['signatureDeadline']} <= now=${nowSec})` }
  }

  const hammers = typeof r['daily_hammers_remaining'] === 'number' ? r['daily_hammers_remaining'] : -1
  return { ok: true, hammersDepleted: hammers === 0 }
}

// ============================================================
// HTTP CALLS
// ============================================================

/**
 * Запрашивает прогресс квестов через Soneium portal API.
 *
 * Retry до PORTAL_RETRY_ATTEMPTS раз: на КАЖДОЙ попытке берём свежий прокси
 * через `proxyProvider()` и создаём новый axios instance. Это решает кейс,
 * когда конкретный IP-адрес прокси забанен на portal.soneium.org (Cloudflare),
 * и весь модуль фейлится только из-за одного «битого» прокси.
 *
 * Бросает Error если все попытки провалились.
 */
async function fetchQuestProgress (
  proxyProvider: () => ProxyConfig,
  address: Address
): Promise<QuestProgress> {
  let lastError = ''
  for (let attempt = 1; attempt <= PORTAL_RETRY_ATTEMPTS; attempt++) {
    let axiosInstance: AxiosInstance
    try {
      const proxy = proxyProvider()
      axiosInstance = createBurrowAxiosInstance(proxy)
    } catch (provErr) {
      // Если прокси-источник упал (например, нет прокси) — сразу throw, retry бесполезен.
      const msg = provErr instanceof Error ? provErr.message : String(provErr)
      throw new Error(`Не удалось получить прокси для portal API: ${msg}`)
    }
    try {
      const url = `${SONEIUM_PORTAL_API}/profile/bonus-dapp?address=${address}`
      const response = await axiosInstance.get(url)
      const data = response.data
      if (!Array.isArray(data)) {
        throw new Error(`Unexpected portal response shape: ${typeof data}`)
      }
      return parseQuestProgress(data)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`Portal API попытка ${attempt}/${PORTAL_RETRY_ATTEMPTS} неудачна (новый прокси на каждый retry): ${lastError}`)
      if (attempt < PORTAL_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, PORTAL_RETRY_DELAY_MS))
      }
    }
  }
  throw new Error(`Не удалось проверить прогресс квеста после ${PORTAL_RETRY_ATTEMPTS} попыток: ${lastError}`)
}

/**
 * POST /api/game/create — запрашивает у backend Burrow Bash подписанный
 * payload для одной игры.
 *
 * Без retry: если упало — fail-fast (executor подхватит на другом кошельке).
 */
async function requestSignedGame (
  axiosInstance: AxiosInstance,
  playerAddress: Address
): Promise<unknown> {
  const url = `${BURROW_API_BASE}/api/game/create`
  const body = { playerAddress, betAmountEth: '0', chainId: CHAIN_ID }
  const response = await axiosInstance.post(url, body)
  return response.data
}

const publicClient = rpcManager.createPublicClient(soneiumChain)

// ============================================================
// MAIN
// ============================================================

/**
 * Зависимости для DI/тестирования. Все поля опциональны — defaults
 * подставляются в performBurrowBash.
 */
export interface BurrowBashDeps {
  /**
   * Проверка прогресса квеста. Принимает функцию-источник прокси, которую
   * вызывают на КАЖДОЙ retry-попытке: это даёт ротацию прокси и снижает
   * шанс того, что один забаненный на Cloudflare IP зафейлит весь модуль.
   */
  fetchQuestProgress?: (proxyProvider: () => ProxyConfig, address: Address) => Promise<QuestProgress>
  requestSignedGame?: (axiosInstance: AxiosInstance, address: Address) => Promise<unknown>
  safeWriteContract?: typeof safeWriteContract
  waitForReceipt?: (hash: `0x${string}`) => Promise<{ status: 'success' | 'reverted' }>
  getEthBalance?: (address: Address) => Promise<bigint>
  simulateContract?: (params: Record<string, unknown>) => Promise<unknown>
  getProxy?: () => ProxyConfig | null
}

const defaultDeps: Required<BurrowBashDeps> = {
  fetchQuestProgress,
  requestSignedGame,
  safeWriteContract,
  waitForReceipt: async (hash) => {
    const r = await publicClient.waitForTransactionReceipt({ hash })
    return { status: r.status === 'success' ? 'success' : 'reverted' }
  },
  getEthBalance: (address) => publicClient.getBalance({ address }),
  simulateContract: (params) => publicClient.simulateContract(params as Parameters<typeof publicClient.simulateContract>[0]),
  getProxy: () => {
    const pm = ProxyManager.getInstance()
    if (!pm.hasProxies()) {
      throw new Error(
        'Burrow Bash требует прокси: proxy.txt пуст или не содержит валидных записей. ' +
        'Добавьте хотя бы один прокси в формате host:port:user:pass.'
      )
    }
    return pm.getRandomProxy()
  }
}

export async function performBurrowBash (
  privateKey: `0x${string}`,
  deps: BurrowBashDeps = {}
): Promise<BurrowBashResult> {
  const d: Required<BurrowBashDeps> = { ...defaultDeps, ...deps }
  const account = privateKeyToAccount(privateKey)
  logger.info(`Burrow Bash: запуск для ${account.address}`)

  try {
    // 1. Прокси (проверка наличия; фактическую ротацию делает fetchQuestProgress)
    const proxy = d.getProxy()
    if (!proxy) {
      return { success: false, walletAddress: account.address, error: 'Нет доступных прокси' }
    }
    // Фиксированный axios для /api/game/create — это fail-fast операция,
    // ротация не нужна (request уже несёт подпись и deadline).
    const axiosInstance = createBurrowAxiosInstance(proxy)

    // proxyProvider оборачивает d.getProxy с проверкой null для fetchQuestProgress
    const proxyProvider = (): ProxyConfig => {
      const p = d.getProxy()
      if (!p) throw new Error('Нет доступных прокси для portal API')
      return p
    }

    // 2. Прогресс квеста (с ротацией прокси per retry внутри fetchQuestProgress)
    const progress = await d.fetchQuestProgress(proxyProvider, account.address)
    if (!progress.found) {
      logger.warn('Квест burrowbash_10 не найден в portal — возможно неактивен')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: 'Quest burrowbash_10 not active in current week'
      }
    }
    if (progress.isDone || progress.completed >= progress.required) {
      logger.success(`Quest 10/10 уже выполнен (completed=${progress.completed}, isDone=${progress.isDone})`)
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: `Quest completed (${progress.completed}/${progress.required})`
      }
    }
    logger.info(`Quest progress: ${progress.completed}/${progress.required} → играем 1 game`)

    // 3. ETH баланс
    const balance = await d.getEthBalance(account.address)
    if (balance === 0n) {
      return { success: false, walletAddress: account.address, error: 'Недостаточно ETH для оплаты газа' }
    }
    logger.info(`ETH баланс: ${formatEther(balance)} ETH`)

    // 4. Запросить подписанный payload
    const rawApiResponse = await d.requestSignedGame(axiosInstance, account.address)
    const validation = validateCreateGameResponse(rawApiResponse)
    if (!validation.ok) {
      return { success: false, walletAddress: account.address, error: `Burrow API validation failed: ${validation.error}` }
    }
    if (validation.hammersDepleted) {
      logger.warn('daily_hammers_remaining=0 — лимит игр на сегодня')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: 'Daily hammers exhausted (0/10), wait for reset'
      }
    }

    const apiResp = rawApiResponse as CreateGameApiResponse
    const writeArgs = [
      apiResp.preliminaryGameId,
      apiResp.gameSeedHash,
      apiResp.algoVersion,
      apiResp.gameConfig,
      BigInt(apiResp.signatureDeadline),
      apiResp.serverSignature
    ] as const

    const contractParams = {
      chain: soneiumChain,
      account,
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'createGame' as const,
      args: writeArgs,
      value: 0n
    }

    // 5. simulate
    try {
      await d.simulateContract(contractParams as Record<string, unknown>)
    } catch (simError) {
      const msg = simError instanceof Error ? simError.message : String(simError)
      // Дневной лимит на on-chain стороне (селектор 0x106cfcb1) — это не fail.
      // API мог отдать `daily_hammers_remaining > 0` (stale-кэш), но контракт уже
      // знает реальное состояние. skipped=true, чтобы executor не считал THREAD_FAILED.
      if (isDailyLimitRevert(msg)) {
        logger.warn('Burrow Bash: дневной лимит исчерпан (on-chain revert 0x106cfcb1)')
        return {
          success: true,
          walletAddress: account.address,
          skipped: true,
          reason: 'Daily limit reached on-chain (createGame revert)'
        }
      }
      return { success: false, walletAddress: account.address, error: `Simulation failed: ${msg}` }
    }

    // 6. send
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const txResult = await d.safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      contractParams as Record<string, unknown>
    )

    if (!txResult.success) {
      const errMsg = txResult.error || 'safeWriteContract failed'
      // Race между pre-simulation (шаг 5) и внутренней симуляцией safeWriteContract:
      // API отдало swag что есть лимит, pre-sim прошла, но к моменту broadcast'а
      // on-chain state обновился и контракт ревертит 0x106cfcb1. Тогда
      // safeWriteContract вернёт {success: false, error: 'Симуляция: ...'} с
      // селектором в message. Ловим здесь как skip, а не fail.
      if (isDailyLimitRevert(errMsg)) {
        logger.warn('Burrow Bash: дневной лимит (safeWriteContract revert 0x106cfcb1)')
        return {
          success: true,
          walletAddress: account.address,
          skipped: true,
          reason: 'Daily limit reached on-chain (createGame revert)'
        }
      }
      return {
        success: false,
        walletAddress: account.address,
        error: errMsg
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'BURROW-BASH')

    // 7. receipt
    const receipt = await d.waitForReceipt(hash)
    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'BURROW-BASH', account.address)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash,
        message: `createGame отправлена (preliminaryGameId=${apiResp.preliminaryGameId})`
      }
    }
    logger.transaction(hash, 'failed', 'BURROW-BASH', account.address)
    return {
      success: false,
      walletAddress: account.address,
      transactionHash: hash,
      error: 'Transaction reverted'
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    // Подстраховка для thread-fail case: selector 0x106cfcb1 пробивается через
    // safeWriteContract в outer-catch. Распознаём и считаем skip.
    if (isDailyLimitRevert(msg)) {
      logger.warn('Burrow Bash: дневной лимит (on-chain revert 0x106cfcb1, в catch)')
      return {
        success: true,
        walletAddress: account.address,
        skipped: true,
        reason: 'Daily limit reached on-chain (createGame revert)'
      }
    }
    logger.error('Ошибка Burrow Bash', msg)
    return { success: false, walletAddress: account.address, error: msg }
  }
}

export const __testing = {
  pickRandomUserAgent,
  USER_AGENTS,
  CONTRACT_ADDRESS,
  CHAIN_ID,
  QUEST_DAPP_ID,
  BURROW_API_BASE,
  SONEIUM_PORTAL_API,
  CONTRACT_ABI,
  fetchQuestProgress,
  requestSignedGame,
  createBurrowAxiosInstance
}
