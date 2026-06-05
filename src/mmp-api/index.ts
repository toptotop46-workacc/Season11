export {
  MmpClient,
  MMP_API_BASE,
  MMP_CLIENT_VERSION,
  DEFAULT_CHARACTER
} from './client.js'

export type { MmpClientOptions } from './client.js'

export {
  generateRsaKeyPair,
  deriveAesKey,
  decryptResponseData,
  decryptResponseJson,
  encryptInner,
  encryptRequestBody
} from './crypto.js'

export type { RsaKeyPair } from './crypto.js'

export type {
  AllowToEnterWildZoneData,
  BridgeInfoData,
  CharacterCreateBody,
  CharacterDefinition,
  ClientMissionProgressData,
  FarmDecoration,
  FarmPlacement,
  FarmSaveContent,
  InventoryClassTypeItem,
  InventoryExportImportBody,
  InventoryItemsData,
  InventoryPostResponseData,
  InventoryPriceData,
  LoginResponseData,
  MissionEntry,
  MissionsListData,
  MmpEnvelope,
  PendingTransactionStatus,
  SaveFileBody,
  SaveFileResponseData,
  SignupResponseData,
  TutorialProgressBody,
  TutorialProgressResponseData,
  UnclejackCraftBody,
  WildAction,
  WildCreateBody,
  WildCreateResponseData,
  WildDownloadTemplateBody,
  WildObjectState,
  WildSaveBody,
  WildSaveContent,
  WildSaveNonceIssueBody,
  WildSaveNonceIssueResponseData
} from './types.js'

export {
  ESCROW_ABI,
  ESCROW_ADDRESS,
  ERC20_MIN_ABI,
  NATIVE_TOKEN_ADDRESS,
  encodeEscrowDeposit,
  extractTransactionIdFromReceipt,
  isEscrowPaused,
  readEscrowCounts,
  readEscrowTransaction
} from './escrow.js'

export type { EscrowAbi } from './escrow.js'

export {
  generateWildMap,
  wangHash,
  getWeightedPatternIndex,
  ActionType,
  OBJECT_TYPE_TO_ACTION,
  RESOURCE_INDEX,
  ACTION_TO_RESOURCE_INDEX
} from './wild-rng.js'

export type {
  WildMapTemplate,
  WildPatternPool,
  WildMapPattern,
  WildObjectTemplate,
  WildSceneObjectTemplate,
  GeneratedWildMap,
  SpawnedObject,
  SpawnedSceneObject
} from './wild-rng.js'

export {
  ENERGY_MAX,
  ENERGY_PER_ACTION,
  ACTION_CHANGE_WORLD,
  CHANGE_TYPE,
  DROP_PROFILES,
  pickTargets,
  buildActions,
  chunkActions,
  buildWildSaveContent,
  enrichObjMap,
  adjacentPosition,
  isResourceGoalMet
} from './wild-planner.js'

export type {
  ResourceGoal,
  PlannedTarget,
  PlanResult,
  BuiltAction,
  BuildActionsOptions,
  BuildActionsResult,
  SessionState,
  WildSaveBatchContent
} from './wild-planner.js'

/**
 * Контракты Soneium-production из contract-manifest.
 * Используется как справочник адресов для bridge/farm логики.
 */
export const MMP_TOKEN_ADDRESSES = {
  cornSeed: '0xda1ad7dbb1e84cdf99b046a0b872179250818b20',
  cabbageSeed: '0x41c7180cdd4245f56481f9613b8b9ee0b80e8046',
  carrotSeed: '0x062a8648f9f21df2e9bb18b988c316ccf055247d',
  tomatoSeed: '0xaeff687e6d12dff7f715a26e17af9847b640301b',
  cornCrop: '0xf5d6a8a9d2d1a5521e4c63c40d210f625be93291',
  tomatoCrop: '0x950f1fd6c3f5c1ee6eed9e10e353a33bd7e91efd',
  cabbageCrop: '0x426985add33ddde19a7753854cabad1cebc5c736',
  carrotCrop: '0x8af73da5d72c14315ebaa295b2f31e6f12659713',
  lumi: '0xcdb78fc87ec2989183c55629f6bf662fea8cef07'
} as const

export const MMP_CONTRACT_ADDRESSES = {
  inventoryBridger: '0x9bf9765e81e3dbaa3b93d593864f22b2778bd541',
  mintRouter: '0xf58b1d2327d4d5c7deb7e262c42418632a6c0e83',
  escrow: '0xe3b426925cc07f2e812d51fa9386f442649b7bb0',
  smartShop: '0x0ababa17fdd442f3dea4d9737e255d2a02840885',
  merchantShop: '0x47400de7982436d68f44bd1fab63ada816eb80d7',
  npcCallHelper3: '0x55933fa254dbb2a6f0b51969a03348745a5e7341',
  npcCallHelper4: '0x01db2ebff4fac720cd7429305a9403eb57de15c4',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  farmCornSeed: '0x63ba28fb04b4130557ee7810d829689df4ac3845',
  farmCabbageSeed: '0x9e5bf4fad0a26444509d42bbe5482f36066f091c',
  farmCarrotSeed: '0x281424b63b38f96a6d5c9d5e869eb1d0cfd82bb2',
  farmTomatoSeed: '0xe33ff006ba78797984930bea5bca607457a58f93'
} as const
