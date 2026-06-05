/**
 * HTTP CONNECT-туннель через webshare-прокси для WebSocket-сессий.
 *
 * Используется вместо `HttpsProxyAgent` потому что webshare возвращает
 * `403 client_connect_forbidden_host` на CONNECT через axios+https-proxy-agent
 * для `api.worldoftrinity.com` (см. createWotHttpClient в world-of-trinity.ts —
 * там та же причина миграции с axios на undici для HTTP).
 *
 * undici шлёт CONNECT через свой Client/Dispatcher и проходит webshare-фильтр.
 * Возвращённый Duplex передаётся в `ws` через опцию `createConnection`, после
 * чего `ws` (через `https.request` для `wss://`) делает TLS upgrade поверх него
 * и шлёт WebSocket-handshake.
 */
import { Client } from 'undici'
import type { Duplex } from 'node:stream'
import type { ProxyConfig } from '../proxy-manager.js'

/**
 * Открывает CONNECT-туннель через `proxy` до `targetHost:targetPort` и
 * возвращает Duplex-сокет, готовый для TLS upgrade.
 *
 * Не закрываем Client принудительно — это разорвало бы socket. Client
 * освобождается через GC после закрытия socket'а (см. `socket.once('close')`).
 *
 * @throws Error если proxy ответил не-2xx, AbortSignal сработал или сеть упала.
 */
export async function openProxyConnectTunnel (
  proxy: ProxyConfig,
  targetHost: string,
  targetPort: number,
  timeoutMs: number = 15_000
): Promise<Duplex> {
  const client = new Client(`http://${proxy.host}:${proxy.port}`, {
    connectTimeout: timeoutMs
  })
  const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
  const target = `${targetHost}:${targetPort}`
  try {
    const { socket, statusCode } = await client.connect({
      path: target,
      headers: {
        'proxy-authorization': `Basic ${auth}`,
        host: target
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (statusCode !== 200) {
      socket.destroy()
      void client.close().catch(() => { /* best-effort */ })
      throw new Error(`Proxy CONNECT failed: HTTP ${statusCode} for ${target}`)
    }
    // Закрываем Client лениво — когда socket закроется. Сейчас закрывать нельзя:
    // это разорвёт связь с активным socket'ом (он принадлежит pool'у Client'а).
    socket.once('close', () => { void client.close().catch(() => { /* best-effort */ }) })
    return socket
  } catch (err) {
    void client.close().catch(() => { /* best-effort */ })
    throw err instanceof Error ? err : new Error(String(err))
  }
}
