import { parseEther, formatEther, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import { logger } from '../logger.js'
import { ProxyManager } from '../proxy-manager.js'
import axios from 'axios'

// Адреса контрактов на Soneium
const USDC_E_ADDRESS = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' as `0x${string}`

// Конфигурация
const WOWMAX_API_BASE = 'https://api-gateway.wowmax.exchange'
const NATIVE_ETH_SYMBOL = 'ETH'
const CHAIN_ID = 1868
const SLIPPAGE_TOLERANCE = 1.0 // 1%
const MIN_BALANCE_ETH = parseEther('0.0001') // Минимальный баланс для свапа
const MIN_SWAP_AMOUNT_ETH = parseEther('0.000001') // Минимальная сумма свапа

// Конфигурация retry
const MAX_RETRY_ATTEMPTS = 10
const RETRY_DELAY_MS = 2000
const API_TIMEOUT_MS = 30000
const PROXY_RETRY_ERROR_MESSAGE = 'Не удалось подобрать рабочий прокси'
const WOWMAX_API_DOWN_MESSAGE = 'WOWMAX API недоступен (Cloudflare 1033, origin tunnel down)'

/**
 * Detects HTTP 530 от Cloudflare — это "Argo Tunnel error" (код 1033),
 * который сигнализирует, что origin WOWMAX полностью отвалился (а не
 * наш прокси/запрос). Используется и для красивых логов, и для решения,
 * что итерация — skipped, а не error.
 */
function isCloudflareTunnelError (error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  return error.response?.status === 530
}

/**
 * Превращает невнятное axios-сообщение "Request failed with status code 530"
 * в человеко-читаемое объяснение, что это апстрим WOWMAX, а не наш баг.
 * Для остальных ошибок возвращает оригинальный текст.
 */
function formatSwapApiError (error: unknown): string {
  if (isCloudflareTunnelError(error)) {
    return WOWMAX_API_DOWN_MESSAGE
  }
  if (error instanceof Error) {
    return error.message
  }
  if (error == null) {
    return 'Неизвестная ошибка'
  }
  return String(error)
}

/**
 * Маркер: все попытки свапа завершились отказом апстрима WOWMAX
 * (Cloudflare 1033). Позволяет верхнему уровню вернуть `skipped: true`
 * вместо `success: false`, чтобы итерация не считалась ошибкой.
 */
class WowmaxApiUnavailableError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'WowmaxApiUnavailableError'
  }
}

const proxyManager = ProxyManager.getInstance()
const publicClient = rpcManager.createPublicClient(soneiumChain)

interface WowmaxSwapResponse {
  contract: string
  data: string
  value?: string
  amountOut?: string[]
  gasUnitsConsumed?: string
}

async function getEthBalance (address: `0x${string}`): Promise<bigint> {
  return await publicClient.getBalance({ address })
}

function calculateSwapAmount (balance: bigint): bigint {
  const percentage = Math.random() * 0.9 + 0.1
  const percentageInParts = Math.floor(percentage * 1000)
  const swapAmount = (balance * BigInt(percentageInParts)) / BigInt(100000)

  const onePercentOfBalance = balance / BigInt(100)
  if (swapAmount < MIN_SWAP_AMOUNT_ETH) {
    if (MIN_SWAP_AMOUNT_ETH > onePercentOfBalance) {
      return onePercentOfBalance
    }
    return MIN_SWAP_AMOUNT_ETH
  }

  return swapAmount
}

async function getSwapDataFromWOWMAXAPI (
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageTolerance: number,
  traderAddress: string,
  proxy: import('../proxy-manager.js').ProxyConfig
): Promise<WowmaxSwapResponse> {
  try {
    const url = new URL(`${WOWMAX_API_BASE}/chains/${chainId}/swap`)
    url.searchParams.set('from', tokenIn)
    url.searchParams.set('to', tokenOut)
    url.searchParams.set('amount', amountIn)
    url.searchParams.set('slippage', slippageTolerance.toString())
    url.searchParams.set('trader', traderAddress)

    const proxyAgents = proxyManager.createProxyAgents(proxy)
    const axiosInstance = axios.create({
      timeout: API_TIMEOUT_MS,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      httpsAgent: proxyAgents.httpsAgent,
      httpAgent: proxyAgents.httpAgent
    })

    const response = await axiosInstance.get(url.toString())

    if (response.status !== 200) {
      throw new Error(`API ошибка (${response.status}): ${JSON.stringify(response.data)}`)
    }

    const swapData = response.data as WowmaxSwapResponse

    if (!swapData.data) {
      throw new Error('Ответ API не содержит data для транзакции')
    }

    if (!swapData.contract) {
      throw new Error('Ответ API не содержит contract (адрес роутера)')
    }

    return swapData
  } catch (error) {
    if (!proxyManager.isProxyAuthError(error)) {
      logger.warn(`Ошибка при получении данных для свапа: ${formatSwapApiError(error)}`)
    }

    throw error
  }
}

