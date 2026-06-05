import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { privateKeyToAccount } from 'viem/accounts'
import { ProxyManager } from '../proxy-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import axios from 'axios'
import { logger } from '../logger.js'

// Общие константы для всех сезонных минтов
const OPENSEA_GRAPHQL_URL = 'https://gql.opensea.io/graphql'
const API_BASE_URL = 'https://portal.soneium.org/api'

/**
 * Конфигурация минта SBT-бейджа конкретного сезона.
 *
 * Все поля кроме `threshold` обязательные. `threshold` опциональный, по умолчанию 80
 * (минимальный score для eligibility согласно Soneium Score блогу).
 */
export interface SeasonBadgeMintConfig {
  /** Номер сезона (используется для фильтрации API и логов) */
  season: number
  /** Адрес ERC721-контракта SBT-бейджа сезона */
  nftContract: `0x${string}`
  /** Дата открытия Stage 1 (84–100 score) */
  mintPhase1Date: Date
  /** Дата открытия Stage 2 (threshold..83 score) */
  mintPhase2Date: Date
  /** Минимальный score для eligibility, по умолчанию 80 */
  threshold?: number
  /** Метка для логов транзакций (например `SEASON10_BADGE_MINT`) */
  txLabel?: string
}

interface SeasonPointsData {
  totalScore: number
  isEligible: boolean
}

interface MintEligibilityResult {
  eligible: boolean
  phase?: 1 | 2
  reason: string
}

interface TransactionSubmissionData {
  to: string
  data: string
  value: string
  chain: {
    networkId: string
    identifier: string
  }
}

interface SeasonData {
  address: string
  baseScore: number
  bonusPoints: number
  season: number
  totalScore: number
  isEligible: boolean
  [key: string]: unknown
}

export interface SeasonBadgeMintResult {
  success: boolean
  walletAddress?: string
  seasonPoints?: number
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean
  reason?: string
}

// ABI для ERC721
const ERC721_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

// GraphQL запрос для минта
const MINT_QUERY = `query MintActionTimelineQuery($address: Address!, $fromAssets: [AssetQuantityInput!]!, $toAssets: [AssetQuantityInput!]!, $recipient: Address) {
  swap(
    address: $address
    fromAssets: $fromAssets
    toAssets: $toAssets
    recipient: $recipient
    action: MINT
  ) {
    actions {
      __typename
      ... on TransactionAction {
        transactionSubmissionData {
          chain {
            networkId
            identifier
            __typename
          }
          to
          data
          value
          __typename
        }
        __typename
      }
      ... on MintAction {
        __typename
        collection {
          imageUrl
          __typename
        }
      }
    }
    errors {
      __typename
    }
    __typename
  }
}`

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0'
] as const

const API_CONFIG = {
  timeout: 10000,
  retryAttempts: 10
}

const OPENSEA_CONFIG = {
  timeout: 30000,
  retryAttempts: 3
}
const PROXY_RETRY_ERROR_MESSAGE = 'Не удалось подобрать рабочий прокси'

function getRandomUserAgent (): string {
  const randomIndex = Math.floor(Math.random() * USER_AGENTS.length)
  return USER_AGENTS[randomIndex]!
}

async function checkSeasonNFTBalance (address: `0x${string}`, contract: `0x${string}`, season: number): Promise<bigint> {
  try {
    const publicClient = rpcManager.createPublicClient(soneiumChain)
    const balance = await publicClient.readContract({
      address: contract,
      abi: ERC721_ABI,
      functionName: 'balanceOf',
      args: [address]
    })

    logger.info(`NFT Season ${season} баланс: ${balance.toString()}`)
    return balance as bigint
  } catch (error) {
    logger.error(`Ошибка при проверке баланса NFT (Season ${season})`, error)
    throw error
  }
}

