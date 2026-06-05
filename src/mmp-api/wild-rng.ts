/**
 * Wild Zone RNG / Map Generation — точный порт алгоритма из IL2CPP-wasm билда
 * Morning Moon Pocket (verified against 5/5 ground truth seeds, off_by=0).
 *
 * Происхождение:
 * - Ghidra-декомпиляция функций wasm $20152 (WildMapManager.GenerateWildMap),
 *   $10395 (wang_hash), $20153/$34618 (GetWeightedPatternIndex), $20157 (WildMap.ctor).
 * - См. RESEARCH_STATUS.md → "Wild zone RNG (cracked)" и
 *   research/wild/verify_rng.py для пайтоновского эталона.
 *
 * Ключевая находка: **сервер НЕ использует stateful System.Random**, как мы
 * считали ранее. Вместо этого random-value для каждого pool вычисляется
 * stateless как `wang_hash(seed + pool_index)`. Это означает:
 *  1) Порядок обхода pools = template order (0..N-1)
 *  2) Никаких burn'ов / warmup
 *  3) Каждый pool независим, что позволяет точно предсказать pattern_idx
 *     для любого seed без симуляции всей карты
 *
 * Алгоритм генерации карты:
 *
 *   Phase 1 (в WildMap..ctor):
 *     latestObjectId = 0
 *     for fo in template.fixedObject:
 *         latestObjectId++
 *         spawn fixed object with that id
 *
 *   Phase 2 (в GenerateWildMap):
 *     for pool_idx, pool in enumerate(template.wild_pattern_pool):
 *         random_value = wang_hash(seed + pool_idx)
 *         pattern_idx  = GetWeightedPatternIndex(weights, random_value)
 *         for obj in pool.pool[pattern_idx].objects:
 *             latestObjectId++
 *             spawn object at pool.pos + obj.pos
 *         for so in pool.pool[pattern_idx].scene_objects:
 *             append to sceneObjects (НЕ инкрементирует latestObjectId)
 *
 * Хеш-функция wang_hash (из unnamed_function_10884):
 *   uint hash(uint x):
 *       x = ((x >> 16) ^ x ^ 0x3D) * 9
 *       x = ((x >>  4) ^ x) * 0x27D4EB2D
 *       return (x >> 15) ^ x
 *
 * Pattern weight selection (cumulative, value % total < cum):
 *   total = sum(weights)
 *   v     = value % total      // signed C-style modulo
 *   cum   = 0
 *   for i, w in enumerate(weights):
 *       cum += w
 *       if v < cum: return i
 *   return 0
 */

/** Cast number to int32 (two's complement). */
function toInt32 (x: number): number {
  return x | 0
}

/** Signed 32-bit multiplication, Math.imul. */
const imul32 = Math.imul

/**
 * Wang-style integer hash (stateless), 32-bit:
 *
 *   x = ((x >> 16) ^ x ^ 0x3D) * 9
 *   x = ((x >>  4) ^ x) * 0x27D4EB2D
 *   return (x >> 15) ^ x
 *
 * shift-right в декомпиле — арифметический (signed `>>` в JS),
 * но XOR с uint32-маской компенсирует знак.
 */
export function wangHash (x: number): number {
  let v = toInt32(x)
  v = imul32(((v >> 16) ^ v ^ 0x3d) >>> 0, 9)
  v = imul32(((v >> 4) ^ v) >>> 0, 0x27d4eb2d)
  return toInt32(((v >> 15) ^ v) >>> 0)
}

/**
 * C-style truncating modulo: `a % b`, sign of result follows `a`.
 * JS `%` uses truncating modulo for integers, но мы хотим явность.
 */
function cMod (a: number, b: number): number {
  if (b === 0) return 0
  return a - Math.trunc(a / b) * b
}

/**
 * GetWeightedPatternIndex — выбор pattern по value через cumulative-weight.
 * Возвращает индекс выбранного pattern в `weights`.
 *
 * @param weights — массив весов (натуральные числа, byte в C#-источнике)
 * @param value   — random value (любой int32, может быть отрицательным)
 */
