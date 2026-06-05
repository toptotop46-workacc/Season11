import { formatUnits, parseAbi, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ProxyManager } from './proxy-manager.js'
import { rpcManager, soneiumChain } from './rpc-manager.js'
import { safeWriteContract, safeSendTransaction } from './transaction-utils.js'
import { logger } from './logger.js'
import type { LiFiQuote } from './modules/jumper.js'

// Вспомогательная функция для форматирования gwei
function formatGwei (wei: bigint): string {
  return (Number(wei) / 1_000_000_000).toFixed(9)
}

// Контрактные адреса
const USDC_ADDRESS = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369'
const USDT_ADDRESS = '0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35'
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'
const UNISWAP_ROUTER_ADDRESS = '0x273f68c234fa55b550b40e563c4a488e0d334320'

// ABI для ERC20 токенов
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
])

// ABI для Uniswap V2 Router
const UNISWAP_ROUTER_ABI = parseAbi([
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)',
  'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)'
])

// Интерфейсы для совместимости с LiFi
interface TransactionReceipt {
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  effectiveGasPrice: bigint
}

// Интерфейс для внутреннего использования
interface TokenInfo {
  address: string
  symbol: string
  decimals: number
}

// Маппинг токенов
const TOKEN_MAP: Record<string, TokenInfo> = {
  [USDC_ADDRESS]: {
    address: USDC_ADDRESS,
    symbol: 'USDC.e',
    decimals: 6
  },
  [USDT_ADDRESS]: {
    address: USDT_ADDRESS,
    symbol: 'USDT',
    decimals: 6
  }
}

export class WheelXSwap {
  private privateKey: `0x${string}`
  private publicClient: ReturnType<typeof rpcManager.createPublicClient>
  private walletClient: ReturnType<typeof rpcManager.createWalletClient>
  private account: ReturnType<typeof privateKeyToAccount>
  private proxyManager: ProxyManager

