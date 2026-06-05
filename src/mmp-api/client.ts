import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosProxyConfig,
  type AxiosResponse
} from 'axios'
import {
  decryptResponseData,
  decryptResponseJson,
  deriveAesKey,
  encryptRequestBody,
  generateRsaKeyPair
} from './crypto.js'
import type {
  AllowToEnterWildZoneData,
  BridgeInfoData,
  CharacterCreateBody,
  CharacterDefinition,
  ClientMissionProgressData,
  FarmSaveContent,
  InventoryClassTypeItem,
  InventoryExportImportBody,
  InventoryItemsData,
  InventoryPostResponseData,
  InventoryPriceData,
  LoginResponseData,
  MissionsListData,
  MmpEnvelope,
  PendingTransactionStatus,
  SaveFileBody,
  SaveFileResponseData,
  SignupResponseData,
  TutorialProgressBody,
  TutorialProgressResponseData,
  UnclejackCraftBody,
  WildCreateBody,
  WildCreateResponseData,
  WildDownloadTemplateBody,
  WildSaveBody,
  WildSaveContent,
  WildSaveNonceIssueBody,
  WildSaveNonceIssueResponseData
} from './types.js'

export const MMP_API_BASE = 'https://api-prod.morningmoonpocket.com/v1'
export const MMP_CLIENT_VERSION = '0.5.7'

const DEFAULT_HEADERS: Record<string, string> = {
  // Минимальные заголовки, которыми пользуется реальный Unity-клиент.
  // 'Content-Type: application/octet-stream' критично — иначе сервер парсит
  // тело иначе и отвергает зашифрованный JSON.
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Origin': 'https://play.morningmoonpocket.com',
  'Referer': 'https://play.morningmoonpocket.com/',
  'mmv-client-version': MMP_CLIENT_VERSION,
  'Content-Type': 'application/octet-stream'
}

/** Сообщение, которое подписывает игрок (EIP-191 personal_sign). */
function buildLoginMessage (address: string, loginNonce: number): string {
  const lower = address.toLowerCase()
  return [
    'Welcome to Morning Moon Pocket!',
    '',
    'Please sign in to enter the game.',
    `Account: ${lower}`,
    `Nonce: ${loginNonce}`
  ].join('\n')
}

/**
 * Кидает ошибку из envelope-ответа, если есть `errors`.
 * Это удобнее чем полагаться на http-статус (сервер часто ставит 200 с ошибкой,
 * либо 500 с осмысленной строкой в `errors`).
 */
function ensureOk<T> (resp: AxiosResponse<MmpEnvelope<T>>, context: string): T {
  const env = resp.data
  if (env?.errors) {
    throw new Error(`${context}: ${env.errors}`)
  }
  if (resp.status >= 400) {
    throw new Error(`${context}: HTTP ${resp.status}`)
  }
  return env.data
}

/**
 * Извлекает поле status из ответа /inventory/pending-transactions/{id}.
 *
 * Сервер заворачивает полезную нагрузку в дополнительный `data` слой,
 * поэтому реальный формат ответа: `{ data: { status: 'completed', ... } }`,
 * хотя `MmpEnvelope` уже сделал один unwrap. Эта функция терпимо относится
 * к обеим формам (с обёрткой и без), нормализует регистр в lowercase и
 * возвращает `null` если поле status отсутствует.
 *
 * Экспортирована и unit-тестируема изолированно от HTTP-слоя.
 */
export function readPendingTxStatus (resp: PendingTransactionStatus | null | undefined): string | null {
  if (resp == null) return null
  // Внутренний слой может лежать в .data (типичный путь сервера) или
  // в самом объекте (если сервер вдруг "выпрямит" ответ в будущем).
  const inner = (resp as { data?: { status?: unknown } }).data ?? resp
  const raw = (inner as { status?: unknown })?.status
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw.toLowerCase()
}

/** Default character — обычный безымянный villager (как в HAR-е реального клиента). */
export const DEFAULT_CHARACTER: CharacterDefinition = {
  gender: 1,
  head: 1,
  hair_color: 0,
  face: 1,
  body: 1,
  name: 'Villager',
  equipments: ['0', '0', '0', '0', '0', '0'],
  cosmetics: ['0', '0', '0', '0', '0', '0'],
  equipment_slots: ['', '', '', '', '', ''],
  cosmetic_slots: ['', '', '', '', '', ''],
  jewel_slots: ['', '', '', '', '', '', '', ''],
  locket_slots: ['', '', '']
}

