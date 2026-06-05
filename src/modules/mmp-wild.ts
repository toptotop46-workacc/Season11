/**
 * MMP Wild Zone — multi-session resource gathering orchestrator.
 *
 * Public API:
 *   performMmpWild(client, { wood, stone, leather? }) → MmpWildResult
 *
 * Architecture:
 *   1. Loop until cumulative goal is met or maxSessions exhausted.
 *   2. Each session: allowToEnter → wildCreate → downloadTemplate
 *      → generateWildMap → pickTargets → buildActions → chunk into batches
 *      → wildsave (per batch) → wildEnd → re-read inventory.
 *   3. Idempotent: if interrupted mid-session, the next call enters a fresh
 *      wild zone (server forces wildEnd in wildCreate).
 */
import { logger } from '../logger.js'
import {
  generateWildMap,
  ENERGY_MAX,
  pickTargets,
  buildActions,
  chunkActions,
  buildWildSaveContent,
  enrichObjMap,
  isResourceGoalMet,
  type MmpClient,
  type ResourceGoal,
  type SessionState,
  type WildMapTemplate,
  type InventoryItemsData
} from '../mmp-api/index.js'
import { createMmpClientWithProxy } from './mmp-proxy.js'

export interface MmpWildOptions extends ResourceGoal {
  maxSessions?: number       // default 5
  mapNo?: number             // default 1
  batchSize?: number         // default 4 actions per wildsave
  startPos?: string          // default '45-54'
}

export interface MmpWildResult {
  success: boolean
  sessionsUsed: number
  woodGathered: number
  stoneGathered: number
  leatherGathered: number
  failureReason?: string
  errors: string[]
}

const RESOURCE_INDEX_WOOD = 0
const RESOURCE_INDEX_STONE = 1
const RESOURCE_INDEX_LEATHER = 2