  constructor (privateKey: `0x${string}`) {
    // Валидация приватного ключа
    if (!privateKey) {
      throw new Error('Приватный ключ обязателен для создания экземпляра WheelXSwap')
    }

    // Нормализация приватного ключа (добавляем 0x если его нет)
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}` as `0x${string}`

    // Инициализируем прокси менеджер
    this.proxyManager = ProxyManager.getInstance()

    try {
      // Создаем аккаунт из приватного ключа
      this.account = privateKeyToAccount(this.privateKey)

      // Создаем клиенты
      this.publicClient = rpcManager.createPublicClient(soneiumChain)
      this.walletClient = rpcManager.createWalletClient(soneiumChain, this.account)

      // Кошелек инициализирован
    } catch (error) {
      throw new Error(`Ошибка инициализации кошелька: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`)
    }
  }

  /**
   * Получить адрес кошелька из приватного ключа
   */
  getWalletAddress (): `0x${string}` {
    return this.account.address
  }

  /**
   * Получить информацию о токене по адресу
   */
  private getTokenInfo (tokenAddress: string): TokenInfo | null {
    return TOKEN_MAP[tokenAddress] || null
  }

  /**
   * Получить баланс токена
   */
  private async getTokenBalance (tokenAddress: string, userAddress: `0x${string}`): Promise<{
    raw: bigint
    formatted: string
    decimals: number
  }> {
    try {
      const balance = await this.publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [userAddress]
      })

      const decimals = await this.publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals'
      })
      return {
        raw: balance,
        formatted: formatUnits(balance, decimals),
        decimals: decimals
      }
    } catch (error) {
      logger.error('Ошибка при получении баланса токена:', error)
      throw error
    }
  }

  /**
   * Получить котировку от Uniswap V2 Router
   */
  async getQuote (fromToken: string, toToken: string, amount: string, fromAddress: `0x${string}`): Promise<{
    request_id: string
    amount_out: string
    fee: string
    tx: {
      to: string
      value: number
      data: string
      chainId?: number
      gas?: number | null
      maxFeePerGas?: number | null
      maxPriorityFeePerGas?: number | null
    }
    approve?: {
      token: string
      spender: string
      amount: number
    }
    slippage: number
    min_receive: string
    estimated_time: number
    recipient: string
    router_type: string
    points: string
  }> {
    try {
      const amountIn = BigInt(amount)
      const isETHToToken = fromToken === '0x0000000000000000000000000000000000000000'
      const isTokenToETH = toToken === WETH_ADDRESS || toToken === '0x0000000000000000000000000000000000000000'

      let path: `0x${string}`[]
      let amountOut: bigint
      let swapData: `0x${string}`
      let needsApprove = false

      if (isETHToToken) {
        // ETH → Token свап
        const tokenInfo = this.getTokenInfo(toToken)
        if (!tokenInfo) {
          throw new Error(`Неподдерживаемый целевой токен: ${toToken}`)
        }

        path = [WETH_ADDRESS as `0x${string}`, toToken as `0x${string}`]

        // Получаем котировку для ETH → Token
        const amounts = await this.publicClient.readContract({
          address: UNISWAP_ROUTER_ADDRESS as `0x${string}`,
          abi: UNISWAP_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, path]
        })

        const rawAmountOut = amounts[amounts.length - 1] // Последний элемент - это токен
        if (!rawAmountOut || rawAmountOut === 0n) {
          throw new Error('Не удалось получить котировку для свапа. Возможно, нет ликвидности для пары')
        }
        amountOut = rawAmountOut

        // Создаем данные для ETH → Token свапа
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 минут
        const slippage = 100 // 1% в базисных пунктах
        const amountOutMin = amountOut * (10000n - BigInt(slippage)) / 10000n

        swapData = encodeFunctionData({
          abi: UNISWAP_ROUTER_ABI,
          functionName: 'swapExactETHForTokens',
          args: [
            amountOutMin,
            path,
            fromAddress,
            BigInt(deadline)
          ]
        })
      } else if (isTokenToETH) {
        // Token → ETH свап
        const tokenInfo = this.getTokenInfo(fromToken)
        if (!tokenInfo) {
          throw new Error(`Неподдерживаемый токен: ${fromToken}`)
        }

        path = [fromToken as `0x${string}`, WETH_ADDRESS as `0x${string}`]

        // Получаем котировку для Token → ETH
        const amounts = await this.publicClient.readContract({
          address: UNISWAP_ROUTER_ADDRESS as `0x${string}`,
          abi: UNISWAP_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, path]
        })

        const rawAmountOut = amounts[amounts.length - 1] // Последний элемент - это ETH
        if (!rawAmountOut || rawAmountOut === 0n) {
          throw new Error('Не удалось получить котировку для свапа. Возможно, нет ликвидности для пары')
        }
        amountOut = rawAmountOut

        // Проверяем allowance для Token → ETH
        const allowance = await this.publicClient.readContract({
          address: fromToken as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [fromAddress, UNISWAP_ROUTER_ADDRESS as `0x${string}`]
        })

        needsApprove = allowance < amountIn

        // Создаем данные для Token → ETH свапа
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 минут
        const slippage = 100 // 1% в базисных пунктах
        const amountOutMin = amountOut * (10000n - BigInt(slippage)) / 10000n

        swapData = encodeFunctionData({
          abi: UNISWAP_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [
            amountIn,
            amountOutMin,
            path,
            fromAddress,
            BigInt(deadline)
          ]
        })
      } else {
        throw new Error(`Неподдерживаемый тип свапа: ${fromToken} → ${toToken}. Поддерживается только ETH ↔ токены`)
      }

      const result: {
        request_id: string
        amount_out: string
        fee: string
        tx: {
          to: string
          value: number
          data: string
          chainId?: number
          gas?: number | null
          maxFeePerGas?: number | null
          maxPriorityFeePerGas?: number | null
        }
        approve?: {
          token: string
          spender: string
          amount: number
        }
        slippage: number
        min_receive: string
        estimated_time: number
        recipient: string
        router_type: string
        points: string
      } = {
        request_id: `uniswap_${Date.now()}`,
        amount_out: amountOut.toString(),
        fee: '0', // Uniswap V2 не имеет отдельной комиссии
        tx: {
          to: UNISWAP_ROUTER_ADDRESS,
          value: isETHToToken ? Number(amountIn) : 0, // Для ETH → Token передаем value
          data: swapData,
          chainId: soneiumChain.id,
          gas: null,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null
        },
        slippage: 100, // 1% в базисных пунктах
        min_receive: (amountOut * 9900n / 10000n).toString(), // 1% slippage
        estimated_time: 60, // 1 минута
        recipient: fromAddress,
        router_type: 'uniswap_v2',
        points: '0'
      }

      if (needsApprove) {
        result.approve = {
          token: fromToken,
          spender: UNISWAP_ROUTER_ADDRESS,
          amount: Number(amountIn)
        }
      }

      return result
    } catch (error) {
      logger.error('Ошибка при получении котировки Uniswap V2:', error)
      throw error
    }
  }

  /**
   * Выполнить апрув токенов
   */
  private async approveTokens (amount: bigint): Promise<void> {
    try {
      // Оцениваем газ для апрува
      const gasEstimate = await this.publicClient.estimateContractGas({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_ROUTER_ADDRESS as `0x${string}`, amount],
        account: this.account.address
      })

      const txResult = await safeWriteContract(
        this.publicClient,
        this.walletClient,
        this.account.address,
        {
          address: USDC_ADDRESS as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [UNISWAP_ROUTER_ADDRESS as `0x${string}`, amount],
          gas: gasEstimate * 120n / 100n,
          chain: soneiumChain,
          account: this.account
        }
      )
      if (!txResult.success) throw new Error(txResult.error)
      await this.publicClient.waitForTransactionReceipt({ hash: txResult.hash })

    } catch (error) {
      logger.error('Ошибка при апруве токенов:', error)
      throw error
    }
  }

  /**
   * Выполнить транзакцию с правильными EIP-1559 параметрами
   */
  async executeTransaction (transactionRequest: {
    to: string
    value: number
    data: string
    chainId?: number
    gas?: number | null
    maxFeePerGas?: number | null
    maxPriorityFeePerGas?: number | null
  }): Promise<{
    success: boolean
    hash?: string
    receipt?: TransactionReceipt
    blockNumber?: bigint
    gasUsed?: bigint
    error?: string
  }> {
    try {
      // Валидация параметров транзакции
      if (!transactionRequest.to || !transactionRequest.data) {
        throw new Error('Отсутствуют обязательные параметры транзакции (to, data)')
      }

      const txValue = BigInt(transactionRequest.value || 0)

      // Динамическая оценка газа
      const estimatedGas = await this.publicClient.estimateGas({
        to: transactionRequest.to as `0x${string}`,
        data: transactionRequest.data as `0x${string}`,
        value: txValue,
        account: this.account.address
      })

      // Минимальный буфер газа (+20% для безопасности)
      const gasLimit = estimatedGas * 120n / 100n

      // Вычисляем EIP-1559 параметры
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.calculateEIP1559GasParams()

      const transaction = {
        type: 'eip1559' as const,
        to: transactionRequest.to as `0x${string}`,
        data: transactionRequest.data as `0x${string}`,
        value: txValue,
        gas: gasLimit,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: transactionRequest.chainId || soneiumChain.id,
        account: this.account,
        chain: soneiumChain
      }

      const txResult = await safeSendTransaction(
        this.publicClient,
        this.walletClient,
        this.account.address,
        transaction
      )
      if (!txResult.success) throw new Error(txResult.error)
      const hash = txResult.hash

      logger.transaction(hash, 'sent', 'UNISWAP_V2_SWAP')

      // Ждем подтверждения
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        logger.transaction(hash, 'confirmed', 'UNISWAP_V2_SWAP')

        return {
          success: true,
          hash: hash,
          receipt: {
            status: 'success',
            blockNumber: BigInt(receipt.blockNumber),
            gasUsed: BigInt(receipt.gasUsed),
            effectiveGasPrice: BigInt(receipt.effectiveGasPrice || '0')
          },
          blockNumber: BigInt(receipt.blockNumber),
          gasUsed: BigInt(receipt.gasUsed)
        }
      } else {
        logger.transaction(hash, 'failed', 'UNISWAP_V2_SWAP')
        return {
          success: false,
          hash: hash,
          error: 'Транзакция не удалась'
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.error('Ошибка выполнения транзакции Uniswap V2', error)
      return {
        success: false,
        error: errorMessage
      }
    }
  }

  /**
   * Вычислить EIP-1559 параметры газа для Soneium сети
   */
  private async calculateEIP1559GasParams (): Promise<{
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
  }> {
    try {
      // Получаем текущий блок для baseFee
      const block = await this.publicClient.getBlock({ blockTag: 'latest' })
      const baseFee = block.baseFeePerGas || BigInt('1000000') // минимум 1 Mwei если нет baseFee

      // Для Soneium (OP Stack) используем консервативные параметры
      // Priority fee должен быть минимальным для L2
      const minPriorityFee = BigInt('1000000') // 1 Mwei (0.001 gwei)

      // Пытаемся получить рекомендуемый priority fee из истории блоков
      let recommendedPriorityFee = minPriorityFee

      try {
        // Для Soneium (OP Stack) priority fee обычно очень низкий
        recommendedPriorityFee = baseFee / BigInt(100) // 1% от baseFee
        if (recommendedPriorityFee < minPriorityFee) {
          recommendedPriorityFee = minPriorityFee
        }
      } catch {
        logger.warn('Не удалось получить историю комиссий, используем минимальное значение priority fee')
        recommendedPriorityFee = minPriorityFee
      }

      // Max fee = baseFee * 2 + priority fee (с запасом для колебаний baseFee)
      const maxFeePerGas = baseFee * BigInt(2) + recommendedPriorityFee
      const maxPriorityFeePerGas = recommendedPriorityFee

      return {
        maxFeePerGas,
        maxPriorityFeePerGas
      }
    } catch (error) {
      logger.error('Ошибка при расчете EIP-1559 параметров газа', error)

      // Fallback значения для Soneium
      const fallbackMaxPriorityFee = BigInt('1000000') // 1 Mwei
      const fallbackMaxFee = BigInt('10000000') // 10 Mwei

      logger.warn(`Используем fallback параметры газа: maxFee=${formatGwei(fallbackMaxFee)} gwei, priorityFee=${formatGwei(fallbackMaxPriorityFee)} gwei`)

      return {
        maxFeePerGas: fallbackMaxFee,
        maxPriorityFeePerGas: fallbackMaxPriorityFee
      }
    }
  }

  /**
   * Преобразовать Uniswap V2 формат в LiFi формат для совместимости
   */
  convertToLiFiFormat (uniswapQuote: {
    request_id: string
    amount_out: string
    fee: string
    tx: {
      to: string
      value: number
      data: string
      chainId?: number
      gas?: number | null
      maxFeePerGas?: number | null
      maxPriorityFeePerGas?: number | null
    }
    approve?: {
      token: string
      spender: string
      amount: number
    }
    slippage: number
    min_receive: string
    estimated_time: number
    recipient: string
    router_type: string
    points: string
  }): LiFiQuote {
    return {
      id: uniswapQuote.request_id,
      type: 'swap',
      tool: 'uniswap_v2',
      toolDetails: {
        key: 'uniswap_v2',
        logoURI: 'https://uniswap.org/logo.png',
        name: 'Uniswap V2'
      },
      transactionRequest: {
        to: uniswapQuote.tx.to,
        value: uniswapQuote.tx.value.toString(),
        data: uniswapQuote.tx.data,
        ...(uniswapQuote.tx.gas && { gasLimit: uniswapQuote.tx.gas.toString() }),
        ...(uniswapQuote.tx.maxFeePerGas && { gasPrice: uniswapQuote.tx.maxFeePerGas.toString() }),
        ...(uniswapQuote.tx.chainId && { chainId: uniswapQuote.tx.chainId })
      },
      estimate: {
        toAmount: uniswapQuote.amount_out,
        fromAmount: uniswapQuote.tx.value.toString(),
        toAmountMin: uniswapQuote.min_receive,
        fromAmountMin: uniswapQuote.tx.value.toString()
      },
      action: {
        fromChainId: soneiumChain.id,
        toChainId: soneiumChain.id,
        fromToken: {
          address: uniswapQuote.tx.to,
          symbol: 'UNKNOWN',
          decimals: 18,
          chainId: soneiumChain.id,
          name: 'Unknown Token'
        },
        toToken: {
          address: uniswapQuote.tx.to,
          symbol: 'UNKNOWN',
          decimals: 18,
          chainId: soneiumChain.id,
          name: 'Unknown Token'
        },
        fromAmount: uniswapQuote.tx.value.toString(),
        toAmount: uniswapQuote.amount_out,
        slippage: uniswapQuote.slippage / 10000, // Конвертируем из basis points
        transactionRequest: {
          to: uniswapQuote.tx.to,
          value: uniswapQuote.tx.value.toString(),
          data: uniswapQuote.tx.data,
          ...(uniswapQuote.tx.gas && { gasLimit: uniswapQuote.tx.gas.toString() }),
          ...(uniswapQuote.tx.maxFeePerGas && { gasPrice: uniswapQuote.tx.maxFeePerGas.toString() }),
          ...(uniswapQuote.tx.chainId && { chainId: uniswapQuote.tx.chainId })
        }
      }
    }
  }
}