export interface MmpClientOptions {
  baseUrl?: string
  countryCode?: string
  /** Переопределить User-Agent (иначе используется дефолтный из DEFAULT_HEADERS). */
  userAgent?: string
  /**
   * Конфигурация прокси в axios-native формате `{host, port, auth, protocol}`.
   *
   * Используется именно native axios `proxy` (а не https-proxy-agent) потому
   * что `https-proxy-agent@7.0.6` не передаёт basic auth в CONNECT-туннель
   * для HTTPS-target'ов, из-за чего прокси возвращает 403.
   * Подтверждено: `axios({proxy: {...auth}})` работает на тех же кредах, что
   * и curl-запрос через прокси.
   *
   * Helper `createMmpClientWithProxy` в `modules/mmp-proxy.ts` конвертирует
   * `ProxyConfig` из `ProxyManager` в эту форму.
   */
  proxy?: AxiosProxyConfig
  /**
   * Вызывается при обнаружении ошибки, похожей на проблему с прокси
   * (HTTP 407, ECONNREFUSED/ECONNRESET/ETIMEDOUT/EPROTO без ответа от сервера).
   *
   * Обработчик может внутри вызвать `swapProxyAndUa(...)` на клиенте, чтобы
   * сменить прокси, и вернуть `true` — тогда упавший запрос будет автоматически
   * повторён с новыми agents/UA. Если обработчик вернёт `false` (или бросит),
   * ошибка проброшена вверх как обычно.
   *
   * Используется один раз на каждый упавший запрос (flag config.__mmpRetried),
   * чтобы избежать бесконечного цикла при повторных проблемах.
   */
  onProxyError?: () => boolean | Promise<boolean>
}

/**
 * Определяет, похожа ли ошибка axios на проблему с прокси.
 * Экспортировано для unit-тестов и переиспользования.
 *
 * Признаки:
 *  - HTTP 407 (Proxy Authentication Required)
 *  - Отсутствие response + сетевой код ECONNREFUSED/ECONNRESET/ETIMEDOUT/EPROTO
 *    (типичные симптомы мёртвого прокси)
 *  - ECONNABORTED + 'timeout' в message — axios превысил `timeout`, часто
 *    из-за медленного прокси (категория F failed.txt: MMP wild/quest 20s timeout).
 *  - ERR_BAD_RESPONSE + 'stream has been aborted' — прокси/upstream закрыл
 *    соединение посреди стриминга тела ответа (категория F failed.txt:
 *    wildCreate/download. В этом кейсе axios УЖЕ получил status+headers,
 *    поэтому `axErr.response` set'нут — нужна отдельная ветка, иначе
 *    проверка `!axErr.response` ниже пропустит этот класс ошибок).
 */
export function isProxyFaultError (error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  const axErr = error as AxiosError
  if (axErr.response?.status === 407) return true
  // Stream aborted mid-body: response объект set, поэтому не попадает в
  // ветку `!axErr.response`. Матчимся по message чтобы не зацепить
  // другие ERR_BAD_RESPONSE кейсы (maxContentLength exceeded и т.п.).
  if (axErr.code === 'ERR_BAD_RESPONSE' &&
      /stream has been aborted/i.test(String(axErr.message ?? ''))) {
    return true
  }
  if (!axErr.response && typeof axErr.code === 'string') {
    const code = axErr.code
    return code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EPROTO' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_BAD_REQUEST' && /proxy/i.test(String(axErr.message ?? ''))
  }
  return false
}

/**
 * Stateful API-клиент Morning Moon Pocket.
 *
 * Использование:
 *   const client = new MmpClient(privateKey)
 *   await client.signup()
 *   await client.login()
 *   await client.createCharacter()
 *   await client.tutorialProgress(1)
 *   const bridgeInfo = await client.getBridgeInfo()
 */
export class MmpClient {
  private readonly http: AxiosInstance
  private readonly account: ReturnType<typeof privateKeyToAccount>
  private readonly rsa = generateRsaKeyPair()
  private readonly screenUid = randomBytes(5).toString('hex')
  private readonly machineFingerprint = Math.floor(Math.random() * 1_000_000_000).toString()

