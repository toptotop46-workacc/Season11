/**
 * MMP Quest — оркестратор полного флоу квеста Soneium Score Season 10
 * "Plant 3 corn seeds (and 1 tomato seed)".
 *
 * Архитектура (см. RESEARCH_STATUS.md "МАЙ-2026 КРИТИЧЕСКОЕ ОТКРЫТИЕ"):
 *  1. Auth (signup/login/tx-quota)
 *  2. Создание персонажа + tutorial=1
 *  3. Initial farmSaveData.json (default decorations)
 *  4. ⚠️ Wild zone — сбор 15 wood + 45 stone (БЛОКЕР: anti-cheat RNG, см. ниже)
 *  5. unclejack/craft recipe=1 amount=1 → on-chain mint 1 TOMATOSEED
 *  6. Plant tomato (savefile placement) + tutorial=7..10
 *  7. on-chain approve+deposit 1 TOMATOSEED → SmartFarmer Tomato
 *  8. unclejack/craft recipe=2 amount=3 → on-chain mint 3 CORNSEED
 *  9. Plant corn (savefile placement)
 * 10. on-chain approve+deposit 3 CORNSEED → SmartFarmer Corn ← QUEST ВЫПОЛНЕН
 *
 * Идемпотентность:
 *  - Каждый шаг проверяет состояние (inventory/farm/staked) перед выполнением.
 *  - Если квест уже выполнен (≥3 CORNSEED застейканы), модуль завершает
 *    скиппом без операций.
 *  - При недостатке wood/stone модуль возвращает skipped=true с информативным
 *    `reason` (нужно вручную пройти wild-zone один раз — RNG ещё не cracked).
 *
 * См. также:
 *  - mmp-farm.ts — только on-chain stake (читает baseline из этого модуля)
 *  - mmp-seed-transfer.ts — альтернативный путь: master-wallet раздаёт семена
 */

import {
  type Address,
  formatEther,
  formatUnits,
  parseUnits
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcManager, soneiumChain } from '../rpc-manager.js'
import { safeWriteContract } from '../transaction-utils.js'
import { logger } from '../logger.js'
import {
  MMP_TOKEN_ADDRESSES,
  MMP_CONTRACT_ADDRESSES,
  type FarmSaveContent,
  type InventoryItemsData
} from '../mmp-api/index.js'
import { createMmpClientWithProxy } from './mmp-proxy.js'
import { performMmpWild } from './mmp-wild.js'
import {
  checkMmpPortalProgress,
  MMP_QUEST_DAPP_ID,
  type MmpPortalQuestProgress
} from './mmp-portal-check.js'

// ============================================================
// CONSTANTS
// ============================================================

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], name: 'allowance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'approve', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' }
] as const

