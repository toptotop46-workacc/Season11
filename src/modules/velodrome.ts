import { parseEther, formatEther, formatUnits, parseUnits, encodeAbiParameters, encodeFunctionData, toHex, concat, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeSendTransaction } from '../transaction-utils.js'
import { logger } from '../logger.js'
import type { PublicClient } from 'viem'

// Адреса контрактов на Soneium
const UNIVERSAL_ROUTER_ADDRESS = '0x01D40099fCD87C018969B0e8D4aB1633Fb34763C' as `0x${string}`
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as `0x${string}`
const USDC_E_ADDRESS = '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369' as `0x${string}`

// Конфигурация
const FEE_TIER = 100 // 0.01%
const SLIPPAGE_TOLERANCE = 1.0 // 1%
const MIN_BALANCE_ETH = parseEther('0.000001') // Минимальный баланс для свапа
const MIN_SWAP_AMOUNT_ETH = parseEther('0.000001') // Минимальная сумма свапа

// Команды UniversalRouter
const COMMANDS = {
  WRAP_ETH: 0x0b,
  V3_SWAP_EXACT_IN: 0x00
} as const

// ABI для UniversalRouter
const UNIVERSAL_ROUTER_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes', internalType: 'bytes' },
      { name: 'inputs', type: 'bytes[]', internalType: 'bytes[]' },
      { name: 'deadline', type: 'uint256', internalType: 'uint256' }
    ],
    outputs: []
  }
] as const

// ABI для V3 Quoter
const QUOTER_V3_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  }
] as const

// ABI для V4 Quoter
const QUOTER_V4_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' }
            ]
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' }
        ]
      }
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' }
    ]
  }
] as const

const publicClient = rpcManager.createPublicClient(soneiumChain)

async function getEthBalance (address: `0x${string}`): Promise<bigint> {
  return await publicClient.getBalance({ address })
}

async function getETHPriceFromAPI (): Promise<number | null> {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    const data = await response.json()
    return parseFloat(data.ethereum.usd)
  } catch {
    logger.warn('Не удалось получить цену ETH через API')
    return null
  }
}

async function getQuoteV4 (publicClient: PublicClient, tokenIn: `0x${string}`, tokenOut: `0x${string}`, fee: number, tickSpacing: number, amountIn: bigint): Promise<bigint | null> {
  const V4_QUOTER_ADDRESS = '0x3972c00f7ed4885e145823eb7c655375d275a1c5' as `0x${string}`
  const HOOKS_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

  try {
    const currency0 = tokenIn === WETH_ADDRESS ? '0x0000000000000000000000000000000000000000' : tokenIn
    const currency1 = tokenOut

    const result = await publicClient.readContract({
      address: V4_QUOTER_ADDRESS,
      abi: QUOTER_V4_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        poolKey: {
          currency0: currency0 as `0x${string}`,
          currency1: currency1,
          fee: fee,
          tickSpacing: tickSpacing,
          hooks: HOOKS_ADDRESS
        },
        zeroForOne: true,
        exactAmount: amountIn,
        hookData: '0x'
      }]
    })

    const amountOut = result[0]
    if (amountOut && amountOut > 0n) {
      return amountOut
    }
  } catch {
    return null
  }

  return null
}

async function getQuote (publicClient: PublicClient, tokenIn: `0x${string}`, tokenOut: `0x${string}`, fee: number, amountIn: bigint): Promise<bigint | null> {
  const V4_TICK_SPACING = 10
  const feeTiers = [500, fee]

  for (const feeTier of feeTiers) {
    const v4Quote = await getQuoteV4(publicClient, tokenIn, tokenOut, feeTier, V4_TICK_SPACING, amountIn)
    if (v4Quote) {
      return v4Quote
    }
  }

  const quoterAddresses = [
    '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a'
  ]

  for (const quoterAddress of quoterAddresses) {
    try {
      const amountOut = await publicClient.readContract({
        address: quoterAddress as `0x${string}`,
        abi: QUOTER_V3_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amountIn, 0n]
      })

      if (amountOut && amountOut > 0n) {
        return amountOut
      }
    } catch {
      continue
    }
  }

  const ethPrice = await getETHPriceFromAPI()

  if (ethPrice) {
    const amountInETH = parseFloat(formatEther(amountIn))
    const amountOutUSD = amountInETH * ethPrice
    const amountOut = parseUnits(amountOutUSD.toFixed(6), 6)
    return amountOut
  }

  return null
}

