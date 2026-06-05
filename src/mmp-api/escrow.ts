/**
 * Escrow контракт MMP — источник `transaction_id` для bridge OUT/IN.
 *
 * Ключевые открытия (из IL2CPP-декомпиляции, см. RESEARCH_STATUS.md):
 *   - `deposit(address[] tokens, uint256[] amounts, address beneficiary) → uint256`
 *     возвращает transactionId, но через тx receipt мы вытаскиваем его из
 *     event'а `Deposited(uint256 indexed transactionId, ...)`.
 *   - Сервер видит deposit on-chain и потом сам делает `release(transactionId)`,
 *     чем фактически переводит средства / минтит токены через MintRouter.
 *
 * Bridge OUT (in-game items → on-chain CORN_SEED):
 *   1. POST /inventory/exports/price → fee (wei)
 *   2. Escrow.deposit([address(0)], [fee], wallet) с msg.value = fee
 *   3. Парсим Deposited event → transactionId
 *   4. POST /inventory/exports {items, nfts, transaction_id}
 *
 * Bridge IN (on-chain CORN_SEED → in-game inventory):
 *   1. ERC-20 approve(CORN_SEED, escrow, amount)
 *   2. Escrow.deposit([CORN_SEED], [amount], wallet)
 *   3. Парсим Deposited event → transactionId
 *   4. POST /inventory/imports {items, nfts, transaction_id}
 */
import {
  decodeEventLog,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient
} from 'viem'

export const ESCROW_ADDRESS: Address = '0xe3b426925cc07f2e812d51fa9386f442649b7bb0'

/**
 * ABI Escrow — только методы и event-ы, которые мы используем.
 * Полный ABI лежит в `/tmp/unity_dump/abis/Escrow.json`.
 */
export const ESCROW_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [
      { name: '_tokens', type: 'address[]' },
      { name: '_amounts', type: 'uint256[]' },
      { name: '_beneficiary', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'transactions',
    stateMutability: 'view',
    inputs: [{ name: '_index', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'token', type: 'address[]' },
          { name: 'amount', type: 'uint256[]' },
          { name: 'depositor', type: 'address' },
          { name: 'beneficiary', type: 'address' },
          { name: 'released', type: 'bool' }
        ]
      }
    ]
  },
  {
    type: 'function',
    name: 'counts',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'pendings',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'address' },
      { name: '', type: 'uint256' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_index', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_index', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'event',
    name: 'Deposited',
    anonymous: false,
    inputs: [
      { name: 'transactionId', type: 'uint256', indexed: true },
      { name: 'tokens', type: 'address[]', indexed: true },
      { name: 'amounts', type: 'uint256[]', indexed: false },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'beneficiary', type: 'address', indexed: false }
    ]
  },
  {
    type: 'event',
    name: 'Released',
    anonymous: false,
    inputs: [{ name: 'transactionId', type: 'uint256', indexed: true }]
  },
  {
    type: 'event',
    name: 'Refunded',
    anonymous: false,
    inputs: [{ name: 'transactionId', type: 'uint256', indexed: true }]
  }
] as const

/** ETH-плейсхолдер. Escrow.deposit принимает address(0) для ETH-fee. */
export const NATIVE_TOKEN_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * Возвращает transactionId, ища `Deposited` event в логах receipt-а.
 * Если событие не найдено — бросает.
 */
export function extractTransactionIdFromReceipt (
  receipt: TransactionReceipt
): bigint {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: ESCROW_ABI,
        data: log.data,
        topics: log.topics
      })
      if (decoded.eventName === 'Deposited') {
        // args.transactionId: bigint (uint256)
        return (decoded.args as { transactionId: bigint }).transactionId
      }
    } catch {
      // not our event — skip
    }
  }
  throw new Error(
    `Escrow Deposited event not found in receipt ${receipt.transactionHash}`
  )
}

/**
 * Pre-encode calldata для Escrow.deposit. Полезно если хотим отправить tx
 * через safeWriteContract или sendTransaction вручную.
 */
export function encodeEscrowDeposit (
  tokens: readonly Address[],
  amounts: readonly bigint[],
  beneficiary: Address
): Hex {
  return encodeFunctionData({
    abi: ESCROW_ABI,
    functionName: 'deposit',
    args: [
      tokens as Address[],
      amounts as bigint[],
      beneficiary
    ]
  })
}

/**
 * Read-only: статус транзакции по indexed-id.
 * Полезно для отладки — нам обычно достаточно `pending_transaction_id` от API.
 */
export async function readEscrowTransaction (
  publicClient: PublicClient,
  transactionId: bigint
): Promise<{
  tokens: Address[]
  amounts: bigint[]
  depositor: Address
  beneficiary: Address
  released: boolean
}> {
  const result = (await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'transactions',
    args: [transactionId]
  })) as {
    token: readonly Address[]
    amount: readonly bigint[]
    depositor: Address
    beneficiary: Address
    released: boolean
  }
  return {
    tokens: [...result.token],
    amounts: [...result.amount],
    depositor: result.depositor,
    beneficiary: result.beneficiary,
    released: result.released
  }
}

/** Текущий счётчик транзакций. Diagnostic. */
export async function readEscrowCounts (
  publicClient: PublicClient
): Promise<bigint> {
  return (await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'counts'
  })) as bigint
}

/** Escrow на паузе? Если да — bridge OUT/IN временно недоступен. */
export async function isEscrowPaused (
  publicClient: PublicClient
): Promise<boolean> {
  return (await publicClient.readContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'paused'
  })) as boolean
}

/** Тип ABI для использования в client-коде (избавляемся от readonly). */
export type EscrowAbi = typeof ESCROW_ABI

/** Минимальный ERC-20 ABI — для approve в bridge IN. */
export const ERC20_MIN_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }]
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }]
  }
] as const

// Подсказка: WalletClient/PublicClient импортируются для удобства typing,
// сами функции выше принимают их как аргумент.
export type { Address, Hex, PublicClient, WalletClient, TransactionReceipt }
