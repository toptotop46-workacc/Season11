import { privateKeyToAccount } from 'viem/accounts'
import { logger } from '../logger.js'

export interface KeyValidationResult {
  valid: boolean
  total: number
  invalid: number
  errors: string[]
}

const HEX64_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Validates an array of private keys:
 * - correct hex format (0x + 64 hex chars)
 * - derivable to a valid account (checksum / curve check via viem)
 *
 * Returns a summary; logs individual errors.
 */
export function validatePrivateKeys (keys: string[]): KeyValidationResult {
  const errors: string[] = []
  let invalid = 0

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const label = `Ключ #${i + 1}`

    if (!key.startsWith('0x')) {
      errors.push(`${label}: отсутствует префикс 0x`)
      invalid++
      continue
    }

    if (!HEX64_RE.test(key)) {
      errors.push(`${label}: неверный формат (ожидается 0x + 64 hex-символа, получено ${key.length} символов)`)
      invalid++
      continue
    }

    try {
      privateKeyToAccount(key as `0x${string}`)
    } catch {
      errors.push(`${label}: не удалось вывести аккаунт (ключ за пределами кривой)`)
      invalid++
    }
  }

  return { valid: invalid === 0, total: keys.length, invalid, errors }
}

/**
 * Validates keys and logs the result. Returns `true` if all keys are valid.
 */
export function validateAndLogKeys (keys: string[]): boolean {
  const result = validatePrivateKeys(keys)

  if (result.valid) {
    logger.success(`Все ${result.total} ключей валидны`)
    return true
  }

  logger.error(`Найдено ${result.invalid} невалидных ключей из ${result.total}:`)
  for (const err of result.errors) {
    logger.error(`  ${err}`)
  }
  return false
}