function encodeV3Path (tokens: `0x${string}`[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) {
    throw new Error('Количество токенов должно быть на 1 больше количества fee tiers')
  }

  let path = tokens[0]!.slice(2)
  for (let i = 0; i < fees.length; i++) {
    const fee = fees[i]!.toString(16).padStart(6, '0')
    const token = tokens[i + 1]!.slice(2)
    path += fee + token
  }

  return `0x${path}` as `0x${string}`
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

async function performVelodromeSwap (
  privateKey: `0x${string}`,
  amountIn: bigint
): Promise<{ success: boolean; hash?: `0x${string}`; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey)
    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const universalRouter = getAddress(UNIVERSAL_ROUTER_ADDRESS)
    const weth = getAddress(WETH_ADDRESS)
    const usdcE = getAddress(USDC_E_ADDRESS)

    let amountOutMin: bigint
    const quote = await getQuote(publicClient, weth, usdcE, FEE_TIER, amountIn)

    if (quote) {
      const slippageMultiplier = BigInt(10000 - Math.floor(SLIPPAGE_TOLERANCE * 100))
      amountOutMin = (quote * slippageMultiplier) / BigInt(10000)
    } else {
      const estimatedOut = parseUnits((parseFloat(formatEther(amountIn)) * 3000).toFixed(6), 6)
      amountOutMin = (estimatedOut * BigInt(10000 - Math.floor(SLIPPAGE_TOLERANCE * 100))) / BigInt(10000)
      logger.warn(`Используем приблизительную оценку минимального выхода: ${formatUnits(amountOutMin, 6)} USDC.e`)
    }

    const path = encodeV3Path([weth, usdcE], [FEE_TIER])

    const commands = concat([
      toHex(COMMANDS.WRAP_ETH, { size: 1 }),
      toHex(COMMANDS.V3_SWAP_EXACT_IN, { size: 1 })
    ])

    const inputs: `0x${string}`[] = []

    inputs.push(
      encodeAbiParameters(
        [{ name: 'recipient', type: 'address' }, { name: 'amountMin', type: 'uint256' }],
        [universalRouter, amountIn]
      ) as `0x${string}`
    )

    inputs.push(
      encodeAbiParameters(
        [
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' },
          { name: 'path', type: 'bytes' },
          { name: 'payerIsUser', type: 'bool' },
          { name: 'isUni', type: 'bool' }
        ],
        [
          account.address,
          amountIn,
          amountOutMin,
          path,
          false,
          false
        ]
      ) as `0x${string}`
    )

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)

    const data = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, inputs, deadline]
    })

    let gasEstimate: bigint
    try {
      gasEstimate = await publicClient.estimateGas({
        account,
        to: universalRouter,
        data,
        value: amountIn
      })
    } catch {
      logger.warn('Не удалось оценить газ, используем стандартный лимит')
      gasEstimate = 300000n
    }

    const txResult = await safeSendTransaction(
      publicClient,
      walletClient,
      account.address,
      {
        to: universalRouter,
        data,
        value: amountIn,
        gas: (gasEstimate * BigInt(120)) / BigInt(100)
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'VELODROME')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'VELODROME', account.address)
      return {
        success: true,
        hash
      }
    } else {
      logger.transaction(hash, 'failed', 'VELODROME', account.address)
      return {
        success: false,
        hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении свапа', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка'
    }
  }
}

/**
 * Выполняет модуль Velodrome: один свап ETH → USDC.e (0.1–1% от баланса) через Universal Router.
 */
export async function performVelodrome (
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
    logger.moduleStart('Velodrome')

    const balance = await getEthBalance(account.address)
    const balanceETH = formatEther(balance)

    if (balance < MIN_BALANCE_ETH) {
      logger.warn(`Недостаточно ETH для свапа. Минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`)
      logger.moduleEnd('Velodrome', false)
      return {
        success: false,
        walletAddress: account.address,
        error: `Недостаточно ETH. Баланс: ${balanceETH} ETH, минимум: ${formatEther(MIN_BALANCE_ETH)} ETH`
      }
    }

    const swapAmount = calculateSwapAmount(balance)
    const swapAmountETH = formatEther(swapAmount)

    const swapResult = await performVelodromeSwap(privateKey, swapAmount)

    if (swapResult.success && swapResult.hash) {
      logger.moduleEnd('Velodrome', true)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: swapResult.hash,
        swapAmount: swapAmountETH
      }
    } else {
      logger.moduleEnd('Velodrome', false)
      return {
        success: false,
        walletAddress: account.address,
        swapAmount: swapAmountETH,
        error: swapResult.error || 'Ошибка выполнения свапа'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении Velodrome', error)
    logger.moduleEnd('Velodrome', false)
    throw error
  }
}