export function getWeightedPatternIndex (weights: readonly number[], value: number): number {
  let total = 0
  for (const w of weights) total += w
  if (total <= 0) return 0
  const v = cMod(toInt32(value), total)
  let cum = 0
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i] ?? 0
    if (v < cum) return i
  }
  return 0
}

// ============================================================
// Template / WildMap types
// ============================================================

export interface WildSceneObjectTemplate {
  pos: string                       // "x-z"
  type: number
}

export interface WildObjectTemplate {
  pos: string                       // "x-z"  (relative to pool origin)
  type: number
  hp?: number
  data?: string
}

export interface WildMapPattern {
  tile?: string                     // base64 byte[]
  objects: WildObjectTemplate[] | null
  scene_objects?: WildSceneObjectTemplate[] | null
  weight: number                    // byte
}

export interface WildPatternPool {
  pos_x: number
  pos_z: number
  size_x: number
  size_z: number
  pool: WildMapPattern[]
}

export interface WildMapTemplate {
  tile?: string                     // base64 byte[]
  fixed_object?: WildObjectTemplate[] | null
  wild_pattern_pool: WildPatternPool[]
  uniqueWildObjectIds?: number[] | null
}

export interface SpawnedObject {
  id: number
  type: number
  pos: { x: number, z: number }
  source: 'fixed' | 'pool'
  poolIndex: number                 // -1 для fixed
  patternIndex: number              // -1 для fixed
}

export interface SpawnedSceneObject {
  pos: { x: number, z: number }
  type: number
}

export interface GeneratedWildMap {
  seed: number
  latestObjectId: number
  objects: SpawnedObject[]
  sceneObjects: SpawnedSceneObject[]
  patternsPicked: number[]          // index в pool.pool, по pool_idx
}

// ============================================================
// Map generation
// ============================================================

function parsePos (s: string | undefined): { x: number, z: number } {
  if (typeof s !== 'string') return { x: 0, z: 0 }
  const idx = s.indexOf('-')
  if (idx < 0) return { x: 0, z: 0 }
  const x = Number.parseInt(s.slice(0, idx), 10)
  const z = Number.parseInt(s.slice(idx + 1), 10)
  return {
    x: Number.isFinite(x) ? x : 0,
    z: Number.isFinite(z) ? z : 0
  }
}

/**
 * Симулирует серверную генерацию wild-карты для заданного `seed` + `template`.
 *
 * Возвращает полное содержимое карты — список заспавненных объектов с их id/type/pos
 * (id точно совпадает с server-side, что критично для anti-cheat валидации).
 *
 * @param template — расшифрованный template из POST /wild/download/wildtemplate
 * @param seed     — расшифрованный seed из POST /wild/create (целое число)
 * @param monsterRatio — обычно 0/-1; пока поддерживается только этот случай
 *                       (>0 потребует дополнительных правок весов на основе
 *                       uniqueWildObjectIds, см. unnamed_function_20641 ветку param4>0).
 */
export function generateWildMap (
  template: WildMapTemplate,
  seed: number,
  monsterRatio: number = 0
): GeneratedWildMap {
  if (monsterRatio > 0) {
    throw new Error('generateWildMap: monsterRatio>0 не реализован — нужно реверс-инжинирить ветку с uniqueWildObjectIds (unnamed_function_20641 param4>0)')
  }

  const objects: SpawnedObject[] = []
  const sceneObjects: SpawnedSceneObject[] = []
  let latestObjectId = 0

  // Phase 1: fixed_object из template (in-place IDs)
  for (const fo of template.fixed_object ?? []) {
    latestObjectId++
    const p = parsePos(fo.pos)
    objects.push({
      id: latestObjectId,
      type: fo.type,
      pos: p,
      source: 'fixed',
      poolIndex: -1,
      patternIndex: -1
    })
  }

  // Phase 2: для каждого pool — выбрать pattern и заспавнить объекты
  const pools = template.wild_pattern_pool ?? []
  const patternsPicked: number[] = []
  for (let poolIdx = 0; poolIdx < pools.length; poolIdx++) {
    const pool = pools[poolIdx]
    if (!pool || !pool.pool || pool.pool.length === 0) {
      patternsPicked.push(-1)
      continue
    }
    const value = wangHash(toInt32(seed + poolIdx))
    const weights = pool.pool.map((p) => Number(p?.weight ?? 0) & 0xff)
    const pIdx = getWeightedPatternIndex(weights, value)
    patternsPicked.push(pIdx)

    const chosen = pool.pool[pIdx]
    if (!chosen) continue

    for (const obj of chosen.objects ?? []) {
      latestObjectId++
      const rel = parsePos(obj.pos)
      objects.push({
        id: latestObjectId,
        type: obj.type,
        pos: { x: pool.pos_x + rel.x, z: pool.pos_z + rel.z },
        source: 'pool',
        poolIndex: poolIdx,
        patternIndex: pIdx
      })
    }
    for (const so of chosen.scene_objects ?? []) {
      const rel = parsePos(so.pos)
      sceneObjects.push({
        pos: { x: pool.pos_x + rel.x, z: pool.pos_z + rel.z },
        type: so.type
      })
    }
  }

  return {
    seed,
    latestObjectId,
    objects,
    sceneObjects,
    patternsPicked
  }
}

