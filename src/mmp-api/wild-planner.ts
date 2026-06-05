/**
 * Wild Zone action planner.
 *
 * Pure module (no I/O) that takes a generated wild map and decides:
 *   - which objects to break to satisfy resource goals,
 *   - in what order to walk to them,
 *   - what action_type / hp_change / change_type to use per hit,
 *   - what wildsave-content batches to emit.
 *
 * The orchestrator (mmp-wild.ts) feeds these batches to MmpClient.
 */
import {
  OBJECT_TYPE_TO_ACTION,
  type GeneratedWildMap,
  type SpawnedObject
} from './wild-rng.js'
import type { WildAction, WildSaveContent, WildObjectState } from './types.js'

/** Maximum energy reservoir. Per HAR: 10000 with 400 per action. */
export const ENERGY_MAX = 10000
export const ENERGY_PER_ACTION = 400

/** ChangeWorld action_type (init / map switch). */
export const ACTION_CHANGE_WORLD = 30

/** wildObject_changed.change_type values. */
export const CHANGE_TYPE = { DAMAGE: 0, DESTROY: 1, SPAWN: 2 } as const

/** Drop tables (verified in HAR). */
export interface ObjectDropProfile {
  hits: number
  hpPerHit: number
  resourceClass: 1 | 2 | 3
  resourceAmount: number
  spawnsOnDeath: number
}

export const DROP_PROFILES: Readonly<Record<number, ObjectDropProfile>> = {
  1:  { hits: 1,  hpPerHit: 500, resourceClass: 1, resourceAmount: 1,  spawnsOnDeath: 0 },
  2:  { hits: 3,  hpPerHit: 500, resourceClass: 1, resourceAmount: 3,  spawnsOnDeath: 0 },
  9:  { hits: 1,  hpPerHit: 500, resourceClass: 2, resourceAmount: 1,  spawnsOnDeath: 0 },
  10: { hits: 3,  hpPerHit: 500, resourceClass: 2, resourceAmount: 3,  spawnsOnDeath: 0 },
  11: { hits: 12, hpPerHit: 500, resourceClass: 2, resourceAmount: 12, spawnsOnDeath: 2 },
  17: { hits: 1,  hpPerHit: 0,   resourceClass: 3, resourceAmount: 1,  spawnsOnDeath: 0 }
}

/** Goal of a session in resource units. */
export interface ResourceGoal {
  wood: number
  stone: number
  leather?: number
}

/**
 * Check whether the current cumulative inventory meets the gathering goal.
 * Leather is only enforced when goal.leather is a positive number — passing
 * `undefined` or `0` makes leather optional, preserving backward compatibility
 * with callers that only care about wood/stone (the typical mmp-quest case).
 */
export function isResourceGoalMet (
  current: { wood: number, stone: number, leather: number },
  goal: ResourceGoal
): boolean {
  if (current.wood < goal.wood) return false
  if (current.stone < goal.stone) return false
  const leatherGoal = goal.leather ?? 0
  if (leatherGoal > 0 && current.leather < leatherGoal) return false
  return true
}

/** Picked target — a specific object on the map plus the planner's intent. */
export interface PlannedTarget {
  objectId: number
  type: number
  pos: { x: number, z: number }
  hits: number
  resourceClass: 1 | 2 | 3
  resourceAmount: number
}

export interface PlanResult {
  targets: PlannedTarget[]
  expectedWood: number
  expectedStone: number
  expectedLeather: number
  energyCost: number
}

/**
 * Pick which objects to gather in this session.
 *
 * Strategy: ALL gatherable types yield ~1 resource per hit (1 hit/log = 1 wood,
 * 3 hits/BigRock = 3 stone, 12 hits/Boulder = 12 stone, etc.), so we allocate
 * the energy budget proportionally across the resource goals and then pick
 * concrete targets that fit each per-class hit budget without overshooting too
 * much.
 *
 * @param map - server-predicted map from generateWildMap
 * @param goal - what resources we still need
 * @param energyAvailable - typically ENERGY_MAX
 */