async function getSeasonPoints (address: string, season: number): Promise<SeasonPointsData | null> {
  const proxyManager = ProxyManager.getInstance()
  let lastError = ''

  for (let attempt = 1; attempt <= API_CONFIG.retryAttempts; attempt++) {
    let proxy: import('../proxy-manager.js').ProxyConfig | null = null

    try {
      proxy = proxyManager.getRandomProxyFast()
      if (!proxy) throw new Error('Нет доступных прокси')

      const axiosInstance = createApiAxiosInstance(proxy)
      const response = await axiosInstance.get(`${API_BASE_URL}/profile/calculator?address=${address}`)
      const data = response.data

      if (!Array.isArray(data) || data.length === 0) {
        logger.warn('API вернул пустой массив данных')
        return null
      }

      const seasonData = data.find((item: SeasonData) => item.season === season)

      if (!seasonData) {
        logger.warn(`Данные за сезон ${season} не найдены`)
        return null
      }

      logger.info(`Season ${season}: ${seasonData.totalScore}/100, eligible: ${seasonData.isEligible}`)

      return {
        totalScore: seasonData.totalScore,
        isEligible: seasonData.isEligible
      }
    } catch (error) {
      if (proxy && proxyManager.isProxyAuthError(error)) {
        proxyManager.markProxyAsUnhealthy(proxy)
        lastError = PROXY_RETRY_ERROR_MESSAGE
        continue
      }

      lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.warn(`Попытка ${attempt}/${API_CONFIG.retryAttempts} неудачна: ${lastError}`)

      if (attempt < API_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  logger.error(`Все ${API_CONFIG.retryAttempts} попыток получения данных сезона ${season} неудачны. Последняя ошибка: ${lastError}`)
  return null
}

function createApiAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
  const proxyManager = ProxyManager.getInstance()
  const proxyAgents = proxyManager.createProxyAgents(proxy)
  const userAgent = getRandomUserAgent()

  return axios.create({
    timeout: API_CONFIG.timeout,
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

function isPhaseAvailable (phaseDate: Date, phase: 1 | 2): boolean {
  const now = new Date()
  const isAvailable = now >= phaseDate
  logger.info(`Фаза ${phase}: ${isAvailable ? 'доступна' : 'недоступна'}`)
  return isAvailable
}

function formatMintStartDate (date: Date): string {
  const mintDate = date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Moscow'
  })
  const mintTime = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
    timeZoneName: 'short'
  })
  return `${mintDate} ${mintTime}`
}

function checkMintEligibility (totalScore: number, config: SeasonBadgeMintConfig): MintEligibilityResult {
  const threshold = config.threshold ?? 80
  const stage2UpperBound = 83 // фиксированный диапазон Stage 2: threshold..83

  if (totalScore < threshold) {
    return {
      eligible: false,
      reason: `Недостаточно поинтов для минта: ${totalScore}/100 (нужно ${threshold}+)`
    }
  }

  // Фаза 1: 84-100 поинтов (Stage 1)
  if (totalScore >= 84 && totalScore <= 100) {
    if (isPhaseAvailable(config.mintPhase1Date, 1)) {
      return {
        eligible: true,
        phase: 1,
        reason: 'Минт доступен сейчас (Фаза 1: 84-100 поинтов)'
      }
    }
    return {
      eligible: false,
      phase: 1,
      reason: `Минт будет доступен с ${formatMintStartDate(config.mintPhase1Date)}. Поинты за ${config.season} сезон: ${totalScore}/100`
    }
  }

  // Фаза 2: threshold-83 поинтов (Stage 2)
  if (totalScore >= threshold && totalScore <= stage2UpperBound) {
    if (isPhaseAvailable(config.mintPhase2Date, 2)) {
      return {
        eligible: true,
        phase: 2,
        reason: `Минт доступен сейчас (Фаза 2: ${threshold}-${stage2UpperBound} поинта)`
      }
    }
    return {
      eligible: false,
      phase: 2,
      reason: `Минт будет доступен с ${formatMintStartDate(config.mintPhase2Date)}. Поинты за ${config.season} сезон: ${totalScore}/100`
    }
  }

  return {
    eligible: false,
    reason: `Неизвестный диапазон поинтов: ${totalScore}`
  }
}

async function getMintTransactionFromOpenSea (walletAddress: string, contract: `0x${string}`): Promise<TransactionSubmissionData> {
  const proxyManager = ProxyManager.getInstance()
  let lastError = ''

  for (let attempt = 1; attempt <= OPENSEA_CONFIG.retryAttempts; attempt++) {
    let proxy: import('../proxy-manager.js').ProxyConfig | null = null

    try {
      proxy = proxyManager.getRandomProxyFast()
      if (!proxy) throw new Error('Нет доступных прокси')

      const axiosInstance = createOpenSeaAxiosInstance(proxy)

      const variables = {
        address: walletAddress,
        fromAssets: [
          {
            asset: {
              chain: 'soneium',
              contractAddress: '0x0000000000000000000000000000000000000000'
            }
          }
        ],
        toAssets: [
          {
            asset: {
              chain: 'soneium',
              contractAddress: contract.toLowerCase(),
              tokenId: '0'
            },
            quantity: '1'
          }
        ]
      }

      const response = await axiosInstance.post(OPENSEA_GRAPHQL_URL, {
        operationName: 'MintActionTimelineQuery',
        query: MINT_QUERY,
        variables
      })

      const data = response.data

      if (data.errors && data.errors.length > 0) {
        const errorMessages = data.errors.map((e: { message: string }) => e.message).join('; ')
        throw new Error(`GraphQL errors: ${errorMessages}`)
      }

      const actions = data.data?.swap?.actions
      if (!actions || actions.length === 0) {
        throw new Error('No actions returned from OpenSea - возможно, кошелек не eligible или требуется аутентификация')
      }

      let actionWithTxData: { transactionSubmissionData: TransactionSubmissionData } | null = null

      for (const action of actions) {
        const actionTyped = action as { __typename: string, [key: string]: unknown }
        const txData = actionTyped['transactionSubmissionData']
        if (txData && typeof txData === 'object') {
          actionWithTxData = { transactionSubmissionData: txData as unknown as TransactionSubmissionData }
          break
        }
      }

      if (!actionWithTxData) {
        const mintAction = actions.find((action: { __typename: string }) => action.__typename === 'MintAction')
        if (mintAction) {
          const mintActionTyped = mintAction as { [key: string]: unknown }
          const txData = mintActionTyped['transactionSubmissionData']
          if (txData && typeof txData === 'object') {
            actionWithTxData = { transactionSubmissionData: txData as unknown as TransactionSubmissionData }
          }
        }
      }

      if (!actionWithTxData || !actionWithTxData.transactionSubmissionData) {
        const actionTypes = actions.map((a: { __typename: string }) => a.__typename).join(', ')
        logger.warn(`Найдены actions: ${actionTypes}, но нет action с transactionSubmissionData`)
        logger.warn('Возможно, минт еще не доступен для этого кошелька или требуется дополнительная аутентификация')
        throw new Error('MintAction not found or missing transaction data')
      }

      return actionWithTxData.transactionSubmissionData as TransactionSubmissionData
    } catch (error) {
      if (proxy && proxyManager.isProxyAuthError(error)) {
        proxyManager.markProxyAsUnhealthy(proxy)
        lastError = PROXY_RETRY_ERROR_MESSAGE
        continue
      }

      lastError = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.warn(`Попытка ${attempt}/${OPENSEA_CONFIG.retryAttempts} получения данных из OpenSea неудачна: ${lastError}`)

      if (attempt < OPENSEA_CONFIG.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  throw new Error(`Все ${OPENSEA_CONFIG.retryAttempts} попыток получения данных из OpenSea неудачны. Последняя ошибка: ${lastError}`)
}

function createOpenSeaAxiosInstance (proxy: import('../proxy-manager.js').ProxyConfig): import('axios').AxiosInstance {
  const proxyManager = ProxyManager.getInstance()
  const proxyAgents = proxyManager.createProxyAgents(proxy)
  const userAgent = getRandomUserAgent()

  return axios.create({
    timeout: OPENSEA_CONFIG.timeout,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-app-id': 'os2-web',
      'User-Agent': userAgent,
      Origin: 'https://opensea.io',
      Referer: 'https://opensea.io/'
    },
    httpsAgent: proxyAgents.httpsAgent,
    httpAgent: proxyAgents.httpAgent
  })
}

async function performMint (privateKey: `0x${string}`, txData: TransactionSubmissionData, txLabel: string): Promise<string> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const publicClient = rpcManager.createPublicClient(soneiumChain)

    logger.info('Отправка транзакции минта...')

    const txResult = await safeSendTransaction(
      publicClient,
      walletClient,
      account.address,
      {
        to: txData.to as `0x${string}`,
        data: txData.data as `0x${string}`,
        value: BigInt(txData.value || '0'),
        account: account,
        chain: walletClient.chain
      }
    )
    if (!txResult.success) throw new Error(txResult.error)
    const hash = txResult.hash

    logger.transaction(hash, 'sent', txLabel, account.address)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', txLabel, account.address)
    } else {
      logger.error('Транзакция не подтверждена')
      logger.transaction(hash, 'failed', txLabel, account.address)
    }

    return hash
  } catch (error) {
    logger.error('Ошибка при выполнении минта', error)
    throw error
  }
}