  /** Установлен после login(). 32-байтный AES-256 ключ. */
  private aesKey: Buffer | null = null
  /** Установлен после login(). MongoDB-ObjectID-like session token. */
  private sessionToken: string = randomBytes(20).toString('hex')

  /**
   * Опциональный callback, дергается при подозрении на проблему с прокси
   * (HTTP 407 или сетевая ошибка без response). Должен подменить прокси через
   * `swapProxyAndUa(...)` и вернуть `true`, чтобы упавший запрос автоматически
   * переиграли. Если вернёт `false` — ошибка пробрасывается наверх.
   */
  private onProxyError?: () => boolean | Promise<boolean>

  public readonly countryCode: string

  /** Максимум попыток смены прокси в рамках одного запроса (защита от зацикливания). */
  private static readonly MAX_PROXY_SWAPS_PER_REQUEST = 10

  constructor (
    private readonly privateKey: `0x${string}`,
    options: MmpClientOptions = {}
  ) {
    this.account = privateKeyToAccount(privateKey)
    this.countryCode = options.countryCode ?? 'MYS'
    if (options.onProxyError) this.onProxyError = options.onProxyError
    const userAgent = options.userAgent ?? DEFAULT_HEADERS['User-Agent']!
    this.http = axios.create({
      baseURL: options.baseUrl ?? MMP_API_BASE,
      // 45s — устойчиво к медленным прокси (категория F failed.txt: 20s слишком
      // мало для прохождения mmp wild/quest через ряд webshare data-center'ов).
      // При timeout сработает onProxyError swap (см. isProxyFaultError) и retry.
      timeout: 45_000,
      // Сервер ставит status 5xx с полезным телом — не считаем это исключением,
      // обработка идёт через ensureOk (читает envelope.errors).
      validateStatus: () => true,
      headers: { ...DEFAULT_HEADERS, 'User-Agent': userAgent, 'mmv-x-session-token': this.sessionToken },
      proxy: options.proxy ?? false
    })
    this.installProxyInterceptor()
  }

  /**
   * Response interceptor, выявляющий падения прокси и переигрывающий запрос
   * с новыми agents/UA (если установлен onProxyError, который выдаёт swap).
   */
  private installProxyInterceptor (): void {
    this.http.interceptors.response.use(
      async (response) => {
        // validateStatus=() => true → 407 приходит в success path.
        if (response.status === 407) {
          const retried = await this.retryOnProxyFault(response.config)
          if (retried) return retried
        }
        return response
      },
      async (error) => {
        if (isProxyFaultError(error)) {
          const retried = await this.retryOnProxyFault((error as AxiosError).config)
          if (retried) return retried
        }
        throw error
      }
    )
  }

  /**
   * Вызывается при подозрении на проблему с прокси. Запрашивает swap у
   * `onProxyError`; если получен, переигрывает запрос с обновлённым прокси/UA.
   * Возвращает `null` если swap невозможен → ошибка пробрасывается наверх.
   */
  private async retryOnProxyFault (
    config: (AxiosResponse['config']) | undefined
  ): Promise<AxiosResponse | null> {
    if (!config) return null
    if (!this.onProxyError) return null
    const cfg = config as typeof config & { __mmpRetryCount?: number }
    const count = cfg.__mmpRetryCount ?? 0
    if (count >= MmpClient.MAX_PROXY_SWAPS_PER_REQUEST) return null
    const ok = await this.onProxyError()
    if (!ok) return null
    cfg.__mmpRetryCount = count + 1
    // Подтягиваем актуальные proxy/UA (они были обновлены swapProxyAndUa
    // внутри onProxyError).
    const defaultProxy = this.http.defaults.proxy
    if (defaultProxy !== undefined) cfg.proxy = defaultProxy
    const defaultUa = (this.http.defaults.headers as Record<string, string>)['User-Agent']
    if (cfg.headers && defaultUa) {
      (cfg.headers as Record<string, string>)['User-Agent'] = defaultUa
    }
    return this.http.request(cfg)
  }

  /**
   * Сменить прокси и User-Agent у клиента на лету. Все последующие запросы
   * (и переигранные через interceptor) пойдут через новый прокси.
   *
   * Вызывайте из `onProxyError` чтобы реализовать «swap до исчерпания пула».
   */
  public swapProxyAndUa (proxy: AxiosProxyConfig, userAgent: string): void {
    this.http.defaults.proxy = proxy
    ;(this.http.defaults.headers as Record<string, string>)['User-Agent'] = userAgent
  }

