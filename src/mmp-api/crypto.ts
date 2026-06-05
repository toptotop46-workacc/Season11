import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  type KeyObject,
  constants as cryptoConstants
} from 'node:crypto'

/**
 * Помощники RSA + AES-GCM, повторяющие схему шифрования Morning Moon Pocket.
 *
 * Открытия из RESEARCH_STATUS.md (раздел "Шифрование"):
 *   - RSA-2048 для обмена AES-ключом (PKCS1v15 padding, НЕ OAEP)
 *   - AES-256-GCM, IV = первые 12 байт ciphertext'а, в конце 16 байт auth tag
 *   - meta.ak = base64(RSA-encrypt(server_aes_key)) — возвращается на /auth/login
 *   - data    = base64(IV[12] + ciphertext + tag), AES-GCM шифрование тела
 *   - "Зашифрованные" эндпоинты используют ВНЕШНИЙ base64 поверх внутреннего:
 *       body = JSON({ data: base64(base64(IV+CT+TAG).utf8Bytes) })
 *     То есть base64-строка ещё раз кодируется как ASCII bytes и base64-фицирует.
 */

export interface RsaKeyPair {
  publicKeyPem: string
  privateKey: KeyObject
}

/** Генерирует RSA-2048 пару ключей для одной сессии (как делает Unity-клиент). */
export function generateRsaKeyPair (): RsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 65537
  })
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
  return { publicKeyPem, privateKey }
}

/**
 * Расшифровывает meta.ak с login-ответа в 32-байтный AES-256 ключ.
 *
 * Schema:
 *   ak (base64) → RSA-decrypt PKCS1v15 → 64-символьная hex-строка → fromHex → 32 байта
 *
 * Замечание: на сегодня сервер возвращает один и тот же AES-ключ для всех сессий
 * (`950ff7e859002e6ce3b6bbf83452bcceaffea1dbc6ed680ffde29e1b9e957309`), но
 * мы корректно расшифровываем — на случай если сервер начнёт ротировать.
 *
 * Реализация: вызываем `privateDecrypt` с `RSA_NO_PADDING` и вручную снимаем
 * PKCS#1 v1.5 padding (`unpadPkcs1v15`). Это нужно потому что с февраля 2024
 * Node.js (CVE-2023-46809, Marvin attack) отключает `RSA_PKCS1_PADDING` в
 * `privateDecrypt`, если используемый OpenSSL не поддерживает implicit
 * rejection. На Node 22+ опцию `--security-revert` убрали, поэтому на
 * некоторых сборках падает с:
 *   "RSA_PKCS1_PADDING is no longer supported for private decryption".
 * Сам сервер MMP жёстко завязан на PKCS1v15 — стороны не поменять, поэтому
 * обходим ограничение через raw RSA + самописный unpad.
 */
export function deriveAesKey (akBase64: string, privateKey: KeyObject): Buffer {
  const akBytes = Buffer.from(akBase64, 'base64')
  const raw = privateDecrypt(
    {
      key: privateKey,
      padding: cryptoConstants.RSA_NO_PADDING
    },
    akBytes
  )
  const unpadded = unpadPkcs1v15(raw)
  const hex = unpadded.toString('utf8').trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== 64) {
    throw new Error(`Unexpected ak payload (length=${hex.length}, hex=${/^[0-9a-fA-F]+$/.test(hex)})`)
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Снимает PKCS#1 v1.5 encryption padding с raw RSA-дешифрованного блока.
 *
 * Формат encryption-блока (RFC 8017 §7.2):
 *   EM = 0x00 || 0x02 || PS || 0x00 || M
 * где `PS` — ≥8 ненулевых случайных байт, `M` — полезная нагрузка.
 *
 * Бросает ошибку, если заголовок/разделитель не соответствует формату.
 * Экспортируется для unit-тестов; снаружи модуля использовать не нужно.
 */
export function unpadPkcs1v15 (em: Buffer): Buffer {
  if (em.length < 11 || em[0] !== 0x00 || em[1] !== 0x02) {
    throw new Error('PKCS1 v1.5 unpad: bad encryption block header')
  }
  let sep = -1
  for (let i = 2; i < em.length; i++) {
    if (em[i] === 0x00) { sep = i; break }
  }
  if (sep < 10) {
    throw new Error(`PKCS1 v1.5 unpad: invalid separator (idx=${sep})`)
  }
  return em.subarray(sep + 1)
}

/**
 * Расшифровывает поле `data` ответа: base64(IV[12] + ciphertext + tag[16]) → plaintext.
 * Возвращает строку UTF-8.
 */
export function decryptResponseData (dataBase64: string, aesKey: Buffer): string {
  const raw = Buffer.from(dataBase64, 'base64')
  if (raw.length < 12 + 16) {
    throw new Error(`Encrypted blob too short: ${raw.length} bytes`)
  }
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}

/** Расшифровывает в JSON. Бросает ошибку если plaintext не парсится. */
export function decryptResponseJson<T = unknown> (dataBase64: string, aesKey: Buffer): T {
  return JSON.parse(decryptResponseData(dataBase64, aesKey)) as T
}

/**
 * Шифрует plaintext: возвращает base64(IV[12] + ciphertext + tag[16]).
 * Используется как "внутренний" слой для request-encryption.
 */
export function encryptInner (plaintext: Buffer | string, aesKey: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv)
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const ct = Buffer.concat([cipher.update(data), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

/**
 * Полностью кодирует тело "зашифрованного" запроса.
 * inner = encryptInner(...)
 * outer = base64(utf8Bytes(inner))            ← ВТОРОЙ base64-слой!
 * body  = JSON.stringify({ data: outer })
 *
 * Эндпоинты, которым это нужно (см. RESEARCH_STATUS):
 * /character, /tutorial/progress, /wild/wildsave, /wild/wildsavenonce/issue,
 * /wild/download/wildtemplate, /client/{addr}/savefile.
 */
export function encryptRequestBody (plaintextObj: unknown, aesKey: Buffer): string {
  const plaintext = JSON.stringify(plaintextObj)
  const inner = encryptInner(plaintext, aesKey)
  const outer = Buffer.from(inner, 'utf8').toString('base64')
  return JSON.stringify({ data: outer })
}