/**
 * Универсальная функция минта SBT-бейджа сезона.
 *
 * Обработает: проверку существующего NFT, получение score из API портала,
 * проверку eligibility по фазам Stage 1/2, получение mint-транзакции из OpenSea
 * и отправку on-chain транзакции в Soneium.
 */
export async function performSeasonBadgeMint (
  privateKey: `0x${string}`,
  config: SeasonBadgeMintConfig
): Promise<SeasonBadgeMintResult> {
  const txLabel = config.txLabel ?? `SEASON${config.season}_BADGE_MINT`

  try {
    const account = privateKeyToAccount(privateKey)
    const walletAddress = account.address

    logger.info(`Season ${config.season} Badge Mint: проверка ${walletAddress}`)

    const nftBalance = await checkSeasonNFTBalance(walletAddress, config.nftContract, config.season)
    if (nftBalance > 0n) {
      logger.info(`NFT уже есть (баланс: ${nftBalance.toString()}), пропуск`)
      const seasonData = await getSeasonPoints(walletAddress, config.season)
      const result: SeasonBadgeMintResult = {
        success: true,
        walletAddress,
        skipped: true,
        reason: `NFT уже есть у кошелька (баланс: ${nftBalance.toString()})`
      }
      if (seasonData?.totalScore !== undefined) {
        result.seasonPoints = seasonData.totalScore
      }
      return result
    }

    logger.info(`Получение данных сезона ${config.season}...`)
    const seasonData = await getSeasonPoints(walletAddress, config.season)

    if (!seasonData) {
      const error = `Нет данных за сезон ${config.season}`
      logger.error(error)
      return {
        success: false,
        walletAddress,
        error
      }
    }

    const eligibility = checkMintEligibility(seasonData.totalScore, config)
    logger.info(`Eligibility: ${eligibility.reason}`)

    if (!eligibility.eligible) {
      return {
        success: true,
        walletAddress,
        seasonPoints: seasonData.totalScore,
        skipped: true,
        reason: eligibility.reason
      }
    }

    logger.info('Получение данных минта из OpenSea...')
    const txData = await getMintTransactionFromOpenSea(walletAddress, config.nftContract)

    const txHash = await performMint(privateKey, txData, txLabel)

    const explorerUrl = `https://soneium.blockscout.com/tx/${txHash}`

    return {
      success: true,
      walletAddress,
      seasonPoints: seasonData.totalScore,
      transactionHash: txHash,
      explorerUrl
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error(`Ошибка при выполнении Season ${config.season} Badge Mint: ${errorMessage}`, error)

    let seasonPoints: number | undefined
    try {
      const account = privateKeyToAccount(privateKey)
      const seasonData = await getSeasonPoints(account.address, config.season)
      seasonPoints = seasonData?.totalScore
    } catch {
      // ignore
    }

    const result: SeasonBadgeMintResult = {
      success: false,
      walletAddress: privateKeyToAccount(privateKey).address,
      error: errorMessage
    }
    if (seasonPoints !== undefined) {
      result.seasonPoints = seasonPoints
    }
    return result
  }
}
