import { performSeasonBadgeMint, type SeasonBadgeMintConfig } from './season-badge-mint.js'

// Конфигурация Season 8 SBT Badge Mint
const SEASON8_CONFIG: SeasonBadgeMintConfig = {
  season: 8,
  nftContract: '0x2E4A91B1a76D0Cbccc31526a1a6Cf81Dd9897E0c',
  mintPhase1Date: new Date('2026-04-15T10:00:00+03:00'), // Stage 1 для 84+
  mintPhase2Date: new Date('2026-04-29T10:00:00+03:00'), // Stage 2 для 80-83
  threshold: 80,
  txLabel: 'SEASON8_BADGE_MINT'
}

/**
 * Тонкая обёртка над универсальным `performSeasonBadgeMint` для Season 8.
 * Сохраняет обратную совместимость: возвращает поле `season8Points` вместо `seasonPoints`.
 */
export async function performSeason8BadgeMint (
  privateKey: `0x${string}`
): Promise<{
  success: boolean
  walletAddress?: string
  season8Points?: number
  transactionHash?: string
  explorerUrl?: string | null
  error?: string
  skipped?: boolean
  reason?: string
}> {
  const result = await performSeasonBadgeMint(privateKey, SEASON8_CONFIG)

  // Маппим унифицированное `seasonPoints` в исторически-совместимое `season8Points`
  const out: {
    success: boolean
    walletAddress?: string
    season8Points?: number
    transactionHash?: string
    explorerUrl?: string | null
    error?: string
    skipped?: boolean
    reason?: string
  } = {
    success: result.success
  }
  if (result.walletAddress !== undefined) out.walletAddress = result.walletAddress
  if (result.seasonPoints !== undefined) out.season8Points = result.seasonPoints
  if (result.transactionHash !== undefined) out.transactionHash = result.transactionHash
  if (result.explorerUrl !== undefined) out.explorerUrl = result.explorerUrl
  if (result.error !== undefined) out.error = result.error
  if (result.skipped !== undefined) out.skipped = result.skipped
  if (result.reason !== undefined) out.reason = result.reason

  return out
}