const SMART_FARMER_ABI = [
  { inputs: [{ name: '_amount', type: 'uint256' }], name: 'deposit', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'userInfo',
    outputs: [
      { name: 'userIndex', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
      { name: 'depositBlock', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  { inputs: [], name: 'paused', outputs: [{ name: '', type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'poolMinPerUser', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }
] as const

const MAX_UINT256 = (1n << 256n) - 1n

const TOMATO_ADDRESS = MMP_TOKEN_ADDRESSES.tomatoSeed as Address
const CORN_ADDRESS = MMP_TOKEN_ADDRESSES.cornSeed as Address
const FARM_TOMATO = MMP_CONTRACT_ADDRESSES.farmTomatoSeed as Address
const FARM_CORN = MMP_CONTRACT_ADDRESSES.farmCornSeed as Address

/** Расходы по recipe (см. RESEARCH_STATUS.md). */
const RECIPE_TOMATO = { recipeId: 1, amounts: 1, woodCost: 15 }
const RECIPE_CORN_X3 = { recipeId: 2, amounts: 3, stoneCost: 15 * 3 }

/** Целевое количество для квеста. */
const TARGET_TOMATO = 1n        // 1 TOMATOSEED стейкается в туториале
const TARGET_CORN = 3n          // 3 CORNSEED стейкается для S10 квеста

/** Координаты плантаций (взяты из реального HAR completion). */
const TOMATO_PLACEMENT = { x: 17, y: 0, z: 31, plantingID: '[tomato]-[tomato-seed]' }
const CORN_PLACEMENT = { x: 10, y: 0, z: 16, plantingID: '[corn]-[corn-seed]' }

/**
 * Default decorations — 77 элементов забора/дорожек, как ставит реальный
 * Unity-клиент при первом farmSaveData POST. Скопировано из HAR
 * (entry #99, decoded from new HAR farmSaveData.json initial save).
 *
 * Сервер не валидирует декорации, но клиент использует их как baseline.
 */
const DEFAULT_FARM_DECORATIONS: FarmSaveContent['decorations'] = [
  { x: 24, y: 12, orient: 3, id: 50 }, { x: 24, y: 15, orient: 3, id: 50 },
  { x: 24, y: 18, orient: 3, id: 50 }, { x: 24, y: 21, orient: 3, id: 50 },
  { x: 24, y: 24, orient: 3, id: 50 }, { x: 24, y: 27, orient: 3, id: 50 },
  { x: 24, y: 33, orient: 3, id: 50 }, { x: 24, y: 36, orient: 3, id: 50 },
  { x: 24, y: 39, orient: 3, id: 50 }, { x: 24, y: 42, orient: 3, id: 50 },
  { x: 24, y: 45, orient: 3, id: 50 }, { x: 24, y: 48, orient: 3, id: 50 },
  { x: 25, y: 12, orient: 0, id: 50 }, { x: 25, y: 50, orient: 0, id: 50 },
  { x: 28, y: 12, orient: 0, id: 50 }, { x: 28, y: 50, orient: 0, id: 50 },
  { x: 31, y: 12, orient: 0, id: 50 }, { x: 31, y: 50, orient: 0, id: 50 },
  { x: 34, y: 12, orient: 0, id: 50 }, { x: 34, y: 50, orient: 0, id: 50 },
  { x: 37, y: 12, orient: 0, id: 50 }, { x: 37, y: 50, orient: 0, id: 50 },
  { x: 40, y: 12, orient: 0, id: 50 }, { x: 40, y: 50, orient: 0, id: 50 },
  { x: 43, y: 12, orient: 3, id: 50 }, { x: 43, y: 15, orient: 3, id: 50 },
  { x: 43, y: 18, orient: 3, id: 50 }, { x: 43, y: 21, orient: 3, id: 50 },
  { x: 43, y: 24, orient: 3, id: 50 }, { x: 43, y: 27, orient: 3, id: 50 },
  { x: 43, y: 33, orient: 3, id: 50 }, { x: 43, y: 36, orient: 3, id: 50 },
  { x: 43, y: 39, orient: 3, id: 50 }, { x: 43, y: 42, orient: 3, id: 50 },
  { x: 43, y: 45, orient: 3, id: 50 }, { x: 43, y: 48, orient: 3, id: 50 },
  { x: 21, y: 12, orient: 0, id: 65 }, { x: 21, y: 15, orient: 0, id: 65 },
  { x: 21, y: 18, orient: 0, id: 65 }, { x: 21, y: 21, orient: 0, id: 65 },
  { x: 21, y: 24, orient: 0, id: 65 }, { x: 21, y: 27, orient: 0, id: 65 },
  { x: 21, y: 33, orient: 0, id: 65 }, { x: 21, y: 36, orient: 0, id: 65 },
  { x: 21, y: 39, orient: 0, id: 65 }, { x: 21, y: 42, orient: 0, id: 65 },
  { x: 21, y: 45, orient: 0, id: 65 }, { x: 21, y: 48, orient: 0, id: 65 },
  { x: 22, y: 9, orient: 0, id: 65 }, { x: 22, y: 51, orient: 0, id: 65 },
  { x: 25, y: 9, orient: 0, id: 65 }, { x: 25, y: 51, orient: 0, id: 65 },
  { x: 28, y: 9, orient: 0, id: 65 }, { x: 28, y: 51, orient: 0, id: 65 },
  { x: 31, y: 9, orient: 0, id: 65 }, { x: 31, y: 51, orient: 0, id: 65 },
  { x: 34, y: 9, orient: 0, id: 65 }, { x: 34, y: 51, orient: 0, id: 65 },
  { x: 37, y: 9, orient: 0, id: 65 }, { x: 37, y: 51, orient: 0, id: 65 },
  { x: 40, y: 9, orient: 0, id: 65 }, { x: 40, y: 51, orient: 0, id: 65 },
  { x: 43, y: 9, orient: 0, id: 65 }, { x: 43, y: 51, orient: 0, id: 65 },
  { x: 44, y: 12, orient: 0, id: 65 }, { x: 44, y: 15, orient: 0, id: 65 },
  { x: 44, y: 18, orient: 0, id: 65 }, { x: 44, y: 21, orient: 0, id: 65 },
  { x: 44, y: 24, orient: 0, id: 65 }, { x: 44, y: 27, orient: 0, id: 65 },
  { x: 44, y: 30, orient: 0, id: 65 }, { x: 44, y: 33, orient: 0, id: 65 },
  { x: 44, y: 36, orient: 0, id: 65 }, { x: 44, y: 39, orient: 0, id: 65 },
  { x: 44, y: 42, orient: 0, id: 65 }, { x: 44, y: 45, orient: 0, id: 65 },
  { x: 44, y: 48, orient: 0, id: 65 }
]

// ============================================================
// HELPERS
// ============================================================

const publicClient = rpcManager.createPublicClient(soneiumChain)

interface FarmStakeState {
  walletBalance: bigint
  stakedAmount: bigint
  allowance: bigint
  paused: boolean
  poolMinPerUser: bigint
}

async function readSeedFarmState (
  wallet: Address,
  farm: Address,
  token: Address
): Promise<FarmStakeState> {
  const [balance, userInfo, allowance, paused, poolMin] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({ address: farm, abi: SMART_FARMER_ABI, functionName: 'userInfo', args: [wallet] }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [wallet, farm] }),
    publicClient.readContract({ address: farm, abi: SMART_FARMER_ABI, functionName: 'paused' }),
    publicClient.readContract({ address: farm, abi: SMART_FARMER_ABI, functionName: 'poolMinPerUser' })
  ])
  return {
    walletBalance: balance as bigint,
    stakedAmount: (userInfo as readonly bigint[])[1] ?? 0n,
    allowance: allowance as bigint,
    paused: paused as boolean,
    poolMinPerUser: poolMin as bigint
  }
}

/**
 * Извлечь количество ресурса по index'у из ответа /inventory/resources.
 * index 0 = Wood, 1 = Stone, 2 = Leather/Grass.
 */
function extractResourceAmount (
  inv: InventoryItemsData<{ index: number, amount: number }>,
  index: number
): number {
  const items = inv.data?.items ?? []
  return items.find((i) => i?.index === index)?.amount ?? 0
}

/**
 * Случайный nonce_index для tutorial/progress (как делает Unity-клиент).
 * В реальном HAR значения 0-58 — random small int. Мы используем тот же диапазон.
 */
function randomNonceIndex (): number {
  return Math.floor(Math.random() * 60)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Polling баланс ERC-20 пока не достигнет minAmount или таймаута.
 * После npc/unclejack/craft сервер минтит токены спустя ~25-60 сек.
 */
async function waitForTokenBalance (
  token: Address,
  wallet: Address,
  minAmount: bigint,
  timeoutMs: number = 90_000,
  intervalMs: number = 3_000
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  let last = 0n
  while (Date.now() < deadline) {
    const balance = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [wallet]
    })
    last = balance as bigint
    if (last >= minAmount) return last
    await sleep(intervalMs)
  }
  throw new Error(`waitForTokenBalance(${token}): expected ≥${minAmount}, got ${last} after ${timeoutMs}ms`)
}

/**
 * approve+deposit семя на SmartFarmer. Возвращает hash депозита.
 *
 * Газ:
 *  Для каждой write-tx сначала зовём estimateContractGas, потом увеличиваем
 *  на 50% (× 1.5) — этот же паттерн используется в morpho/aave/stargate/etc.
 *  Без буфера viem ставит лимит «впритык» к estimate, и между sign'ом и
 *  включением в блок реальный gas может подрасти (например, если первый
 *  депозит инициализирует userIndex/depositBlock), что приводит к OOG-revert.
 */
async function stakeOnFarm (
  account: ReturnType<typeof privateKeyToAccount>,
  farm: Address,
  token: Address,
  amount: bigint,
  state: FarmStakeState
): Promise<{ approveHash?: `0x${string}` | undefined, depositHash: `0x${string}` }> {
  const walletClient = rpcManager.createWalletClient(soneiumChain, account)

  let approveHash: `0x${string}` | undefined
  if (state.allowance < amount) {
    logger.info(`approve(${token}, MAX_UINT256) → spender=${farm}`)
    const approveEstimate = await publicClient.estimateContractGas({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [farm, MAX_UINT256],
      account
    })
    const approveGas = BigInt(Math.floor(Number(approveEstimate) * 1.5))
    logger.info(`  approve gas: estimate=${approveEstimate} → limit=${approveGas} (×1.5)`)
    const approveResult = await safeWriteContract(
      publicClient,
      walletClient,
      account.address,
      {
        chain: soneiumChain,
        account,
        address: token,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [farm, MAX_UINT256],
        gas: approveGas
      }
    )
    if (!approveResult.success) {
      throw new Error(`approve failed: ${approveResult.error}`)
    }
    approveHash = approveResult.hash
    logger.transaction(approveHash, 'sent', 'MMP-QUEST-APPROVE')
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
    if (receipt.status !== 'success') throw new Error(`approve reverted: ${approveHash}`)
    logger.transaction(approveHash, 'confirmed', 'MMP-QUEST-APPROVE', account.address)
  }

  logger.info(`deposit(${amount}) → farm=${farm}`)
  const depositEstimate = await publicClient.estimateContractGas({
    address: farm,
    abi: SMART_FARMER_ABI,
    functionName: 'deposit',
    args: [amount],
    account
  })
  const depositGas = BigInt(Math.floor(Number(depositEstimate) * 1.5))
  logger.info(`  deposit gas: estimate=${depositEstimate} → limit=${depositGas} (×1.5)`)
  const depositResult = await safeWriteContract(
    publicClient,
    walletClient,
    account.address,
    {
      chain: soneiumChain,
      account,
      address: farm,
      abi: SMART_FARMER_ABI,
      functionName: 'deposit',
      args: [amount],
      gas: depositGas
    }
  )
  if (!depositResult.success) {
    throw new Error(`deposit failed: ${depositResult.error}`)
  }
  const depositHash = depositResult.hash
  logger.transaction(depositHash, 'sent', 'MMP-QUEST-DEPOSIT')
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash })
  if (receipt.status !== 'success') throw new Error(`deposit reverted: ${depositHash}`)
  logger.transaction(depositHash, 'confirmed', 'MMP-QUEST-DEPOSIT', account.address)
  return { approveHash, depositHash }
}