  get address (): `0x${string}` {
    return this.account.address
  }

  get isLoggedIn (): boolean {
    return this.aesKey !== null
  }

  /** Возвращает текущий session token (обновляется после login). */
  get session (): string {
    return this.sessionToken
  }

  private setSessionToken (token: string): void {
    this.sessionToken = token
    // axios сохраняет дефолтные заголовки в нескольких местах. При создании
    // через axios.create({headers: {...}}) headers попадают в `defaults.headers`,
    // и `headers.common` отдельно. Перезаписываем оба варианта чтобы гарантировать
    // что сервер получит актуальный mmv-x-session-token.
    this.http.defaults.headers.common['mmv-x-session-token'] = token
    ;(this.http.defaults.headers as Record<string, string>)['mmv-x-session-token'] = token
  }

  // ============================================================
  // 1) AUTH FLOW
  // ============================================================

  /** POST /client/auth/signup — выдаёт loginNonce. */
  async signup (): Promise<SignupResponseData> {
    const resp = await this.http.post<MmpEnvelope<SignupResponseData>>(
      '/client/auth/signup',
      JSON.stringify({ addressHex: this.account.address })
    )
    return ensureOk(resp, 'signup')
  }

  /**
   * POST /client/auth/login. Возвращает loginData + извлекает AES-ключ и
   * заменяет sessionToken. После этого можно делать зашифрованные запросы.
   */
  async login (loginNonce: number): Promise<LoginResponseData> {
    const message = buildLoginMessage(this.account.address, loginNonce)
    const signature = await this.account.signMessage({ message })

    const body = JSON.stringify({
      loginType: 'metamask',
      addressHex: this.account.address,
      playerKey: this.rsa.publicKeyPem,
      signature,
      machineFingerprint: this.machineFingerprint,
      screenUID: this.screenUid
    })

    interface RawLogin { meta?: { ak: string }, data: string, errors?: string }
    const resp = await this.http.post<RawLogin>('/client/auth/login', body)
    if (resp.data.errors) {
      throw new Error(`login: ${resp.data.errors}`)
    }
    if (resp.status >= 400) {
      throw new Error(`login: HTTP ${resp.status}`)
    }
    if (!resp.data.meta?.ak || !resp.data.data) {
      throw new Error('login: malformed response (missing meta.ak or data)')
    }

    this.aesKey = deriveAesKey(resp.data.meta.ak, this.rsa.privateKey)
    const decrypted = decryptResponseJson<LoginResponseData>(resp.data.data, this.aesKey)
    this.setSessionToken(decrypted.sessionToken)
    return decrypted
  }

  /** Удобный wrapper: сделать signup, затем login за один вызов. */
  async signupAndLogin (): Promise<LoginResponseData> {
    const signupData = await this.signup()
    return this.login(signupData.user.loginNonce)
  }

  // ============================================================
  // 2) TX QUOTA / CHARACTER / TUTORIAL
  // ============================================================

  /** POST /tx-quota/{addr}/claim — без тела, просто фиксирует suscription для сессии. */
  async claimTxQuota (): Promise<void> {
    const resp = await this.http.post<MmpEnvelope<unknown>>(
      `/tx-quota/${this.account.address}/claim`,
      '{}'
    )
    // Сервер возвращает status_code=0 на успех; ошибки бывают в errors.
    if (resp.data?.errors) throw new Error(`tx-quota/claim: ${resp.data.errors}`)
  }

