/**
 * Единый реестр адресов контрактов сети Soneium.
 *
 * Все адреса токенов, роутеров и контрактов модулей собраны здесь, чтобы
 * при смене сезона / обновлении протоколов не искать их по 14 файлам.
 * Модули импортируют адреса отсюда, а не хардкодят у себя.
 */

type Address = `0x${string}`

/** Нулевой адрес — обозначает нативный ETH в свапах. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * Общие токены сети Soneium (используются сразу несколькими модулями).
 */
export const TOKENS = {
  /** Нативный ETH (нулевой адрес). */
  ETH: ZERO_ADDRESS,
  /** Wrapped ETH. */
  WETH: '0x4200000000000000000000000000000000000006',
  /** USD Coin (bridged). */
  USDC_e: '0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369',
  /** Tether USD. */
  USDT: '0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35',
  /** USDSC. */
  USDSC: '0x3f99231dD03a9F0E7e3421c92B7b90fbe012985a'
} as const satisfies Record<string, Address>

/**
 * Адреса контрактов/роутеров отдельных протоколов и модулей.
 */
export const CONTRACTS = {
  // Velodrome (Uniswap V4-style)
  velodromeUniversalRouter: '0x01D40099fCD87C018969B0e8D4aB1633Fb34763C',
  velodromeV4Quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
  velodromeQuoterFallback1: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
  velodromeQuoterFallback2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',

  // WheelX (Uniswap-style роутер)
  wheelxUniswapRouter: '0x273f68c234fa55b550b40e563c4a488e0d334320',

  // Модули чек-инов / спинов
  lootcoin: '0x21Be1D69A77eA5882aCcD5c5319Feb7AC3854751',
  harkan: '0x983B499181A1B376CEE9Ffe18984cF62A767f745',
  captainCheckin: '0xedCbF9D4CC3BA9aAA896adADeac1b6DF6326f7D8',
  arkadaCheckin: '0x98826e728977B25279ad7629134FD0e96bd5A7b2',
  diceOrDieCheckin: '0x17c7E99c2c1aEFdf3811F72ce960a0d560F039B4',

  // Stargate (bridge ETH)
  stargatePoolNative: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
  stargateEthLp: '0x26CA12d5eC43AA9f0aDb4a891918B70CF5720281',

  // Collector (вывод средств из протоколов)
  aaveAToken: '0xb2C9E934A55B58D20496A5019F8722a96d8A44d8',
  morphoMetamorpho: '0xecdbe2af33e68cf96f6716f706b078fa94e978cb',
  collectorStargatePool: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
  sakeAToken: '0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726',
  untitledBank: '0xc675BB95D73CA7db2C09c3dC04dAaA7944CCBA41'
} as const satisfies Record<string, Address>

/**
 * Адреса известных спендеров (контрактов, которым кошельки выдают апрувы).
 * Используются модулем revoke для отзыва разрешений.
 */
export const SPENDERS = {
  AAVE_L2_POOL: '0xdd3d7a7d03d9fd9ef45f3e587287922ef65ca38b',
  MORPHO_METAMORPHO: '0xecdbe2af33e68cf96f6716f706b078fa94e978cb',
  STARGATE_POOL: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
  UNTITLED_BANK: '0xc675BB95D73CA7db2C09c3dC04dAaA7944CCBA41',
  SONUS: '0x882Af8BD0A035d4BCEb42DEe8A5A7bC8Ef2F6FF9',
  WHEELX: '0x7eC9672678509a574F6305F112a7E3703845a98b',
  RELAY: '0xBBbfD134E9b44BfB5123898BA36b01dE7ab93d98',
  LI_FI: '0x864b314D4C5a0399368609581d3E8933a63b9232',
  SAKE: '0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f',
  UNISWAP_V3: '0x273F68c234fA55b550b40E563c4a488e0D334320'
} as const satisfies Record<string, Address>
