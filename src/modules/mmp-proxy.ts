import type { AxiosProxyConfig } from 'axios'
import {
  ProxyManager,
  type ProxyConfig
} from '../proxy-manager.js'
import { MmpClient, type MmpClientOptions } from '../mmp-api/client.js'

/**
 * Конвертирует `ProxyConfig` из `ProxyManager` в `AxiosProxyConfig`.
 *
 * Используем axios-native proxy (а не https-proxy-agent) потому что
 * `HttpsProxyAgent@7.0.6` не пробрасывает basic auth в CONNECT для HTTPS
 * target'ов — на тех же кредах axios-native получает 200, а agent — 403.
 */
function toAxiosProxy (p: ProxyConfig): AxiosProxyConfig {
  return {
    host: p.host,
    port: p.port,
    auth: { username: p.username, password: p.password },
    protocol: 'http'
  }
}

/**
 * Пул User-Agent'ов для ротации вместе с прокси. Дублирует конвенцию
 * wowmax (каждый модуль держит свой локальный массив), чтобы
 * независимо подменять UA без зависимости от private метода ProxyManager.
 */
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

function proxyKey (proxy: ProxyConfig): string {
  return `${proxy.host}:${proxy.port}`
}

/**
 * Достать прокси из пула, исключая те, что уже помечены этим клиентом как
 * неработающие (`markedLocal`). Сначала пробуем `getUnusedProxy` (без
 * повторов в рамках прогона), падаем на `getRandomProxy` если пул
 * исчерпан/сброшен.
 */
function pickFreshProxy (
  pm: ProxyManager,
  markedLocal: Set<string>
): ProxyConfig | null {
  const total = pm.getProxyCount()
  if (total === 0) return null
  // До 2x попыток чтобы покрыть случай когда getUnusedProxy сбрасывает
  // internal used-set (после исчерпания) и возвращает уже использованный.
  for (let i = 0; i < total * 2; i++) {
    const p = pm.getUnusedProxy() ?? pm.getRandomProxy()
    if (!p) return null
    if (!markedLocal.has(proxyKey(p))) return p
  }
  return null
}

/**
 * Опции для `createMmpClientWithProxy`. Те же, что и у MmpClient, но без
 * опций, которыми управляет helper (userAgent/proxyAgents/onProxyError).
 */
export type MmpProxyClientOptions = Omit<
  MmpClientOptions,
  'userAgent' | 'proxyAgents' | 'onProxyError'
>

/**
 * Фабрика MmpClient с автоматической ротацией прокси.
 *
 * Стратегия (согласована с пользователем, см. RESEARCH_STATUS.md):
 *  - прокси выбирается через `getUnusedProxy` в рамках текущего прогона
 *    (один кошелёк = один прокси при старте; разные кошельки в одном батче
 *    получают разные прокси)
 *  - User-Agent ротируется вместе с прокси (чтобы сервер не видел
 *    «один UA с 50 IP»)
 *  - при HTTP 407/ECONNRESET/etc.: `markProxyAsUnhealthy` + swap на
 *    следующий «свежий» прокси → retry запроса. Повторяется пока пул
 *    не исчерпан.
 *  - если `proxy.txt` пуст или все прокси исчерпаны → fail-fast (throw).
 *
 * `MAX_PROXY_SWAPS_PER_REQUEST` (10) в MmpClient страхует от зацикливания
 * на случай багов в callback'е.
 */
export function createMmpClientWithProxy (
  privateKey: `0x${string}`,
  opts: MmpProxyClientOptions = {}
): MmpClient {
  const pm = ProxyManager.getInstance()
  if (!pm.hasProxies()) {
    throw new Error(
      'MMP требует прокси: proxy.txt пуст или не содержит валидных записей. ' +
      'Добавьте хотя бы один прокси в формате host:port:user:pass.'
    )
  }

  // Локальная «чёрная метка» — прокси, уже провалившиеся внутри ЭТОГО клиента.
  // Нужна потому что ProxyManager.getUnusedProxy НЕ учитывает health cache
  // (только getRandomProxyFast учитывает), и при сбросе used-set может вернуть
  // уже помеченный нездоровым прокси повторно.
  const markedLocal = new Set<string>()
  let current: ProxyConfig | null = pickFreshProxy(pm, markedLocal)
  if (!current) {
    throw new Error('MMP: не удалось выбрать прокси из пула (все уже помечены нерабочими)')
  }

  const client = new MmpClient(privateKey, {
    ...opts,
    userAgent: pickRandomUserAgent(),
    proxy: toAxiosProxy(current),
    onProxyError: () => {
      if (current) {
        pm.markProxyAsUnhealthy(current)
        markedLocal.add(proxyKey(current))
      }
      const next = pickFreshProxy(pm, markedLocal)
      if (!next) {
        // Пул исчерпан — fail-fast (ошибка прорвётся наверх из MmpClient).
        return false
      }
      current = next
      client.swapProxyAndUa(toAxiosProxy(next), pickRandomUserAgent())
      return true
    }
  })

  return client
}

/** Export для тестов. */
export const __testing = { pickFreshProxy, pickRandomUserAgent, proxyKey }