/**
 * Найти заспавненный wild-object по позиции (после `generateWildMap`).
 *
 * Полезно при формировании wild-actions: после вычисления карты можно найти,
 * например, ближайшее дерево (type=1, ChopWood-able) или камень (type=9, HitRock-able)
 * к стартовой позиции игрока.
 */
export function findObjectAtPos (
  map: GeneratedWildMap,
  x: number,
  z: number
): SpawnedObject | undefined {
  return map.objects.find((o) => o.pos.x === x && o.pos.z === z)
}

/**
 * Найти все заспавненные объекты определённого type.
 * type 1 = Log (ChopWood для wood), 9-11 = разные камни (HitRock для stone),
 * 17 = Grass (Cut для leather/grass).
 */
export function findObjectsByType (
  map: GeneratedWildMap,
  type: number
): SpawnedObject[] {
  return map.objects.filter((o) => o.type === type)
}

// ============================================================
// ActionType enum (из IL2CPP)
// ============================================================

/**
 * ActionType enum (см. dump.cs, RESEARCH_STATUS.md).
 * Каждый action_type должен соответствовать type объекта на карте,
 * иначе сервер вернёт "action type does not match: expected X, actual Y".
 */
export const ActionType = {
  Walk: 1,
  UseItem: 2,
  Open: 3,
  PickUp: 4,
  ChopWood: 8,
  HitRock: 9,
  Cut: 10,
  Smash: 16,
  MineMineral: 17,
  ChangeWorld: 30
} as const

export type ActionType = (typeof ActionType)[keyof typeof ActionType]

/**
 * Маппинг WildObject.type → ActionType, который сервер ожидает для добычи ресурса.
 * (По данным наблюдений из реального HAR + декомпиляции anti-cheat валидации.)
 */
export const OBJECT_TYPE_TO_ACTION: Readonly<Record<number, ActionType>> = {
  1: ActionType.ChopWood,    // Log — wood
  2: ActionType.ChopWood,    // BigTree — wood
  9: ActionType.HitRock,     // SmallRock — stone
  10: ActionType.HitRock,    // BigRock — stone
  11: ActionType.HitRock,    // Boulder — stone (?)
  17: ActionType.Cut         // Grass/Bush — leather/grass
}

/**
 * Resource index, выдаваемый ChopWood/HitRock/Cut. Используется в
 * action_result.resource_changed = ["{class}-{amount}"] и в /inventory/resources items.
 *
 * Подтверждено по recipe burn_resources:
 *   Recipe Tomato Seed: burn_resources=[{index:0, amount:15}] → wood
 *   Recipe Corn Seed:   burn_resources=[{index:1, amount:15}] → stone
 */
export const RESOURCE_INDEX = {
  Wood: 0,
  Stone: 1,
  Leather: 2
} as const

export const ACTION_TO_RESOURCE_INDEX: Readonly<Record<number, number>> = {
  [ActionType.ChopWood]: RESOURCE_INDEX.Wood,
  [ActionType.HitRock]: RESOURCE_INDEX.Stone,
  [ActionType.Cut]: RESOURCE_INDEX.Leather
}