async function getSwapDataFromWOWMAXAPIWithRetry (
  chainId: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageTolerance: number,
  traderAddress: string
): Promise<WowmaxSwapResponse> {
  let lastError: Error | null = null
  let cfTunnelFailures = 0
  let nonProxyAttempts = 0

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    let proxy: import('../proxy-manager.js').ProxyConfig | null = null

    try {
      proxy = proxyManager.getRandomProxyFast()
      if (!proxy) {
        throw new Error('Нет доступных прокси')
      }

      const swapData = await getSwapDataFromWOWMAXAPI(
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        slippageTolerance,
        traderAddress,
        proxy
      )

      return swapData
    } catch (error) {
      if (proxy && proxyManager.isProxyAuthError(error)) {
        proxyManager.markProxyAsUnhealthy(proxy)
        lastError = new Error(PROXY_RETRY_ERROR_MESSAGE)
        continue
      }

      lastError = error instanceof Error ? error : new Error('Неизвестная ошибка')
      nonProxyAttempts += 1
      if (isCloudflareTunnelError(error)) {
        cfTunnelFailures += 1
      }
      logger.warn(`Попытка ${attempt}/${MAX_RETRY_ATTEMPTS} неудачна: ${formatSwapApiError(error)}`)

      if (attempt < MAX_RETRY_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
  }

  if (nonProxyAttempts > 0 && cfTunnelFailures === nonProxyAttempts) {
    throw new WowmaxApiUnavailableError(
      `${WOWMAX_API_DOWN_MESSAGE} — все ${cfTunnelFailures} попыток вернули HTTP 530`
    )
  }

  throw new Error(`Не удалось получить данные свапа после ${MAX_RETRY_ATTEMPTS} попыток. Последняя ошибка: ${formatSwapApiError(lastError)}`)
}

async function performWowmaxSwap (
  privateKey: `0x${string}`,
  amountIn: bigint
): Promise<{ success: boolean; hash?: `0x${string}`; error?: string; skipped?: boolean; reason?: string }> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)
    const amountInETH = formatEther(amountIn)

    const swapData = await getSwapDataFromWOWMAXAPIWithRetry(
      CHAIN_ID,
      NATIVE_ETH_SYMBOL,
      USDC_E_ADDRESS,
      amountInETH,
      SLIPPAGE_TOLERANCE,
      account.address
    )

    const routerAddress = getAddress(swapData.contract)
    const calldata = swapData.data as `0x${string}`
    const value = swapData.value ? BigInt(swapData.value) : amountIn
    const gasEstimate = swapData.gasUnitsConsumed ? BigInt(swapData.gasUnitsConsumed) : undefined

    let finalGasEstimate: bigint | undefined = gasEstimate
    if (!finalGasEstimate) {
      try {
        finalGasEstimate = await publicClient.estimateGas({
          account,
          to: routerAddress,
          data: calldata,
          value: value
        })
      } catch {
        logger.warn('Не удалось оценить газ, используем стандартный лимит')
        finalGasEstimate = 300000n
      }
    }

    const txResult = await safeSendTransaction(
      publicClient,
      walletClient,
      account.address,
      {
        to: routerAddress,
        data: calldata,
        value: value,
        gas: finalGasEstimate ? (finalGasEstimate * BigInt(120)) / BigInt(100) : undefined
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'WOWMAX')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'WOWMAX', account.address)
      return {
        success: true,
        hash
      }
    } else {
      logger.transaction(hash, 'failed', 'WOWMAX', account.address)
      return {
        success: false,
        hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    if (error instanceof WowmaxApiUnavailableError) {
      logger.warn(`[WOWMAX] ${error.message}`)
      return {
        success: false,
        skipped: true,
        reason: WOWMAX_API_DOWN_MESSAGE
      }
    }
    logger.error('Ошибка при выполнении свапа', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

/**
 * Выполняет модуль WOWMAX: один свап ETH → USDC.e (0.1–1% от баланса) через WOWMAX API.
 */
export async function performWowmax (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  swapAmount?: string
  error?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.moduleStart('WOWMAX')

    const balance = await getEthBalance(account.address)
    const balanceETH = formatEther(balance)

    if (balance < MIN_BALANCE_ETH) {
      logger.warn(`Недостаточно ETH для свапа. Минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`)
      logger.moduleEnd('WOWMAX', false)
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточно ETH. Баланс: ${balanceETH} ETH, минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`
      }
    }

    const swapAmount = calculateSwapAmount(balance)
    const swapAmountETH = formatEther(swapAmount)

    const swapResult = await performWowmaxSwap(privateKey, swapAmount)

    if (swapResult.skipped) {
      // Апстрим WOWMAX лежит — это не ошибка пользователя, итерация
      // считается пропущенной (skipped → success в parallel-executor).
      logger.moduleEnd('WOWMAX', true)
      return {
        success: true,
        skipped: true,
        walletAddress: account.address,
        swapAmount: swapAmountETH,
        reason: swapResult.reason ?? WOWMAX_API_DOWN_MESSAGE
      }
    }

    if (swapResult.success && swapResult.hash) {
      logger.moduleEnd('WOWMAX', true)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: swapResult.hash,
        swapAmount: swapAmountETH
      }
    } else {
      logger.moduleEnd('WOWMAX', false)
      return {
        success: false,
        walletAddress: account.address,
        swapAmount: swapAmountETH,
        error: swapResult.error || 'Ошибка выполнения свапа'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении WOWMAX', error)
    logger.moduleEnd('WOWMAX', false)
    throw error
  }
}

export const __testing = {
  isCloudflareTunnelError,
  formatSwapApiError,
  WOWMAX_API_DOWN_MESSAGE,
  WowmaxApiUnavailableError
}
