import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'

// Адрес контракта GameHubUpgradeable
const CONTRACT_ADDRESS = '0x983B499181A1B376CEE9Ffe18984cF62A767f745' as `0x${string}`

// ABI контракта
const CONTRACT_ABI = [
  {
    inputs: [
      { internalType: 'string', name: 'gameId', type: 'string' },
      { internalType: 'string', name: 'action', type: 'string' },
      { internalType: 'uint256', name: 'value', type: 'uint256' },
      { internalType: 'uint256', name: 'randomNums', type: 'uint256' },
      { internalType: 'uint256', name: 'maxInt', type: 'uint256' }
    ],
    name: 'recordActionWithRandom',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const

// Фиксированные параметры транзакции (cyber-roulette, один спин)
const GAME_ID = 'cyber-roulette'
const ACTION = 'spin'
const VALUE = BigInt(0)
const RANDOM_NUMS = BigInt(1)
const MAX_INT = BigInt(1000)

const publicClient = rpcManager.createPublicClient(soneiumChain)

/**
 * Выполняет модуль Harkan: один спин в cyber-roulette.
 * При каждом запуске модуля выполняется одна транзакция.
 */
export async function performHarkan (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  transactionHash?: string
  error?: string
  message?: string
  skipped?: boolean
  reason?: string
}> {
  try {
    const account = privateKeyToAccount(privateKey)
    logger.info(`Harkan: спин для ${account.address}`)

    const walletClient = rpcManager.createWalletClient(soneiumChain, account)

    const txResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account: account,
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: 'recordActionWithRandom',
        args: [GAME_ID, ACTION, VALUE, RANDOM_NUMS, MAX_INT]
      }
    )

    if (!txResult.success) {
      return {
        success: false,
        walletAddress: account.address,
        error: txResult.error || 'Ошибка отправки транзакции'
      }
    }

    const hash = txResult.hash
    logger.transaction(hash, 'sent', 'HARKAN')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'success') {
      logger.transaction(hash, 'confirmed', 'HARKAN', account.address)
      return {
        success: true,
        walletAddress: account.address,
        transactionHash: hash,
        message: 'Спин выполнен успешно'
      }
    } else {
      logger.transaction(hash, 'failed', 'HARKAN', account.address)
      return {
        success: false,
        walletAddress: account.address,
        transactionHash: hash,
        error: 'Transaction reverted'
      }
    }
  } catch (error) {
    logger.error('Ошибка при выполнении Harkan', error)
    throw error
  }
}