export function pickTargets (
  map: GeneratedWildMap,
  goal: ResourceGoal,
  energyAvailable: number = ENERGY_MAX
): PlanResult {
  const woodNeed = Math.max(0, goal.wood)
  const stoneNeed = Math.max(0, goal.stone)
  const leatherNeed = Math.max(0, goal.leather ?? 0)

  const totalHitsNeeded = woodNeed + stoneNeed + leatherNeed
  const totalHitsAvailable = Math.floor(energyAvailable / ENERGY_PER_ACTION)
  if (totalHitsNeeded === 0 || totalHitsAvailable === 0) {
    return { targets: [], expectedWood: 0, expectedStone: 0, expectedLeather: 0, energyCost: 0 }
  }

  // Per-class hit budget (proportional split). If we have plenty of energy,
  // each class gets exactly its need.
  let woodBudget: number
  let stoneBudget: number
  let leatherBudget: number
  if (totalHitsNeeded <= totalHitsAvailable) {
    woodBudget = woodNeed
    stoneBudget = stoneNeed
    leatherBudget = leatherNeed
  } else {
    woodBudget = Math.floor((totalHitsAvailable * woodNeed) / totalHitsNeeded)
    stoneBudget = Math.floor((totalHitsAvailable * stoneNeed) / totalHitsNeeded)
    leatherBudget = Math.floor((totalHitsAvailable * leatherNeed) / totalHitsNeeded)
    // Distribute the remainder to the largest goal so we don't waste hits
    let remaining = totalHitsAvailable - (woodBudget + stoneBudget + leatherBudget)
    while (remaining > 0) {
      if (woodBudget < woodNeed && woodNeed >= stoneNeed && woodNeed >= leatherNeed) { woodBudget++; remaining-- }
      else if (stoneBudget < stoneNeed && stoneNeed >= leatherNeed) { stoneBudget++; remaining-- }
      else if (leatherBudget < leatherNeed) { leatherBudget++; remaining-- }
      else break
    }
  }

  const targets: PlannedTarget[] = []
  let expWood = 0
  let expStone = 0
  let expLeather = 0
  let totalHitsUsed = 0

  // Group candidate objects by resource class.
  const byClass = new Map<1 | 2 | 3, SpawnedObject[]>([[1, []], [2, []], [3, []]])
  for (const o of map.objects) {
    const profile = DROP_PROFILES[o.type]
    if (!profile) continue
    if (OBJECT_TYPE_TO_ACTION[o.type] === undefined) continue
    byClass.get(profile.resourceClass)!.push(o)
  }

  /**
   * Pick objects of `resourceClass` to fill `hitBudget`. Hard cap on
   * `totalHitsAvailable` to prevent over-allocation across classes.
   * Within a class we prefer larger yield (fewer trips) and accept light
   * overshoot only for short targets (≤3 hits).
   */
  const fillClass = (resourceClass: 1 | 2 | 3, hitBudget: number): { hits: number, resource: number } => {
    if (hitBudget <= 0) return { hits: 0, resource: 0 }
    const candidates = (byClass.get(resourceClass) ?? []).slice()
    candidates.sort((a, b) => {
      const pa = DROP_PROFILES[a.type]!
      const pb = DROP_PROFILES[b.type]!
      return pb.resourceAmount - pa.resourceAmount || pa.hits - pb.hits
    })
    let hitsLeft = hitBudget
    let totalHits = 0
    let totalResource = 0
    for (const o of candidates) {
      const profile = DROP_PROFILES[o.type]!
      // Hard global cap
      if (totalHitsUsed + totalHits + profile.hits > totalHitsAvailable) continue
      // Soft per-class cap with limited overshoot
      const overshoot = profile.hits - hitsLeft
      if (overshoot > 0) {
        if (profile.hits >= 4) continue                    // expensive target — no overshoot
        if (overshoot > Math.ceil(profile.hits / 2)) continue  // small overshoot ok
      }
      targets.push({
        objectId: o.id,
        type: o.type,
        pos: o.pos,
        hits: profile.hits,
        resourceClass: profile.resourceClass,
        resourceAmount: profile.resourceAmount
      })
      hitsLeft -= profile.hits
      totalHits += profile.hits
      totalResource += profile.resourceAmount
      if (hitsLeft <= 0) break
    }
    return { hits: totalHits, resource: totalResource }
  }

  const wood = fillClass(1, woodBudget)
  expWood = wood.resource
  totalHitsUsed += wood.hits

  const stone = fillClass(2, stoneBudget)
  expStone = stone.resource
  totalHitsUsed += stone.hits

  const leather = fillClass(3, leatherBudget)
  expLeather = leather.resource
  totalHitsUsed += leather.hits

  return {
    targets,
    expectedWood: expWood,
    expectedStone: expStone,
    expectedLeather: expLeather,
    energyCost: totalHitsUsed * ENERGY_PER_ACTION
  }
}

// ============================================================
// Action sequencing
// ============================================================

/**
 * Single emitted wild action with all server-side fields populated.
 * The orchestrator passes this directly into wildsave content.
 *
 * Currently a structural alias of `WildAction` — kept as a named type so that
 * call-sites read meaningfully (`BuiltAction[]` in plans/batches), and to
 * leave room for adding "built"-specific fields without churning consumers.
 */
export type BuiltAction = WildAction

