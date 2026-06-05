import { formatUnits, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SoneiumSwap } from './jumper.js'
import { redeem as redeemMorphoLiquidity, isMorphoNotEnoughLiquidityError } from './morpho.js'
import { redeemLiquidity as redeemStargateLiquidity } from './stargate.js'
import { redeemLiquidity, classifySakeWithdrawRuntimeHandling } from './sake-finance.js'
import { redeemLiquidity as redeemAaveLiquidity } from './aave.js'
import { getUntitledBankWithdrawPreview, withdraw as withdrawFromUntitledBank } from './untitled-bank.js'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адреса токенов
const TOKENS = {
  ETH: '0x0000000000000000000000000000000000000000',
  USDT: '0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35',
  USDC_e: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369',
  USDSC: '0x3f99231dD03a9F0E7e3421c92B7b90fbe012985a'
} as const

// Адреса контрактов протоколов
const PROTOCOL_CONTRACTS = {
  // Aave
  AAVE_L2_POOL: '0xdd3d7a7d03d9fd9ef45f3e587287922ef65ca38b',
  AAVE_A_TOKEN: '0xb2C9E934A55B58D20496A5019F8722a96d8A44d8',

  // Morpho
  MORPHO_METAMORPHO: '0xecdbe2af33e68cf96f6716f706b078fa94e978cb',

  // Stargate
  STARGATE_POOL: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
  STARGATE_LP_TOKEN: '0x5b091dc6f94b5e2b54edab3800759abf0ed7d26d',

  // Sake Finance
  SAKE_ATOKEN: '0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726',

  // Untitled Bank
  UNTITLED_BANK: '0xc675BB95D73CA7db2C09c3dC04dAaA7944CCBA41'
} as const

