/** Стандартный envelope ответов сервера MMP. */
export interface MmpEnvelope<T = unknown> {
  errors: string | null
  data: T
  meta: { info?: string, support_npc_info?: string, queue_id?: string } | null
  status_code: number
}

/** /v1/client/auth/signup */
export interface SignupResponseData {
  user: {
    id: string
    publicAddress: string
    loginNonce: number
    loginNonceResetOn: string | null
    loginType: string
    initialCountryCode: string
    countryCode: string
    createdAt: string
    updatedAt: string
  }
  countryCode: string
  isNewUser: boolean
}

/** /v1/client/auth/login (расшифрованный data). */
export interface LoginResponseData {
  user: {
    id: string
    publicAddress: string
    loginNonce: number
    loginNonceResetOn: string
    createdAt: string
    updatedAt: string
  }
  sessionToken: string
  loginData: {
    saveFiles: unknown[]
    character: unknown | null
    companion: unknown[]
    homeDecoration: Record<string, number>
    lodestoneInfo: { amount: number, incrementTime: string }
    serverKey: string
    chat_hilight: unknown | null
  }
  countryCode: string
  isNewUser: boolean
}

/** /v1/inventory/bridge/info */
export interface BridgeInfoData {
  quota: {
    export: { max_per_day: number, used: number, remaining: number }
    import: { max_per_day: number, used: number, remaining: number }
  }
}

/** /v1/inventory/exports[/price] и /v1/inventory/imports[/price] - request item shape. */
export interface InventoryClassTypeItem {
  class: number
  type: number
  amount: number
}

/** /v1/inventory/exports/price response data. */
export interface InventoryPriceData {
  price: string  // wei в виде string
  individual_item_prices: {
    nfts: Record<string, string>
    items: Record<string, string>  // {"class-type": price_wei}
  }
}

/** /v1/inventory/items, /v1/inventory/resources, /v1/inventory/nfts. */
export interface InventoryItemsData<T = unknown> {
  data: {
    items: T[] | null
    total_count: number
    total_pages: number
  }
}

/** Tutorial body — нужен nonce формата "{address}:{step_index}". */
export interface TutorialProgressBody {
  progress: number
  nonce: string
}

/** /v1/client/tutorial/progress (расшифрованный data). */
export interface TutorialProgressResponseData {
  pending_transaction_id: string
}

/** Persona-customization для character creation. */
export interface CharacterDefinition {
  gender: number
  head: number
  hair_color: number
  face: number
  body: number
  name: string
  equipments: string[]
  cosmetics: string[]
  equipment_slots: string[]
  cosmetic_slots: string[]
  jewel_slots: string[]
  locket_slots: string[]
}

export interface CharacterCreateBody {
  character: CharacterDefinition
  countryCode: string
}

/** /v1/npc/unclejack/craft request. */
export interface UnclejackCraftBody {
  type: 'resource' | 'treasure'
  recipe_ids: number[]
  amounts: number[]
}

/**
 * Body для /v1/inventory/exports и /v1/inventory/imports.
 * `transaction_id` — decimal-строка от Escrow.deposit (event Deposited.transactionId).
 */
export interface InventoryExportImportBody {
  items: InventoryClassTypeItem[]
  nfts: string[]
  transaction_id: string
}

/**
 * Ответ /inventory/exports и /inventory/imports.
 * Сервер ставит транзакцию в очередь и возвращает её id; мы потом polling-уем.
 */
export interface InventoryPostResponseData {
  pending_transaction_id?: string
  tx_queue_id?: string
  queue_id?: string
}

/** /v1/inventory/pending-transactions/{id} — статус pending tx. */
export interface PendingTransactionStatus {
  status: string                     // 'pending' | 'processing' | 'completed' | 'failed' | ...
  transaction_id?: string
  tx_hash?: string
  // Дополнительные поля сервер может добавлять; оставляем мягким
  [key: string]: unknown
}

// ============================================================
// SAVEFILE — POST /v1/client/{addr}/savefile (зашифровано)
//            GET  /v1/client/{addr}/savefile?fileName=...
// ============================================================

/** Размещение растения на in-game ферме. plantingID = "[<crop>]-[<crop>-seed]". */
export interface FarmPlacement {
  x: number
  y: number
  z: number
  plantingID: string
}

/** Декорация на ферме (заборы, дорожки и т.п.). orient = 0..3 (rotation). */
export interface FarmDecoration {
  x: number
  y: number
  orient: number
  id: number
}