  /**
   * POST /client/{addr}/character — создаёт персонажа. Передаётся как
   * зашифрованное тело. Это **необходимый шаг** перед `tutorialProgress`,
   * иначе сервер вернёт `nonce validation failed - not found`.
   */
  async createCharacter (character: CharacterDefinition = DEFAULT_CHARACTER): Promise<{ remainging: number }> {
    this.assertLoggedIn()
    const body: CharacterCreateBody = { character, countryCode: this.countryCode }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      `/client/${this.account.address}/character`,
      encrypted
    )
    const data = ensureOk(resp, 'createCharacter')
    return JSON.parse(this.decryptStr(data)) as { remainging: number }
  }

  /**
   * POST /client/tutorial/progress — обновляет шаг туториала.
   * @param progress - номер шага (1, 2, 3, ...). Сервер сам приведёт нумерацию.
   * @param nonceStepIndex - часть nonce после двоеточия. Для первого шага = 0.
   *
   * Пример: progress=1, nonceStepIndex=0 → body `{progress:1,nonce:"<addr>:0"}`.
   */
  async tutorialProgress (
    progress: number,
    nonceStepIndex: number = 0
  ): Promise<TutorialProgressResponseData> {
    this.assertLoggedIn()
    const body: TutorialProgressBody = {
      progress,
      nonce: `${this.account.address}:${nonceStepIndex}`
    }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      '/client/tutorial/progress',
      encrypted
    )
    const data = ensureOk(resp, 'tutorialProgress')
    return JSON.parse(this.decryptStr(data)) as TutorialProgressResponseData
  }

  /** Текущий состояние tutorial (GET). Возвращает {progress: N}. */
  async getTutorialProgress (): Promise<{ progress: number }> {
    const resp = await this.http.get<MmpEnvelope<{ progress: number }>>(
      '/client/tutorial/progress'
    )
    return ensureOk(resp, 'getTutorialProgress')
  }

  // ============================================================
  // 3) BRIDGE / INVENTORY (read-only / pricing)
  // ============================================================

  /** GET /inventory/bridge/info — квоты на export/import. */
  async getBridgeInfo (): Promise<BridgeInfoData> {
    const resp = await this.http.get<MmpEnvelope<BridgeInfoData>>(
      '/inventory/bridge/info'
    )
    return ensureOk(resp, 'getBridgeInfo')
  }

  /**
   * POST /inventory/exports/price (plain JSON) — возвращает цену export'а.
   * Цена 0.0001 ETH (1e14 wei) за единицу обычно.
   */
  async getExportsPrice (
    items: InventoryClassTypeItem[],
    nfts: unknown[] = []
  ): Promise<InventoryPriceData> {
    const resp = await this.http.post<MmpEnvelope<InventoryPriceData>>(
      '/inventory/exports/price',
      JSON.stringify({ items, nfts })
    )
    return ensureOk(resp, 'getExportsPrice')
  }

  /** POST /inventory/imports/price (plain JSON). */
  async getImportsPrice (
    items: InventoryClassTypeItem[],
    nfts: unknown[] = []
  ): Promise<InventoryPriceData> {
    const resp = await this.http.post<MmpEnvelope<InventoryPriceData>>(
      '/inventory/imports/price',
      JSON.stringify({ items, nfts })
    )
    return ensureOk(resp, 'getImportsPrice')
  }

  /** GET /inventory/items — текущие in-game items (Crop20-токены etc.). */
  async getInventoryItems (): Promise<InventoryItemsData> {
    const resp = await this.http.get<MmpEnvelope<InventoryItemsData>>(
      '/inventory/items?amount=10000&page=1'
    )
    return ensureOk(resp, 'getInventoryItems')
  }

  /** GET /inventory/resources — Stone/Wood/Leather и т.п. */
  async getInventoryResources (): Promise<InventoryItemsData> {
    const resp = await this.http.get<MmpEnvelope<InventoryItemsData>>(
      '/inventory/resources?amount=100&page=1'
    )
    return ensureOk(resp, 'getInventoryResources')
  }

  /** GET /inventory/nfts. */
  async getInventoryNfts (): Promise<InventoryItemsData> {
    const resp = await this.http.get<MmpEnvelope<InventoryItemsData>>(
      '/inventory/nfts?amount=1000000&page=1'
    )
    return ensureOk(resp, 'getInventoryNfts')
  }

  // ============================================================
  // 3.5) BRIDGE OUT/IN — финализирующие POST после Escrow.deposit
  //      `transactionId` берётся из event Deposited (см. mmp-api/escrow.ts).
  // ============================================================

  /**
   * POST /inventory/exports — финализирует bridge OUT (in-game items → on-chain токены).
   *
   * @param transactionId — decimal-строка от Escrow.deposit (event Deposited.transactionId)
   * @param items — какие in-game items списать
   * @param nfts  — список NFT id (обычно пусто для семян)
   *
   * Тело **plain JSON** (НЕ зашифровано). Это подтверждено сигнатурой
   * `InventoryExport(string transactionId, List<string> nfts, List<(int,int,int)> items, ...)`
   * из IL2CPP-дампа.
   */
  async inventoryExport (
    transactionId: string | bigint,
    items: InventoryClassTypeItem[],
    nfts: string[] = []
  ): Promise<InventoryPostResponseData> {
    const body: InventoryExportImportBody = {
      items,
      nfts,
      transaction_id: typeof transactionId === 'bigint'
        ? transactionId.toString()
        : transactionId
    }
    const resp = await this.http.post<MmpEnvelope<InventoryPostResponseData>>(
      '/inventory/exports',
      JSON.stringify(body)
    )
    return ensureOk(resp, 'inventoryExport')
  }

  /**
   * POST /inventory/imports — финализирует bridge IN (on-chain токены → in-game items).
   * Использование симметрично `inventoryExport`.
   */
  async inventoryImport (
    transactionId: string | bigint,
    items: InventoryClassTypeItem[],
    nfts: string[] = []
  ): Promise<InventoryPostResponseData> {
    const body: InventoryExportImportBody = {
      items,
      nfts,
      transaction_id: typeof transactionId === 'bigint'
        ? transactionId.toString()
        : transactionId
    }
    const resp = await this.http.post<MmpEnvelope<InventoryPostResponseData>>(
      '/inventory/imports',
      JSON.stringify(body)
    )
    return ensureOk(resp, 'inventoryImport')
  }

  /**
   * GET /inventory/pending-transactions/{id} — статус pending-транзакции.
   * id может быть `pending_transaction_id`, `tx_queue_id` или `queue_id`
   * (сервер возвращает один из них в ответе на /exports или /imports).
   */
  async getPendingTransaction (
    id: string
  ): Promise<PendingTransactionStatus> {
    const resp = await this.http.get<MmpEnvelope<PendingTransactionStatus>>(
      `/inventory/pending-transactions/${encodeURIComponent(id)}`
    )
    return ensureOk(resp, 'getPendingTransaction')
  }

  /**
   * Polling /inventory/pending-transactions/{id} до тех пор, пока статус
   * не станет терминальным (completed/failed/refunded/cancelled).
   *
   * @param id — pending_transaction_id или tx_queue_id
   * @param options.timeoutMs — общий таймаут (default 120000 = 2 мин,
   *   как `GenerateEscrowTransactionId timeout after 2 minutes` в C#-коде)
   * @param options.intervalMs — пауза между запросами (default 2500ms)
   */
  async waitForPendingTransaction (
    id: string,
    options: { timeoutMs?: number, intervalMs?: number } = {}
  ): Promise<PendingTransactionStatus> {
    const timeoutMs = options.timeoutMs ?? 120_000
    const intervalMs = options.intervalMs ?? 2_500
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const status = await this.getPendingTransaction(id)
      const s = readPendingTxStatus(status) ?? ''
      if (s === 'completed' || s === 'success' || s === 'released') return status
      if (s === 'failed' || s === 'refunded' || s === 'cancelled' || s === 'reverted') {
        throw new Error(`pending tx ${id} в финальном статусе ${s}`)
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    throw new Error(`pending tx ${id} не финализировался за ${timeoutMs}ms`)
  }

  // ============================================================
  // 4) NPC craft — реальный путь получения семян on-chain
  // ============================================================

  /**
   * POST /npc/unclejack/craft — крафтит recipe и сервер пускает в pending-tx-queue.
   * После status=completed сервер выполняет on-chain mint Crop20 ERC-20 на кошелёк
   * (видно в Soneium-blockscout: Token Mint event from 0x000 to wallet).
   *
   * Без ресурсов сервер ответит `"resource index=N not found"`.
   *
   * Recipe ids (см. /v1/archive/npc.uncle_jack):
   *   1: Tomato Seed за 15 Wood     (default tutorial path)
   *   2: Corn Seed   за 15 Stone    (default tutorial path)
   *   3: Tomato Seed за 6 Leather
   *   4: Corn Seed   за 15 Copper
   *   5: Cabbage Seed за 9 Copper + 4 Leather
   *   6: Cabbage Seed за 6 Iron + 4 Leather
   *
   * `amounts` множитель: amounts=[3] на recipe=2 → burn 45 stone → mint 3 CORNSEED.
   */
  async unclejackCraft (body: UnclejackCraftBody): Promise<InventoryPostResponseData> {
    const resp = await this.http.post<MmpEnvelope<InventoryPostResponseData>>(
      '/npc/unclejack/craft',
      JSON.stringify(body)
    )
    return ensureOk(resp, 'unclejackCraft')
  }

  // ============================================================
  // 5) SAVEFILE — POST /client/{addr}/savefile, GET /client/{addr}/savefile
  //    Используется для farmSaveData.json (плантации) и wild-save-data.json
  // ============================================================

  /**
   * GET /client/{addr}/savefile?fileName=... — возвращает сохранённый файл.
   * Сервер отвечает 404 (errors='mongo: no documents in result') для свежего кошелька.
   *
   * @returns содержимое (распарсенный объект) или null если файла нет
   */
  async getSaveFile<T = FarmSaveContent | WildSaveContent> (fileName: string): Promise<T | null> {
    const resp = await this.http.get<MmpEnvelope<SaveFileResponseData>>(
      '/client/' + this.account.address + '/savefile',
      { params: { fileName } }
    )
    if (resp.data?.errors) {
      const e = String(resp.data.errors).toLowerCase()
      if (e.includes('not found') || e.includes('no documents')) return null
      throw new Error(`getSaveFile: ${resp.data.errors}`)
    }
    if (resp.status >= 400) throw new Error(`getSaveFile: HTTP ${resp.status}`)
    const sf = resp.data?.data?.saveFile
    if (!sf) return null
    return JSON.parse(sf.content) as T
  }

  /**
   * POST /client/{addr}/savefile — сохраняет содержимое файла (зашифровано).
   *
   * Тело: `{saveFile: {fileName, content: <stringified JSON>}}`. Содержимое — JSON.stringify
   * объекта `FarmSaveContent`/`WildSaveContent`.
   *
   * Используется для:
   *  - `farmSaveData.json` — структура `FarmSaveContent` с placements/decorations
   *  - `UserData/wild-save-data.json` — `WildSaveContent` с actions/obj_map
   */
  async postSaveFile (
    fileName: string,
    content: FarmSaveContent | WildSaveContent | Record<string, unknown>
  ): Promise<SaveFileResponseData> {
    this.assertLoggedIn()
    const body: SaveFileBody = {
      saveFile: { fileName, content: JSON.stringify(content) }
    }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      '/client/' + this.account.address + '/savefile',
      encrypted
    )
    const data = ensureOk(resp, 'postSaveFile')
    return JSON.parse(this.decryptStr(data)) as SaveFileResponseData
  }

  /** Удобный wrapper: загрузить farmSaveData.json (или null). */
  async getFarmSave (): Promise<FarmSaveContent | null> {
    return this.getSaveFile<FarmSaveContent>('farmSaveData.json')
  }

  /** Удобный wrapper: сохранить farmSaveData.json. */
  async postFarmSave (content: FarmSaveContent): Promise<SaveFileResponseData> {
    return this.postSaveFile('farmSaveData.json', content)
  }

  // ============================================================
  // 6) WILD ZONE
  // ============================================================

  /** GET /client/allowtoenterwildzone — проверка доступа (energy/буфы и т.п.). */
  async allowToEnterWildZone (): Promise<AllowToEnterWildZoneData> {
    const resp = await this.http.get<MmpEnvelope<AllowToEnterWildZoneData>>(
      '/client/allowtoenterwildzone'
    )
    return ensureOk(resp, 'allowToEnterWildZone')
  }

  /**
   * POST /wild/create (plain) — стартует wild-сессию, возвращает зашифрованный seed.
   * После расшифровки получаем integer-seed для RNG-генерации карты.
   *
   * @param mapNo — карта (1 = "the crossing")
   * @returns integer seed (parseInt от plaintext)
   */
  async wildCreate (mapNo: number = 1): Promise<{ seedRaw: string, seedInt: number }> {
    const body: WildCreateBody = {
      map_no: mapNo,
      version_map: MMP_CLIENT_VERSION,
      captcha_token: '',
      captcha_verification_tier: 1
    }
    const resp = await this.http.post<MmpEnvelope<WildCreateResponseData>>(
      '/wild/create',
      JSON.stringify(body)
    )
    const data = ensureOk(resp, 'wildCreate')
    if (!this.aesKey) throw new Error('wildCreate: aesKey not set')
    const seedDecrypted = decryptResponseData(data.seed, this.aesKey).trim()
    const seedInt = Number.parseInt(seedDecrypted, 10)
    if (!Number.isFinite(seedInt)) {
      throw new Error(`wildCreate: cannot parse seed "${seedDecrypted}"`)
    }
    return { seedRaw: data.seed, seedInt }
  }

  /**
   * POST /wild/download/wildtemplate (encrypted) — возвращает map template.
   * Это огромный JSON (~460 KB) с tile-grid, fixed_object и wild_pattern_pool[].
   *
   * Возвращаем как `unknown`, поскольку парсинг template зависит от RNG-логики
   * (см. research/wild/template-map1.json для примера).
   */
  async wildDownloadTemplate (mapNo: number = 1, wildSaveFileId: string = ''): Promise<unknown> {
    this.assertLoggedIn()
    const body: WildDownloadTemplateBody = {
      map_no: mapNo,
      version_map: MMP_CLIENT_VERSION,
      wild_save_file_id: wildSaveFileId
    }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      '/wild/download/wildtemplate',
      encrypted
    )
    const data = ensureOk(resp, 'wildDownloadTemplate')
    return JSON.parse(this.decryptStr(data))
  }

  /** POST /wild/wildsavenonce/issue (encrypted) — выдаёт инкрементный nonce. */
  async wildSaveNonceIssue (): Promise<number> {
    this.assertLoggedIn()
    const body: WildSaveNonceIssueBody = { d: 0 }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      '/wild/wildsavenonce/issue',
      encrypted
    )
    const data = ensureOk(resp, 'wildSaveNonceIssue')
    const parsed = JSON.parse(this.decryptStr(data)) as WildSaveNonceIssueResponseData
    return parsed.nonce
  }

  /**
   * POST /wild/wildsave (encrypted) — отправляет состояние wild-зоны.
   *
   * ⚠️ Сервер делает строгую anti-cheat валидацию каждого `action` в `content.actions[]`
   * (см. RESEARCH_STATUS.md → "Wild-зона"):
   *   - `target_object` ID должен существовать на RNG-сгенерированной карте
   *   - `action_type` должен соответствовать `type` объекта (ChopWood→Log, HitRock→Rock, ...)
   *
   * Без правильно сгенерированной карты (RNG-крекинг!) сервер вернёт
   * "action type does not match: expected X, actual Y" или подобное.
   */
  async wildSave (content: WildSaveContent, nonce: number): Promise<unknown> {
    this.assertLoggedIn()
    const body: WildSaveBody = {
      saveFile: { fileName: 'UserData/wild-save-data.json', content },
      nonce
    }
    const encrypted = encryptRequestBody(body, this.aesKey!)
    const resp = await this.http.post<MmpEnvelope<string>>(
      '/wild/wildsave',
      encrypted
    )
    const data = ensureOk(resp, 'wildSave')
    if (!data) return {}
    try {
      return JSON.parse(this.decryptStr(data))
    } catch {
      return data
    }
  }

  /** POST /wild/end (plain) — завершает wild-сессию. */
  async wildEnd (): Promise<unknown> {
    const resp = await this.http.post<MmpEnvelope<unknown>>('/wild/end', '{}')
    return ensureOk(resp, 'wildEnd')
  }

  // ============================================================
  // 7) MISSIONS
  // ============================================================

  /** GET /mission/missions — список квестов и прогресса. */
  async getMissions (): Promise<MissionsListData> {
    const resp = await this.http.get<MmpEnvelope<MissionsListData>>('/mission/missions')
    return ensureOk(resp, 'getMissions')
  }

  /** GET /client/mission/progress — entries прогресса (обычно пустой). */
  async getClientMissionProgress (): Promise<ClientMissionProgressData> {
    const resp = await this.http.get<MmpEnvelope<ClientMissionProgressData>>(
      '/client/mission/progress'
    )
    return ensureOk(resp, 'getClientMissionProgress')
  }

  // ============================================================
  // Внутренние утилиты
  // ============================================================

  private assertLoggedIn (): void {
    if (!this.aesKey) {
      throw new Error('MmpClient: вызовите signup() и login() перед операциями с шифрованием')
    }
  }

  /** Расшифровывает строку (data поля) в plaintext utf8. */
  private decryptStr (dataBase64: string): string {
    if (!this.aesKey) throw new Error('MmpClient: AES key not initialized')
    return decryptResponseData(dataBase64, this.aesKey)
  }
}