/** Compute "HH-MM-SS" from a Date. */
function formatDoneAt (d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${hh}-${mm}-${ss}`
}

/**
 * Position adjacent to a target — picks `(target.x + 1, target.z)` by default
 * but caller can override (e.g. king-step). HAR shows pos can be 1-3 tiles
 * away (chebyshev distance ≤ 3) so anything close works.
 */
export function adjacentPosition (target: { x: number, z: number }): string {
  return `${target.x + 1}-${target.z}`
}

export interface BuildActionsOptions {
  startActionIndex?: number   // default 1 (ChangeWorld init)
  startPos?: string           // default "45-54" (HAR observed initial spawn)
  mapNo?: number              // default 1
  /** Initial cumulative latest_object_id (typically map.latestObjectId). */
  latestObjectId: number
  now?: () => Date
}

export interface BuildActionsResult {
  actions: BuiltAction[]
  finalActionIndex: number
  finalPlayerPos: string
  spawnedShards: Array<{ id: number, type: number, pos: { x: number, z: number } }>
  finalLatestObjectId: number
}

/**
 * Build a flat list of WildAction objects for a planned set of targets,
 * including the ChangeWorld init action when startActionIndex == 1.
 *
 * Each target produces N hits where N == DROP_PROFILES[type].hits.
 *  - Hits 1..N-1 emit change_type=0 (damage) and no resource_changed.
 *  - Hit N emits change_type=1 (destroy) and resource_changed=["class-amount"].
 *  - Boulder (type=11) additionally emits change_type=2 entries for the 2
 *    spawned SmallRock shards on its final hit; their ids are
 *    latestObjectId + 1 and latestObjectId + 2.
 */
export function buildActions (
  plan: PlanResult,
  opts: BuildActionsOptions
): BuildActionsResult {
  const now = opts.now ?? (() => new Date())
  const mapNo = opts.mapNo ?? 1
  let actionIndex = opts.startActionIndex ?? 1
  let playerPos = opts.startPos ?? '45-54'
  let latestObjectId = opts.latestObjectId
  const actions: BuiltAction[] = []
  const spawnedShards: BuildActionsResult['spawnedShards'] = []

  // Optional ChangeWorld init action.
  if (actionIndex === 1) {
    actions.push({
      action_type: ACTION_CHANGE_WORLD,
      done_at: formatDoneAt(now()),
      player_position: playerPos,
      target_object: mapNo,
      action_index: actionIndex
    })
    actionIndex++
  }

  for (const target of plan.targets) {
    const profile = DROP_PROFILES[target.type]!
    const actionType = OBJECT_TYPE_TO_ACTION[target.type]!
    const stepPos = adjacentPosition(target.pos)
    playerPos = stepPos

    for (let hit = 1; hit <= profile.hits; hit++) {
      const isFinal = hit === profile.hits
      const result: NonNullable<WildAction['action_result']> = {
        energy_changed: -ENERGY_PER_ACTION,
        health_changed: 0,
        exp_gain: 0,
        wildObject_changed: [
          {
            id: target.objectId,
            hp_change: -profile.hpPerHit,
            change_type: isFinal ? CHANGE_TYPE.DESTROY : CHANGE_TYPE.DAMAGE
          }
        ]
      }

      if (isFinal) {
        result.resource_changed = [`${profile.resourceClass}-${profile.resourceAmount}`]
        // Spawn shards (Boulder only).
        for (let s = 1; s <= profile.spawnsOnDeath; s++) {
          latestObjectId++
          // Stub shard at target pos + offset(s). Server may accept any nearby pos
          // as long as the id is sequential. Real client uses pool RNG; we just
          // place them at +1/+2 in z.
          const shardPos = { x: target.pos.x, z: target.pos.z + s }
          result.wildObject_changed!.push({
            id: latestObjectId,
            hp_change: 0,
            change_type: CHANGE_TYPE.SPAWN
          })
          spawnedShards.push({ id: latestObjectId, type: 9, pos: shardPos })
        }
      }

      actions.push({
        action_type: actionType,
        done_at: formatDoneAt(now()),
        player_position: stepPos,
        target_object: target.objectId,
        action_index: actionIndex,
        action_result: result
      })
      actionIndex++
    }
  }

  return {
    actions,
    finalActionIndex: actionIndex - 1,
    finalPlayerPos: playerPos,
    spawnedShards,
    finalLatestObjectId: latestObjectId
  }
}

// ============================================================
// Wildsave content builder + batching
// ============================================================

export interface SessionState {
  /** Current cumulative energy_lose. */
  energyLose: number
  /** Current cumulative latest_object_id. */
  latestObjectId: number
  /** Last submitted action_index. */
  lastActionIndex: number
  /** Final player position from last batch (for next batch's start). */
  playerPos: string
}

/** Content for one POST /wild/wildsave call. */
export type WildSaveBatchContent = WildSaveContent

/**
 * Split a flat action list into ≤ N actions per batch.
 * Reasonable batch size mimics human pace: 1-5 actions per save.
 *
 * IMPORTANT: ChangeWorld init action (action_type=30) is always emitted
 * as its own first batch — matches HAR pattern (the real client posts
 * the init separately) and seems required for the server to actually
 * credit subsequent resource gathering.
 */
export function chunkActions (actions: BuiltAction[], batchSize: number = 4): BuiltAction[][] {
  const out: BuiltAction[][] = []
  let start = 0
  if (actions.length > 0 && actions[0]!.action_type === ACTION_CHANGE_WORLD) {
    out.push([actions[0]!])
    start = 1
  }
  for (let i = start; i < actions.length; i += batchSize) {
    out.push(actions.slice(i, i + batchSize))
  }
  return out
}

/**
 * Build the wildsave-content envelope for ONE batch.
 *
 * `cumulativeState` is mutated so consecutive calls produce the right
 * energy_lose / latest_object_id / player_pos.
 */
export function buildWildSaveContent (params: {
  seed: number
  mapNo: number
  batch: BuiltAction[]
  shardsSpawnedInBatch: Array<{ id: number, type: number, pos: { x: number, z: number } }>
  cumulativeState: SessionState
}): WildSaveBatchContent {
  const { seed, mapNo, batch, shardsSpawnedInBatch, cumulativeState } = params

  // Per-batch obj_map: only the objects modified in this batch.
  // For a target hit multiple times in this batch, we keep the LAST status.
  const objMap = new Map<number, WildObjectState>()
  for (const a of batch) {
    if (a.action_type === ACTION_CHANGE_WORLD) continue
    const wcs = a.action_result?.wildObject_changed ?? []
    for (const wc of wcs) {
      if (wc.change_type === CHANGE_TYPE.SPAWN) continue
      // Reconstruct status: 1 = damaged (still alive), 255 = destroyed.
      const status = wc.change_type === CHANGE_TYPE.DESTROY ? 255 : 1
      const existing = objMap.get(wc.id)
      if (existing) {
        existing.status = status
      } else {
        objMap.set(wc.id, {
          id: wc.id,
          type: -1,         // placeholder; filled in by enrichObjMap
          pos: 'unknown',   // placeholder
          status
        })
      }
    }
  }

  const objNew: WildObjectState[] = shardsSpawnedInBatch.map(s => ({
    id: s.id,
    type: s.type,
    pos: `${s.pos.x}-${s.pos.z}`,
    status: 0,
    hp: 500
  }))

  // Update cumulative energy/action/latest_id
  const energyLose = cumulativeState.energyLose
    + batch.filter(a => a.action_type !== ACTION_CHANGE_WORLD).length * ENERGY_PER_ACTION
  const lastIdx = batch[batch.length - 1]?.action_index ?? cumulativeState.lastActionIndex
  const finalPos = batch[batch.length - 1]?.player_position ?? cumulativeState.playerPos
  cumulativeState.energyLose = energyLose
  cumulativeState.lastActionIndex = lastIdx
  cumulativeState.playerPos = finalPos
  // Advance latestObjectId by the max id of any shard spawned in this batch.
  // Before any shards spawn, this is a no-op; on the boulder's final-hit batch,
  // it bumps state from <initial> to <initial + spawnsOnDeath>.
  for (const s of shardsSpawnedInBatch) {
    if (s.id > cumulativeState.latestObjectId) cumulativeState.latestObjectId = s.id
  }

  return {
    active: true,
    map_current: mapNo,
    maps: {
      [String(mapNo)]: {
        name: mapNo,
        seed,
        player_pos: finalPos,
        obj_map: Array.from(objMap.values()),
        obj_new: objNew,
        latest_object_id: cumulativeState.latestObjectId
      }
    },
    health_max: 10000,
    health_gain: 0,
    health_lose: 0,
    energy_max: 10000,
    energy_gain: 0,
    energy_lose: energyLose,
    exp_gain: 0,
    mod_id_latest: 0,
    buffs: [],
    buff_mods: [],
    buff_mod_id_start: 1,
    actions: batch,
    latest_action_index: lastIdx,
    map_version: '0.5.7'
  }
}

/**
 * Enrich obj_map entries with the proper type/pos from the source map.
 * The buildWildSaveContent fills type=-1 and pos='unknown' as placeholders;
 * callers run this before submitting.
 */
export function enrichObjMap (
  content: WildSaveBatchContent,
  sourceObjects: Map<number, { type: number, pos: { x: number, z: number } }>
): void {
  const map = content.maps[String(content.map_current)]!
  for (const o of map.obj_map) {
    const src = sourceObjects.get(o.id)
    if (!src) continue
    o.type = src.type
    o.pos = `${src.pos.x}-${src.pos.z}`
  }
}
