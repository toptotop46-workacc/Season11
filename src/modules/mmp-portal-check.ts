/**
 * MMP Portal Check — авторитетная проверка прогресса квеста
 * "Plant 3 corn seeds" через Soneium portal API.
 *
 * Используется модулями mmp-quest и mmp-farm (плюс может вызываться
 * из parallel-executor для pre-selection кошельков) — чтобы не выполнить
 * квест повторно на кошельках где он уже засчитан.
 *
 * Семантика портала: счётчик `completed` в quests[QUEST_INDEX]
 * инкрементируется на КАЖДЫЙ on-chain deposit в CornFarm. Соответственно
 * required=1 означает «нужен 1 deposit», и любой completed ≥ 1 значит
 * квест уже выполнен — повторные deposit'ы не нужны (и засоряют статистику
 * пользователя: 2/1, 4/1 и т.д.).
 *
 * Паттерн идентичен burrow-bash / startale-gm / world-of-trinity:
 *  - retry с ротацией прокси на каждой попытке (Cloudflare на portal.*
 *    периодически банит конкретные IP)
 *  - native axios.proxy (а не https-proxy-agent) — см. mmp-proxy.ts
 *    про bug с CONNECT auth
 *  - случайный UA из пула, чтобы не светить «один UA с 50 IP»
 */
import axios, { type AxiosInstance } from 'axios'
import type { Address } from 'viem'
import { logger } from '../logger.js'
import { ProxyManager, type ProxyConfig } from '../proxy-manager.js'

/** dappId квеста Morning Moon Pocket в Soneium S10. */
export const MMP_QUEST_DAPP_ID = 'morningmoon_10'
/** Индекс subtask в quests[] (0 = morningmoon_plant — единственный). */
export const MMP_QUEST_INDEX = 0

const SONEIUM_PORTAL_API = 'https://portal.soneium.org/api'
const PORTAL_HTTP_TIMEOUT_MS = 20_000
const PORTAL_RETRY_ATTEMPTS = 5
const PORTAL_RETRY_DELAY_MS = 2_000

const PORTAL_USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0'
]

function pickRandomPortalUserAgent (): string {
  return PORTAL_USER_AGENTS[Math.floor(Math.random() * PORTAL_USER_AGENTS.length)]!
}

function createPortalAxiosInstance (proxy: ProxyConfig): AxiosInstance {
  const proxyAgents = ProxyManager.getInstance().createProxyAgents(proxy)
  return axios.create({
    timeout: PORTAL_HTTP_TIMEOUT_MS,
    headers: {
      'User-Agent': pickRandomPortalUserAgent(),
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

interface PortalBonusDappQuest {
  id: string
  season: number
  quests: Array<{ required: number, completed: number, isDone: boolean }>
}

export interface MmpPortalQuestProgress {
  /** dapp morningmoon_10 найден в ответе portal (false = квест неактивен). */
  found: boolean
  isDone: boolean
  completed: number
  required: number
}

/**
 * Парсит ответ portal /api/profile/bonus-dapp.
 *
 * found=false означает «dapp morningmoon_10 отсутствует в ответе» —
 * вероятнее всего квест не активен на этой неделе.
 */
export function parseMmpPortalQuestProgress (
  bonusData: ReadonlyArray<PortalBonusDappQuest>
): MmpPortalQuestProgress {
  const dapp = bonusData.find(d => d.id === MMP_QUEST_DAPP_ID)
  if (!dapp) return { found: false, isDone: false, completed: 0, required: 0 }
  const quest = dapp.quests[MMP_QUEST_INDEX]
  if (!quest) return { found: true, isDone: false, completed: 0, required: 0 }
  return {
    found: true,
    isDone: quest.isDone,
    completed: quest.completed,
    required: quest.required
  }
}

/**
 * Запрос прогресса квеста через Soneium portal API.
 *
 * Retry с ротацией прокси: на каждой попытке вызываем `proxyProvider()`
 * чтобы получить свежий прокси. Это нужно потому что Cloudflare на
 * portal.soneium.org иногда блокирует конкретные IP, и без ротации
 * вся проверка фейлится из-за одного «битого» прокси.
 *
 * Бросает Error если все PORTAL_RETRY_ATTEMPTS попыток провалились.
 * Вызывающая сторона решает что делать (fail-fast vs fallback на on-chain).
 */
export async function fetchMmpPortalQuestProgress (
  proxyProvider: () => ProxyConfig,
  address: Address
): Promise<MmpPortalQuestProgress> {
  let lastError = ''
  for (let attempt = 1; attempt <= PORTAL_RETRY_ATTEMPTS; attempt++) {
    let axiosInstance: AxiosInstance
    try {
      axiosInstance = createPortalAxiosInstance(proxyProvider())
    } catch (provErr) {
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
      return parseMmpPortalQuestProgress(data as ReadonlyArray<PortalBonusDappQuest>)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`MMP portal API попытка ${attempt}/${PORTAL_RETRY_ATTEMPTS} неудачна (новый прокси на retry): ${lastError}`)
      if (attempt < PORTAL_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, PORTAL_RETRY_DELAY_MS))
      }
    }
  }
  throw new Error(`Не удалось проверить прогресс MMP-квеста после ${PORTAL_RETRY_ATTEMPTS} попыток: ${lastError}`)
}

/**
 * Helper для вызова из модулей: создаёт proxyProvider из ProxyManager
 * и возвращает progress. Падает с понятной ошибкой если proxy.txt пуст.
 */
export async function checkMmpPortalProgress (address: Address): Promise<MmpPortalQuestProgress> {
  const pm = ProxyManager.getInstance()
  if (!pm.hasProxies()) {
    throw new Error('MMP portal-check требует прокси: proxy.txt пуст')
  }
  const proxyProvider = (): ProxyConfig => {
    const p = pm.getRandomProxy()
    if (!p) throw new Error('Нет доступных прокси для portal API')
    return p
  }
  return await fetchMmpPortalQuestProgress(proxyProvider, address)
}

/** Export для тестов. */
export const __testing = {
  pickRandomPortalUserAgent,
  PORTAL_USER_AGENTS,
  SONEIUM_PORTAL_API,
  PORTAL_RETRY_ATTEMPTS,
  PORTAL_RETRY_DELAY_MS
}