// ============================================================
// MAIN MODULE FUNCTION
// ============================================================

export interface MmpQuestResult {
  success: boolean
  walletAddress?: string
  skipped?: boolean
  reason?: string
  error?: string
  message?: string
  tomatoStaked?: string | undefined
  cornStaked?: string | undefined
  cornDepositHash?: string | undefined
  tomatoDepositHash?: string | undefined
  cornCraftPendingId?: string | undefined
  tomatoCraftPendingId?: string | undefined
  needWildZone?: { wood: number, woodNeeded: number, stone: number, stoneNeeded: number } | undefined
  [key: string]: unknown
}

export async function performMmpQuest (privateKey: `0x${string}`): Promise<MmpQuestResult> {
  try {
    const account = privateKeyToAccount(privateKey)
    const wallet = account.address
    logger.info(`MMP Quest: запуск для ${wallet}`)

    // ----------------------------------------------------------
    // 0) PORTAL GATE — авторитетная проверка прогресса квеста
    // ----------------------------------------------------------
    // На портале счётчик инкрементируется на КАЖДЫЙ on-chain deposit в Corn
    // Farm. Если кошелёк уже отправлял deposit (completed≥1), повторный
    // запуск модуля создал бы лишний deposit → 2/1, 4/1 и т.д.
    //
    // Поэтому проверяем portal ПЕРВЫМ:
    //   - 0/1            → выполняем квест
    //   - ≥1/1 или isDone → skip
    //   - dapp не найден → skip (квест не активен на этой неделе)
    //   - portal лежит (все retry упали) → fail-fast, чтобы НЕ повторно
    //     стейкать «вслепую». executor подхватит этот кошелёк позже.
    let portalProgress: MmpPortalQuestProgress
    try {
      portalProgress = await checkMmpPortalProgress(wallet)
    } catch (e) {
      const msg = `Portal-check провалился: ${(e as Error).message}`
      logger.error(msg)
      return { success: false, walletAddress: wallet, error: msg, message: msg }
    }

    logger.info(
      `Portal ${MMP_QUEST_DAPP_ID}: completed=${portalProgress.completed}/${portalProgress.required} ` +
      `isDone=${portalProgress.isDone} found=${portalProgress.found}`
    )

    if (!portalProgress.found) {
      const msg = `Quest ${MMP_QUEST_DAPP_ID} не найден в portal — возможно неактивен`
      logger.warn(msg)
      return {
        success: true,
        walletAddress: wallet,
        skipped: true,
        reason: msg,
        message: msg
      }
    }

    if (portalProgress.isDone || portalProgress.completed >= portalProgress.required) {
      const msg = `MMP quest уже выполнен на portal: ${portalProgress.completed}/${portalProgress.required} (isDone=${portalProgress.isDone})`
      logger.success(msg)
      return {
        success: true,
        walletAddress: wallet,
        skipped: true,
        reason: msg,
        message: msg
      }
    }

    // Проверим on-chain состояние ферм — дополнительная защита на случай
    // рассинхронизации portal-индексера и реального чейна.
    const tomatoState = await readSeedFarmState(wallet, FARM_TOMATO, TOMATO_ADDRESS)
    const cornState = await readSeedFarmState(wallet, FARM_CORN, CORN_ADDRESS)
    const tomatoTargetRaw = parseUnits(TARGET_TOMATO.toString(), 18)
    const cornTargetRaw = parseUnits(TARGET_CORN.toString(), 18)

    logger.info(`Tomato Farm: staked=${formatUnits(tomatoState.stakedAmount, 18)} balance=${formatUnits(tomatoState.walletBalance, 18)}`)
    logger.info(`Corn   Farm: staked=${formatUnits(cornState.stakedAmount, 18)} balance=${formatUnits(cornState.walletBalance, 18)}`)

    const cornAlreadyDone = cornState.stakedAmount >= cornTargetRaw
    if (cornAlreadyDone) {
      const msg = `Квест уже выполнен on-chain: staked ${formatUnits(cornState.stakedAmount, 18)} CORNSEED ≥ ${TARGET_CORN} (portal ещё не обновился: ${portalProgress.completed}/${portalProgress.required})`
      logger.info(msg)
      return {
        success: true,
        walletAddress: wallet,
        skipped: true,
        reason: msg,
        message: msg,
        tomatoStaked: formatUnits(tomatoState.stakedAmount, 18),
        cornStaked: formatUnits(cornState.stakedAmount, 18)
      }
    }

    // ETH balance — нужен для approve+deposit (~250k газа суммарно)
    const ethBalance = await publicClient.getBalance({ address: wallet })
    if (ethBalance === 0n) {
      const msg = 'Нет ETH для оплаты газа. Пополните кошелёк через mmp-seed-transfer или вручную.'
      logger.error(msg)
      return { success: false, walletAddress: wallet, error: msg, message: msg }
    }
    logger.info(`ETH: ${formatEther(ethBalance)}`)

    // ----------------------------------------------------------
    // 1) AUTH (signup → login → tx-quota → character → tutorial=1)
    // ----------------------------------------------------------
    const client = createMmpClientWithProxy(privateKey)
    logger.info('1. signup + login')
    const loginData = await client.signupAndLogin()
    logger.info(`   isNewUser=${loginData.isNewUser} sessionToken=${loginData.sessionToken.slice(0, 12)}…`)

    try {
      await client.claimTxQuota()
      logger.info('2. tx-quota/claim ОК')
    } catch (e) {
      logger.warn(`tx-quota/claim уже claimed/ошибка: ${(e as Error).message}`)
    }

    // Tutorial state — если 0, нужен createCharacter + tutorial=1
    let tutorialProgress = 0
    try {
      const t = await client.getTutorialProgress()
      tutorialProgress = t.progress
      logger.info(`3. tutorial.progress = ${tutorialProgress}`)
    } catch {
      logger.info('3. tutorial.progress = 0 (свежий аккаунт)')
    }

    if (tutorialProgress === 0) {
      logger.info('4. создание character + tutorial=1')
      try {
        await client.createCharacter()
      } catch (e) {
        logger.warn(`createCharacter: ${(e as Error).message}`)
      }
      await client.tutorialProgress(1, 0)
      tutorialProgress = 1
    }

    // ----------------------------------------------------------
    // 2) Initial farmSaveData (если нет)
    // ----------------------------------------------------------
    let farm = await client.getFarmSave()
    if (!farm) {
      logger.info('5. создаём первый farmSaveData.json (default decorations)')
      const initial: FarmSaveContent = {
        version: '2.0.0',
        placements: [],
        companions: [],
        decorations: DEFAULT_FARM_DECORATIONS
      }
      await client.postFarmSave(initial)
      farm = initial
    } else {
      logger.info(`   farmSaveData уже есть, placements=${farm.placements.length}`)
    }

    // ----------------------------------------------------------
    // 3) WILD-ZONE GATE: проверяем ресурсы
    // ----------------------------------------------------------
    const inv = await client.getInventoryResources() as InventoryItemsData<{ index: number, amount: number }>
    const wood = extractResourceAmount(inv, 0)
    const stone = extractResourceAmount(inv, 1)
    logger.info(`6. inventory: wood=${wood}, stone=${stone}`)

    // Нам нужно: 15 wood для tomato, 45 stone для 3 corn
    // Но если tomato уже застейкан/в кошельке, wood не нужен. То же для corn.
    const tomatoOnWalletOrStaked = tomatoState.walletBalance + tomatoState.stakedAmount
    const cornOnWalletOrStaked = cornState.walletBalance + cornState.stakedAmount

    const needTomatoCraft = tomatoOnWalletOrStaked < tomatoTargetRaw
    const needCornCraft = cornOnWalletOrStaked < cornTargetRaw

    const woodNeeded = needTomatoCraft ? RECIPE_TOMATO.woodCost : 0
    const stoneNeeded = needCornCraft ? RECIPE_CORN_X3.stoneCost : 0

    if (wood < woodNeeded || stone < stoneNeeded) {
      logger.info(`Запускаем автоматический сбор wild-zone: wood ${wood}→${woodNeeded}, stone ${stone}→${stoneNeeded}`)
      const wildResult = await performMmpWild(client, {
        wood: woodNeeded,
        stone: stoneNeeded,
        maxSessions: 5
      })
      logger.info(`Wild result: success=${wildResult.success} sessions=${wildResult.sessionsUsed} wood=${wildResult.woodGathered} stone=${wildResult.stoneGathered}`)
      if (!wildResult.success) {
        const msg =
          `Wild-zone automation не выполнила цель: ${wildResult.failureReason ?? 'unknown'}. ` +
          `wood=${wildResult.woodGathered}/${woodNeeded}, stone=${wildResult.stoneGathered}/${stoneNeeded}.` +
          (wildResult.errors.length > 0 ? ` errors=${wildResult.errors.slice(0, 3).join('; ')}` : '')
        logger.warn(msg)
        return {
          success: false,
          walletAddress: wallet,
          skipped: true,
          reason: msg,
          message: msg,
          needWildZone: {
            wood: wildResult.woodGathered,
            woodNeeded,
            stone: wildResult.stoneGathered,
            stoneNeeded
          }
        }
      }
      // Re-read inventory after successful wild gathering
      const invAfter = await client.getInventoryResources() as InventoryItemsData<{ index: number, amount: number }>
      const woodAfter = extractResourceAmount(invAfter, 0)
      const stoneAfter = extractResourceAmount(invAfter, 1)
      logger.info(`После wild-zone: wood=${woodAfter}, stone=${stoneAfter}`)
    }

    // ----------------------------------------------------------
    // 4) TOMATO SEED FLOW
    // ----------------------------------------------------------
    let tomatoCraftPendingId: string | undefined
    if (needTomatoCraft) {
      logger.info('7. craft 1 TOMATO_SEED (15 wood)')
      const craft = await client.unclejackCraft({
        type: 'resource',
        recipe_ids: [RECIPE_TOMATO.recipeId],
        amounts: [RECIPE_TOMATO.amounts]
      })
      tomatoCraftPendingId = craft.pending_transaction_id ?? craft.tx_queue_id
      if (tomatoCraftPendingId !== undefined) {
        logger.info(`   pending_transaction_id=${tomatoCraftPendingId}`)
        await client.waitForPendingTransaction(tomatoCraftPendingId, { timeoutMs: 90_000, intervalMs: 2_500 })
      }

      logger.info('   ждём on-chain mint TOMATOSEED…')
      await waitForTokenBalance(TOMATO_ADDRESS, wallet, tomatoTargetRaw)
      logger.info('   TOMATOSEED получен on-chain')

      // Plant in-game (косметика, не критично, но соответствует поведению UI)
      try {
        const farmAfter = (await client.getFarmSave()) ?? farm
        if (!farmAfter.placements.some((p) => p.plantingID === TOMATO_PLACEMENT.plantingID)) {
          farmAfter.placements.push(TOMATO_PLACEMENT)
          await client.postFarmSave(farmAfter)
          logger.info('   tomato посажен в farmSaveData (косметика)')
        }
      } catch (e) {
        logger.warn(`   farmSaveData обновление пропущено: ${(e as Error).message}`)
      }
    } else {
      logger.info('7. tomato seed уже на кошельке/застейкан — skip craft')
    }

    // Tutorial sequence: progress 7..10 (после первой посадки tomato в HAR)
    // Делаем мягко — игнорируем ошибки.
    if (tutorialProgress < 10) {
      for (let p = Math.max(2, tutorialProgress + 1); p <= 10; p++) {
        try {
          await client.tutorialProgress(p, randomNonceIndex())
          tutorialProgress = p
          logger.info(`   tutorial.progress=${p}`)
        } catch (e) {
          logger.warn(`tutorial.progress=${p} ошибка: ${(e as Error).message} (продолжаем)`)
        }
      }
    }

    // ----------------------------------------------------------
    // 5) STAKE 1 TOMATOSEED (Tomato Farm)
    // ----------------------------------------------------------
    let tomatoDepositHash: string | undefined
    const tomatoStateAfter = await readSeedFarmState(wallet, FARM_TOMATO, TOMATO_ADDRESS)
    if (tomatoStateAfter.stakedAmount < tomatoTargetRaw && tomatoStateAfter.walletBalance >= tomatoTargetRaw) {
      if (tomatoStateAfter.paused) {
        logger.warn('Tomato Farm на паузе — skip stake')
      } else {
        logger.info('8. approve + deposit 1 TOMATOSEED → Tomato Farm')
        const r = await stakeOnFarm(account, FARM_TOMATO, TOMATO_ADDRESS, tomatoTargetRaw, tomatoStateAfter)
        tomatoDepositHash = r.depositHash
      }
    } else if (tomatoStateAfter.stakedAmount >= tomatoTargetRaw) {
      logger.info('8. tomato уже застейкан')
    } else {
      logger.warn(`8. tomato баланс ${formatUnits(tomatoStateAfter.walletBalance, 18)} < ${TARGET_TOMATO} — skip stake`)
    }

    // ----------------------------------------------------------
    // 6) CORN SEED FLOW
    // ----------------------------------------------------------
    let cornCraftPendingId: string | undefined
    if (needCornCraft) {
      logger.info('9. craft 3 CORN_SEED (45 stone)')
      const craft = await client.unclejackCraft({
        type: 'resource',
        recipe_ids: [RECIPE_CORN_X3.recipeId],
        amounts: [RECIPE_CORN_X3.amounts]
      })
      cornCraftPendingId = craft.pending_transaction_id ?? craft.tx_queue_id
      if (cornCraftPendingId !== undefined) {
        logger.info(`   pending_transaction_id=${cornCraftPendingId}`)
        await client.waitForPendingTransaction(cornCraftPendingId, { timeoutMs: 90_000, intervalMs: 2_500 })
      }

      logger.info('   ждём on-chain mint 3 CORNSEED…')
      await waitForTokenBalance(CORN_ADDRESS, wallet, cornTargetRaw)
      logger.info('   3 CORNSEED получены on-chain')

      try {
        const farmAfter = (await client.getFarmSave()) ?? farm
        if (!farmAfter.placements.some((p) => p.plantingID === CORN_PLACEMENT.plantingID)) {
          farmAfter.placements.push(CORN_PLACEMENT)
          await client.postFarmSave(farmAfter)
          logger.info('   corn посажен в farmSaveData (косметика)')
        }
      } catch (e) {
        logger.warn(`   farmSaveData обновление пропущено: ${(e as Error).message}`)
      }
    } else {
      logger.info('9. corn seed уже на кошельке/застейкан — skip craft')
    }

    // ----------------------------------------------------------
    // 7) STAKE 3 CORNSEED (Corn Farm) ← главный шаг квеста
    // ----------------------------------------------------------
    let cornDepositHash: string | undefined
    const cornStateAfter = await readSeedFarmState(wallet, FARM_CORN, CORN_ADDRESS)
    if (cornStateAfter.stakedAmount < cornTargetRaw && cornStateAfter.walletBalance >= cornTargetRaw) {
      if (cornStateAfter.paused) {
        const msg = 'Corn Farm на паузе — невозможно стейкнуть, квест не выполнен'
        logger.error(msg)
        return { success: false, walletAddress: wallet, error: msg, message: msg }
      }
      logger.info('10. approve + deposit 3 CORNSEED → Corn Farm')
      const r = await stakeOnFarm(account, FARM_CORN, CORN_ADDRESS, cornTargetRaw, cornStateAfter)
      cornDepositHash = r.depositHash
    } else if (cornStateAfter.stakedAmount >= cornTargetRaw) {
      logger.info('10. corn уже застейкан')
    } else {
      const msg = `Не хватает CORNSEED: ${formatUnits(cornStateAfter.walletBalance, 18)} < ${TARGET_CORN}`
      logger.error(msg)
      return { success: false, walletAddress: wallet, error: msg, message: msg }
    }

    // ----------------------------------------------------------
    // 8) Final verify
    // ----------------------------------------------------------
    const finalCorn = await readSeedFarmState(wallet, FARM_CORN, CORN_ADDRESS)
    const finalTomato = await readSeedFarmState(wallet, FARM_TOMATO, TOMATO_ADDRESS)

    if (finalCorn.stakedAmount < cornTargetRaw) {
      const msg = `Финальная проверка: CORNSEED staked ${formatUnits(finalCorn.stakedAmount, 18)} < ${TARGET_CORN}`
      logger.error(msg)
      return {
        success: false,
        walletAddress: wallet,
        error: msg,
        message: msg,
        tomatoDepositHash,
        cornDepositHash,
        tomatoCraftPendingId,
        cornCraftPendingId,
        cornStaked: formatUnits(finalCorn.stakedAmount, 18),
        tomatoStaked: formatUnits(finalTomato.stakedAmount, 18)
      }
    }

    const successMsg =
      `Квест выполнен! ` +
      `corn staked=${formatUnits(finalCorn.stakedAmount, 18)} (≥${TARGET_CORN}), ` +
      `tomato staked=${formatUnits(finalTomato.stakedAmount, 18)}`
    logger.success(successMsg)
    return {
      success: true,
      walletAddress: wallet,
      message: successMsg,
      tomatoDepositHash,
      cornDepositHash,
      tomatoCraftPendingId,
      cornCraftPendingId,
      cornStaked: formatUnits(finalCorn.stakedAmount, 18),
      tomatoStaked: formatUnits(finalTomato.stakedAmount, 18)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Неизвестная ошибка'
    logger.error('mmp-quest fatal:', error)
    return { success: false, error: msg, message: msg }
  }
}