function readResource (
  inv: InventoryItemsData<{ index: number, amount: number }> | null,
  index: number
): number {
  return inv?.data?.items?.find(i => i?.index === index)?.amount ?? 0
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export async function performMmpWild (
  client: MmpClient,
  options: MmpWildOptions
): Promise<MmpWildResult> {
  const maxSessions = options.maxSessions ?? 5
  const mapNo = options.mapNo ?? 1
  const batchSize = options.batchSize ?? 4
  const startPos = options.startPos ?? '45-54'

  const errors: string[] = []
  let sessionsUsed = 0

  // Initial inventory
  let inv = await client.getInventoryResources() as InventoryItemsData<{ index: number, amount: number }> | null
  let woodGathered = readResource(inv, RESOURCE_INDEX_WOOD)
  let stoneGathered = readResource(inv, RESOURCE_INDEX_STONE)
  let leatherGathered = readResource(inv, RESOURCE_INDEX_LEATHER)
  logger.info(`MMP Wild: initial inventory wood=${woodGathered} stone=${stoneGathered} leather=${leatherGathered}`)

  while (sessionsUsed < maxSessions) {
    if (isResourceGoalMet(
      { wood: woodGathered, stone: stoneGathered, leather: leatherGathered },
      options
    )) break

    // Check daily quota
    try {
      const allow = await client.allowToEnterWildZone()
      if (!allow.allowed) {
        const reason = `wild-zone disallowed: ${allow.reason}`
        logger.warn(reason)
        errors.push(reason)
        return { success: false, sessionsUsed, woodGathered, stoneGathered, leatherGathered, errors, failureReason: reason }
      }
    } catch (e) {
      logger.warn(`allowToEnterWildZone failed (continue anyway): ${(e as Error).message}`)
    }

    sessionsUsed++
    logger.info(`MMP Wild: session ${sessionsUsed}/${maxSessions}`)

    let seed: number
    let template: WildMapTemplate
    try {
      const created = await client.wildCreate(mapNo)
      seed = created.seedInt
      const tmplRaw = await client.wildDownloadTemplate(mapNo) as { template?: { template: WildMapTemplate } } | WildMapTemplate
      // Server wraps as {template:{template:{...}}} or just the template
      template = (tmplRaw as { template?: { template: WildMapTemplate } }).template?.template
        ?? (tmplRaw as WildMapTemplate)
    } catch (e) {
      const msg = `wildCreate/download failed: ${(e as Error).message}`
      logger.error(msg)
      errors.push(msg)
      try { await client.wildEnd() } catch { /* best-effort cleanup after wildCreate failure */ }
      continue
    }

    const map = generateWildMap(template, seed, 0)
    logger.info(`  seed=${seed}, map has ${map.objects.length} objects (initial latest_object_id=${map.latestObjectId})`)

    const goal: ResourceGoal = {
      wood: Math.max(0, options.wood - woodGathered),
      stone: Math.max(0, options.stone - stoneGathered),
      leather: Math.max(0, (options.leather ?? 0) - leatherGathered)
    }
    const plan = pickTargets(map, goal, ENERGY_MAX)
    if (plan.targets.length === 0) {
      logger.warn(`  empty plan (no useful targets) — abandoning session ${sessionsUsed}`)
      try { await client.wildEnd() } catch { /* best-effort cleanup on empty plan */ }
      continue
    }
    logger.info(`  plan: ${plan.targets.length} targets, expected wood=${plan.expectedWood} stone=${plan.expectedStone}`)

    // Build all actions for the session up-front
    const built = buildActions(plan, {
      latestObjectId: map.latestObjectId,
      startActionIndex: 1,
      startPos,
      mapNo
    })

    // Source object lookup table for enrichObjMap
    const sourceLookup = new Map<number, { type: number, pos: { x: number, z: number } }>(
      map.objects.map(o => [o.id, { type: o.type, pos: o.pos }] as const)
    )
    for (const sh of built.spawnedShards) {
      sourceLookup.set(sh.id, { type: sh.type, pos: sh.pos })
    }

    const state: SessionState = {
      energyLose: 0,
      // Start with the INITIAL map latestObjectId; buildWildSaveContent will
      // advance it per batch as shards spawn (Boulder kills). Reporting the
      // final value up-front would over-claim shards that don't exist yet,
      // and the server may reject inconsistent state.
      latestObjectId: map.latestObjectId,
      lastActionIndex: 0,
      playerPos: startPos
    }
    const batches = chunkActions(built.actions, batchSize)
    let aborted = false
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!
      // Track shards spawned in this batch by walking action_result
      const shardsInBatch = built.spawnedShards.filter(sh =>
        batch.some(a => (a.action_result?.wildObject_changed ?? []).some(w => w.id === sh.id && w.change_type === 2))
      )

      try {
        const nonce = await client.wildSaveNonceIssue()
        const content = buildWildSaveContent({
          seed,
          mapNo,
          batch,
          shardsSpawnedInBatch: shardsInBatch,
          cumulativeState: state
        })
        enrichObjMap(content, sourceLookup)
        await client.wildSave(content, nonce)
      } catch (e) {
        const msg = `wildsave batch ${bi} failed: ${(e as Error).message}`
        logger.error(msg)
        errors.push(msg)
        aborted = true
        break
      }
      // Light pacing to look human
      await sleep(800)
    }

    try { await client.wildEnd() } catch { /* best-effort cleanup at session end */ }

    if (aborted) {
      logger.warn('  session aborted; will retry with fresh seed')
      continue
    }

    // Re-read inventory
    inv = await client.getInventoryResources() as InventoryItemsData<{ index: number, amount: number }> | null
    woodGathered = readResource(inv, RESOURCE_INDEX_WOOD)
    stoneGathered = readResource(inv, RESOURCE_INDEX_STONE)
    leatherGathered = readResource(inv, RESOURCE_INDEX_LEATHER)
    logger.info(`  inventory after session: wood=${woodGathered} stone=${stoneGathered} leather=${leatherGathered}`)
  }

  const success = isResourceGoalMet(
    { wood: woodGathered, stone: stoneGathered, leather: leatherGathered },
    options
  )
  const result: MmpWildResult = {
    success,
    sessionsUsed,
    woodGathered,
    stoneGathered,
    leatherGathered,
    errors
  }
  if (!success) {
    result.failureReason = `goal not met after ${sessionsUsed} sessions`
  }
  return result
}

/**
 * Module entrypoint for `npm run mmp-wild`. Defaults to gathering 15 wood
 * and 45 stone (the standard quest amount). Returns a generic ModuleResult.
 */
export async function performMmpWildModule (privateKey: `0x${string}`): Promise<{
  success: boolean
  walletAddress?: string
  message?: string
  error?: string
  woodGathered?: number
  stoneGathered?: number
  sessionsUsed?: number
}> {
  try {
    const client = createMmpClientWithProxy(privateKey)
    const data = await client.signupAndLogin()
    try { await client.claimTxQuota() } catch { /* best-effort: quota may already be claimed */ }

    // Tutorial=0 → need character + tutorial=1 first
    let progress = 0
    try { progress = (await client.getTutorialProgress()).progress } catch { /* best-effort: fallback to 0 (treat as fresh tutorial) */ }
    if (progress === 0) {
      try { await client.createCharacter() } catch (e) { logger.warn(`createCharacter: ${(e as Error).message}`) }
      try { await client.tutorialProgress(1, 0) } catch (e) { logger.warn(`tutorialProgress(1): ${(e as Error).message}`) }
    }

    const result = await performMmpWild(client, { wood: 15, stone: 45 })
    return {
      success: result.success,
      walletAddress: data.user.publicAddress,
      woodGathered: result.woodGathered,
      stoneGathered: result.stoneGathered,
      sessionsUsed: result.sessionsUsed,
      message: `wild done: wood=${result.woodGathered} stone=${result.stoneGathered}`,
      ...(result.failureReason ? { error: result.failureReason } : {})
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'unknown' }
  }
}