/** Содержимое farmSaveData.json (в виде объекта; на проводе — JSON-строка). */
export interface FarmSaveContent {
  version: string                  // "2.0.0"
  placements: FarmPlacement[]
  companions: unknown[]
  decorations: FarmDecoration[]
}

/**
 * Тело POST savefile. `content` — это JSON-строка (сериализованная FarmSaveContent или WildSaveContent),
 * а не объект. Сервер хранит её как-есть.
 */
export interface SaveFileBody {
  saveFile: {
    fileName: string               // "farmSaveData.json" | "UserData/wild-save-data.json"
    content: string                // JSON.stringify(FarmSaveContent) | JSON.stringify(WildSaveContent)
  }
}

export interface SaveFileResponseData {
  saveFile: {
    id: string
    addressHex: string
    content: string
    createdAt: string
    updatedAt: string
  }
}

// ============================================================
// WILD ZONE
// ============================================================

/** /v1/wild/create (plain) → encrypted seed string. */
export interface WildCreateBody {
  map_no: number                   // 1 = "the crossing"
  version_map: string              // "0.5.7"
  captcha_token: string            // обычно ""
  captcha_verification_tier: number // обычно 1
}
export interface WildCreateResponseData {
  seed: string                     // base64(AES-GCM(int32-as-utf8))
}

/** /v1/wild/download/wildtemplate (encrypted) — wild map template. */
export interface WildDownloadTemplateBody {
  map_no: number
  version_map: string
  wild_save_file_id: string        // обычно ""
}

/** /v1/wild/wildsavenonce/issue (encrypted) — выдаёт инкрементный nonce. */
export interface WildSaveNonceIssueBody {
  d: 0
}
export interface WildSaveNonceIssueResponseData {
  nonce: number
}

/** Wild action — конкретное действие игрока (chop, hit, walk и т.п.). */
export interface WildAction {
  action_type: number              // 8=ChopWood, 9=HitRock, 10=Cut, 30=ChangeWorld...
  done_at: string                  // "HH-MM-SS"
  player_position: string          // "x-z"
  target_object: number            // wild object id
  action_index: number             // sequential
  action_result?: {
    energy_changed: number
    health_changed: number
    exp_gain: number
    resource_changed?: string[]    // ["1-1"] = wood-class-1
    wildObject_changed?: Array<{ id: number, hp_change: number, change_type: number }>
  }
}

/** Wild object на map (после spawn'а). */
export interface WildObjectState {
  id: number
  type: number                     // 1=Log, 2=BigTree, 9-11=Rocks, 17=Grass...
  pos: string                      // "x-z"
  status: number                   // 0=alive, 255=removed
  hp?: number
}

/** Состояние wild-zone session: то, что клиент шлёт в /wild/wildsave. */
export interface WildSaveContent {
  active: boolean
  map_current: number
  maps: Record<string, {
    name: number
    seed: number                   // decoded integer seed
    player_pos: string
    obj_map: WildObjectState[]     // изменённые из template объекты
    obj_new: WildObjectState[]     // вновь возникшие (например, осколки скал)
    latest_object_id: number
  }>
  health_max: number
  health_gain: number
  health_lose: number
  energy_max: number
  energy_gain: number
  energy_lose: number
  exp_gain: number
  mod_id_latest: number
  buffs: unknown[]
  buff_mods: unknown[]
  buff_mod_id_start: number
  actions: WildAction[]
  latest_action_index: number
  map_version: string              // "0.5.7"
}

export interface WildSaveBody {
  saveFile: {
    fileName: string               // "UserData/wild-save-data.json"
    content: WildSaveContent
  }
  nonce: number
}

/** /v1/client/allowtoenterwildzone (GET) */
export interface AllowToEnterWildZoneData {
  allowed: boolean
  reason: string
  Err: unknown | null
}

// ============================================================
// MISSIONS
// ============================================================

/** /v1/mission/missions (GET). */
export interface MissionEntry {
  id: string
  wallet_address: string
  mission_id: number
  pool_id: number
  objective_ids: Record<string, number>
  status: 'progressing' | 'completed' | string
  created_at: string
  updated_at: string
}
export interface MissionsListData {
  missions: MissionEntry[]
}

/** /v1/client/mission/progress (GET). */
export interface ClientMissionProgressData {
  entries: unknown[]
}