// ABI для ERC20 токенов
const ERC20_ABI = [
  {
    'inputs': [{ 'internalType': 'address', 'name': 'account', 'type': 'address' }],
    'name': 'balanceOf',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [],
    'name': 'decimals',
    'outputs': [{ 'internalType': 'uint8', 'name': '', 'type': 'uint8' }],
    'stateMutability': 'view',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' },
      { 'internalType': 'uint256', 'name': 'amount', 'type': 'uint256' }
    ],
    'name': 'approve',
    'outputs': [{ 'internalType': 'bool', 'name': '', 'type': 'bool' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [
      { 'internalType': 'address', 'name': 'owner', 'type': 'address' },
      { 'internalType': 'address', 'name': 'spender', 'type': 'address' }
    ],
    'name': 'allowance',
    'outputs': [{ 'internalType': 'uint256', 'name': '', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// ABI для Stargate
const STARGATE_ABI = [
  {
    'inputs': [
      { 'internalType': 'uint256', 'name': '_amountLD', 'type': 'uint256' },
      { 'internalType': 'address', 'name': '_receiver', 'type': 'address' }
    ],
    'name': 'redeem',
    'outputs': [{ 'internalType': 'uint256', 'name': 'amountLD', 'type': 'uint256' }],
    'stateMutability': 'nonpayable',
    'type': 'function'
  },
  {
    'inputs': [{ 'internalType': 'address', 'name': '_owner', 'type': 'address' }],
    'name': 'redeemable',
    'outputs': [{ 'internalType': 'uint256', 'name': 'amountLD', 'type': 'uint256' }],
    'stateMutability': 'view',
    'type': 'function'
  }
] as const

// Интерфейсы для результатов
interface TokenBalance {
  token: string
  symbol: string
  balance: string
  balanceWei: bigint
}

interface LiquidityInfo {
  protocol: string
  hasLiquidity: boolean
  balance: string
  balanceWei: bigint
  tokenAddress: string
}

interface CollectionResult {
  success: boolean
  walletAddress: string
  initialETHBalance: string
  finalETHBalance: string
  collectedTokens: TokenBalance[]
  liquidityFound: LiquidityInfo[]
  withdrawnLiquidity: LiquidityInfo[]
  totalCollected: string
  error?: string
}

type WithdrawalExecutionOutcome = 'withdrawn' | 'skipped' | 'failed'

export function resolveCollectorWithdrawalOutcome (
  protocol: string,
  transactionHash: string | null | undefined
): WithdrawalExecutionOutcome {
  if (transactionHash) {
    return 'withdrawn'
  }

  if (protocol === 'Untitled Bank' || protocol === 'Stargate' || protocol === 'Sake Finance') {
    return 'skipped'
  }

  return 'failed'
}

export class SoneiumCollector {
  private privateKey: `0x${string}`
  private client: ReturnType<typeof rpcManager.createPublicClient>
  private account: ReturnType<typeof privateKeyToAccount>
  private walletClient: ReturnType<typeof rpcManager.createWalletClient>
  private swap: SoneiumSwap

  constructor (privateKey: `0x${string}`) {
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}` as `0x${string}`

    this.account = privateKeyToAccount(this.privateKey)
    this.client = rpcManager.createPublicClient(soneiumChain)
    this.walletClient = rpcManager.createWalletClient(soneiumChain, this.account)

    this.swap = new SoneiumSwap(privateKey)
  }

  /**
   * Получить адрес кошелька
   */
  getWalletAddress (): `0x${string}` {
    return this.account.address
  }

  /**
   * Получить баланс ETH
   */
  async getETHBalance (): Promise<string> {
    const balance = await this.client.getBalance({
      address: this.getWalletAddress()
    })
    return formatEther(balance)
  }

  /**
   * Получить баланс ERC20 токена
   */
  async getTokenBalance (tokenAddress: string): Promise<bigint> {
    try {
      const balance = await this.client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.getWalletAddress()]
      })
      return balance as bigint
    } catch (error) {
      logger.error(`Ошибка получения баланса токена ${tokenAddress}`, error)
      return 0n
    }
  }

  /**
   * Проверить allowance (разрешение) для токена
   */
  async checkAllowance (tokenAddress: string, spenderAddress: string): Promise<bigint> {
    try {
      const allowance = await this.client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [this.getWalletAddress(), spenderAddress as `0x${string}`]
      })
      return allowance as bigint
    } catch (error) {
      logger.error(`Ошибка проверки allowance для токена ${tokenAddress}`, error)
      return 0n
    }
  }

  /**
   * Установить approve для токена на указанную сумму
   */
  async approveToken (tokenAddress: string, spenderAddress: string, amount: bigint): Promise<boolean> {
    try {
      const txResult = await safeWriteContract(
        this.client,
        this.walletClient,
        this.account.address,
        {
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spenderAddress as `0x${string}`, amount],
          account: this.account,
          chain: this.client.chain
        }
      )
      if (!txResult.success) {
        logger.error(`Ошибка approve: ${txResult.error}`)
        return false
      }
      const hash = txResult.hash
      logger.transaction(hash, 'sent', 'COLLECTOR', 'APPROVE')

      const receipt = await this.client.waitForTransactionReceipt({ hash })
      const success = receipt.status === 'success'

      if (!success) {
        logger.transaction(hash, 'failed', 'COLLECTOR', 'APPROVE')
        logger.error(`Ошибка установки approve для токена ${tokenAddress}`)
      } else {
        logger.transaction(hash, 'confirmed', 'COLLECTOR', this.account.address, 'APPROVE')
      }

      return success
    } catch (error) {
      logger.error(`Ошибка установки approve для токена ${tokenAddress}`, error)
      return false
    }
  }

  /**
   * Собрать токены USDT, USDC.e и USDSC в ETH
   */
  async collectTokens (): Promise<TokenBalance[]> {
    const collectedTokens: TokenBalance[] = []
    const walletAddress = this.getWalletAddress()

    // Собираем USDT
    const usdtBalance = await this.getTokenBalance(TOKENS.USDT)
    if (usdtBalance > 0n) {
      try {
        const swapResult = await this.swap.getQuote(
          TOKENS.USDT,
          TOKENS.ETH,
          usdtBalance.toString(),
          walletAddress
        )

        if (swapResult.transactionRequest) {
          // Получаем адрес контракта LI.FI из котировки
          const lifiContractAddress = swapResult.transactionRequest.to

          // Проверяем allowance
          const currentAllowance = await this.checkAllowance(TOKENS.USDT, lifiContractAddress)

          if (currentAllowance < usdtBalance) {
            const approveSuccess = await this.approveToken(TOKENS.USDT, lifiContractAddress, usdtBalance)
            if (!approveSuccess) {
              return collectedTokens
            }
            await new Promise(resolve => setTimeout(resolve, 30000))
          }

          const txResult = await this.swap.executeTransaction(swapResult.transactionRequest)
          if (txResult.success) {
            collectedTokens.push({
              token: 'USDT',
              symbol: 'USDT',
              balance: formatUnits(usdtBalance, 6),
              balanceWei: usdtBalance
            })
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      } catch (error) {
        logger.error('Ошибка обмена USDT', error)
      }
    }

    // Собираем USDC.e
    const usdcBalance = await this.getTokenBalance(TOKENS.USDC_e)
    if (usdcBalance > 0n) {
      try {
        const swapResult = await this.swap.getQuote(
          TOKENS.USDC_e,
          TOKENS.ETH,
          usdcBalance.toString(),
          walletAddress
        )

        if (swapResult.transactionRequest) {
          // Получаем адрес контракта LI.FI из котировки
          const lifiContractAddress = swapResult.transactionRequest.to

          // Проверяем allowance
          const currentAllowance = await this.checkAllowance(TOKENS.USDC_e, lifiContractAddress)

          if (currentAllowance < usdcBalance) {
            const approveSuccess = await this.approveToken(TOKENS.USDC_e, lifiContractAddress, usdcBalance)
            if (!approveSuccess) {
              return collectedTokens
            }
            await new Promise(resolve => setTimeout(resolve, 30000))
          }

          const txResult = await this.swap.executeTransaction(swapResult.transactionRequest)
          if (txResult.success) {
            collectedTokens.push({
              token: 'USDC.e',
              symbol: 'USDC.e',
              balance: formatUnits(usdcBalance, 6),
              balanceWei: usdcBalance
            })
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      } catch (error) {
        logger.error('Ошибка обмена USDC.e', error)
      }
    }

    // Собираем USDSC
    const usdscBalance = await this.getTokenBalance(TOKENS.USDSC)
    if (usdscBalance > 0n) {
      try {
        const usdscDecimals = Number(
          await this.client.readContract({
            address: TOKENS.USDSC as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'decimals'
          })
        )

        const swapResult = await this.swap.getQuote(
          TOKENS.USDSC,
          TOKENS.ETH,
          usdscBalance.toString(),
          walletAddress
        )

        if (swapResult.transactionRequest) {
          const lifiContractAddress = swapResult.transactionRequest.to

          const currentAllowance = await this.checkAllowance(TOKENS.USDSC, lifiContractAddress)

          if (currentAllowance < usdscBalance) {
            const approveSuccess = await this.approveToken(TOKENS.USDSC, lifiContractAddress, usdscBalance)
            if (!approveSuccess) {
              return collectedTokens
            }
            await new Promise(resolve => setTimeout(resolve, 30000))
          }

          const txResult = await this.swap.executeTransaction(swapResult.transactionRequest)
          if (txResult.success) {
            collectedTokens.push({
              token: 'USDSC',
              symbol: 'USDSC',
              balance: formatUnits(usdscBalance, usdscDecimals),
              balanceWei: usdscBalance
            })
            await new Promise(resolve => setTimeout(resolve, 30000))
          }
        }
      } catch (error) {
        logger.error('Ошибка обмена USDSC', error)
      }
    }

    return collectedTokens
  }

  /**
   * Проверить ликвидность в протоколе Aave
   */
  async checkAaveLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.AAVE_A_TOKEN)
      return {
        protocol: 'Aave',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.AAVE_A_TOKEN
      }
    } catch (error) {
      logger.error('Ошибка проверки ликвидности Aave', error)
      return {
        protocol: 'Aave',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.AAVE_A_TOKEN
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Morpho
   */
  async checkMorphoLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.MORPHO_METAMORPHO)

      // Получаем правильные decimals для токена Morpho
      const decimals = await this.client.readContract({
        address: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals'
      })

      return {
        protocol: 'Morpho',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, decimals as number),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO
      }
    } catch (error) {
      logger.error('Ошибка проверки ликвидности Morpho', error)
      return {
        protocol: 'Morpho',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.MORPHO_METAMORPHO
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Stargate
   */
  async checkStargateLiquidity (): Promise<LiquidityInfo> {
    try {
      const redeemable = await this.client.readContract({
        address: PROTOCOL_CONTRACTS.STARGATE_POOL as `0x${string}`,
        abi: STARGATE_ABI,
        functionName: 'redeemable',
        args: [this.getWalletAddress()]
      })

      const balance = redeemable as bigint
      return {
        protocol: 'Stargate',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.STARGATE_POOL
      }
    } catch (error) {
      logger.error('Ошибка проверки ликвидности Stargate', error)
      return {
        protocol: 'Stargate',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.STARGATE_POOL
      }
    }
  }

  /**
   * Проверить ликвидность в протоколе Sake Finance
   */
  async checkSakeFinanceLiquidity (): Promise<LiquidityInfo> {
    try {
      const balance = await this.getTokenBalance(PROTOCOL_CONTRACTS.SAKE_ATOKEN)
      return {
        protocol: 'Sake Finance',
        hasLiquidity: balance > 0n,
        balance: formatUnits(balance, 6),
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.SAKE_ATOKEN
      }
    } catch (error) {
      logger.error('Ошибка проверки ликвидности Sake Finance', error)
      return {
        protocol: 'Sake Finance',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.SAKE_ATOKEN
      }
    }
  }

  /**
   * Проверить ликвидность в Untitled Bank
   */
  async checkUntitledBankLiquidity (): Promise<LiquidityInfo> {
    try {
      const preview = await getUntitledBankWithdrawPreview(this.account.address)
      const hasLiquidity = preview.plan.status === 'available' && preview.plan.sharesToRedeem > 0n
      const balance = hasLiquidity ? preview.plan.sharesToRedeem : 0n

      return {
        protocol: 'Untitled Bank',
        hasLiquidity,
        balance: hasLiquidity ? formatUnits(balance, 6) : '0',
        balanceWei: balance,
        tokenAddress: PROTOCOL_CONTRACTS.UNTITLED_BANK
      }
    } catch (error) {
      logger.error('Ошибка проверки ликвидности Untitled Bank', error)
      return {
        protocol: 'Untitled Bank',
        hasLiquidity: false,
        balance: '0',
        balanceWei: 0n,
        tokenAddress: PROTOCOL_CONTRACTS.UNTITLED_BANK
      }
    }
  }

  /**
   * Проверить ликвидность во всех протоколах
   */
  async checkAllLiquidity (): Promise<LiquidityInfo[]> {
    const [aave, morpho, stargate, sake, untitledBank] = await Promise.all([
      this.checkAaveLiquidity(),
      this.checkMorphoLiquidity(),
      this.checkStargateLiquidity(),
      this.checkSakeFinanceLiquidity(),
      this.checkUntitledBankLiquidity()
    ])

    return [aave, morpho, stargate, sake, untitledBank]
  }

  /**
   * Вывести ликвидность из протокола Aave
   */
  async withdrawFromAave (): Promise<boolean> {
    try {

      // Используем улучшенную функцию из модуля AAVE с gas estimation и retry
      const transactionHash = await redeemAaveLiquidity(this.privateKey)

      if (transactionHash) {
        return true
      } else {
        logger.error('Ошибка вывода ликвидности из Aave')
        return false
      }
    } catch (error) {
      logger.error('Ошибка вывода из Aave', error)
      return false
    }
  }

  /**
   * Вывести ликвидность из протокола Morpho
   */
  async withdrawFromMorpho (): Promise<WithdrawalExecutionOutcome> {
    try {
      const transactionHash = await redeemMorphoLiquidity(this.privateKey, null)
      return transactionHash ? 'withdrawn' : 'failed'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMorphoNotEnoughLiquidityError(message)) {
        logger.warn('[Morpho] Недостаточно ликвидности в vault — попробуйте позже')
        return 'skipped'
      }
      return 'failed'
    }
  }

  /**
   * Вывести ликвидность из протокола Stargate
   */
  async withdrawFromStargate (amount: bigint): Promise<WithdrawalExecutionOutcome> {
    try {
      const transactionHash = await redeemStargateLiquidity(this.privateKey, formatUnits(amount, 6))
      return resolveCollectorWithdrawalOutcome('Stargate', transactionHash)
    } catch (error) {
      logger.error('Ошибка вывода из Stargate', error)
      return 'failed'
    }
  }

  /**
   * Вывести ликвидность из всех протоколов
   */
  async withdrawAllLiquidity (liquidityInfo: LiquidityInfo[]): Promise<LiquidityInfo[]> {
    const withdrawnLiquidity: LiquidityInfo[] = []

    for (const info of liquidityInfo) {
      if (!info.hasLiquidity || info.balanceWei === 0n) continue

      let outcome: WithdrawalExecutionOutcome = 'failed'

      switch (info.protocol) {
      case 'Aave':
        outcome = await this.withdrawFromAave() ? 'withdrawn' : 'failed'
        break
      case 'Morpho':
        outcome = await this.withdrawFromMorpho()
        break
      case 'Stargate':
        outcome = await this.withdrawFromStargate(info.balanceWei)
        break
      case 'Sake Finance':
        outcome = await this.withdrawFromSakeFinance()
        break
      case 'Untitled Bank':
        outcome = await this.withdrawFromUntitledBank()
        break
      }

      if (outcome === 'withdrawn') {
        withdrawnLiquidity.push(info)
      } else if (outcome === 'failed') {
        logger.error(`Ошибка вывода ликвидности из ${info.protocol}`)
      }
    }

    return withdrawnLiquidity
  }

  /**
   * Вывести ликвидность из Sake Finance (ERC20 токен)
   */
  async withdrawFromSakeFinance (): Promise<WithdrawalExecutionOutcome> {
    try {
      const transactionHash = await redeemLiquidity(this.privateKey)
      return resolveCollectorWithdrawalOutcome('Sake Finance', transactionHash)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const handling = classifySakeWithdrawRuntimeHandling(message)
      if (handling.skip) {
        logger.warn(`[Sake] Вывод пропущен: ${handling.message}`)
        return 'skipped'
      }
      logger.error('Ошибка вывода из Sake Finance', error)
      return 'failed'
    }
  }

  /**
   * Вывести ликвидность из Untitled Bank
   */
  async withdrawFromUntitledBank (): Promise<WithdrawalExecutionOutcome> {
    try {
      const transactionHash = await withdrawFromUntitledBank(this.privateKey)
      return resolveCollectorWithdrawalOutcome('Untitled Bank', transactionHash)
    } catch (error) {
      logger.error('Ошибка вывода из Untitled Bank', error)
      return 'failed'
    }
  }

  /**
   * Основная функция сбора
   */
  async performCollection (): Promise<CollectionResult> {
    try {
      const walletAddress = this.getWalletAddress()
      const initialETHBalance = await this.getETHBalance()
      const liquidityInfo = await this.checkAllLiquidity()
      const withdrawnLiquidity = await this.withdrawAllLiquidity(liquidityInfo)
      const collectedTokens = await this.collectTokens()
      const finalETHBalance = await this.getETHBalance()
      const totalCollected = (parseFloat(finalETHBalance) - parseFloat(initialETHBalance)).toString()

      return {
        success: true,
        walletAddress,
        initialETHBalance,
        finalETHBalance,
        collectedTokens,
        liquidityFound: liquidityInfo.filter(info => info.hasLiquidity),
        withdrawnLiquidity,
        totalCollected
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка'
      logger.error('Ошибка в модуле сборщика', errorMessage)
      return {
        success: false,
        walletAddress: this.getWalletAddress(),
        initialETHBalance: '0',
        finalETHBalance: '0',
        collectedTokens: [],
        liquidityFound: [],
        withdrawnLiquidity: [],
        totalCollected: '0',
        error: errorMessage
      }
    }
  }
}

/**
 * Основная функция модуля сборщика
 */
export async function performCollection (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  initialETHBalance?: string
  finalETHBalance?: string
  totalCollected?: string
  collectedTokensCount?: number
  liquidityFoundCount?: number
  withdrawnLiquidityCount?: number
  error?: string
}> {
  try {
    logger.moduleStart('Soneium Collector')

    const collector = new SoneiumCollector(privateKey)
    const result = await collector.performCollection()

    if (result.success) {
      logger.success('Модуль сборщика выполнен успешно')
      logger.info(`Собрано ${result.totalCollected} ETH`)

      return {
        success: true,
        walletAddress: result.walletAddress,
        initialETHBalance: result.initialETHBalance,
        finalETHBalance: result.finalETHBalance,
        totalCollected: result.totalCollected,
        collectedTokensCount: result.collectedTokens.length,
        liquidityFoundCount: result.liquidityFound.length,
        withdrawnLiquidityCount: result.withdrawnLiquidity.length
      }
    } else {
      logger.error(`Ошибка модуля сборщика: ${result.error}`)
      return {
        success: false,
        error: result.error || 'Неизвестная ошибка'
      }
    }

  } catch (error) {
    logger.moduleEnd('Soneium Collector', false)
    logger.error('Критическая ошибка модуля сборщика', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}
