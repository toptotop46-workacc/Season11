import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validatePrivateKeys } from '../src/validators/key-validator.js'

describe('validatePrivateKeys', () => {
  it('accepts a valid 0x-prefixed 64-hex-char key', () => {
    // This is a well-known test private key (do NOT use in production)
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const result = validatePrivateKeys([key])
    assert.equal(result.valid, true)
    assert.equal(result.total, 1)
    assert.equal(result.invalid, 0)
  })

  it('rejects key without 0x prefix', () => {
    const result = validatePrivateKeys(['deadbeef'.repeat(8)])
    assert.equal(result.valid, false)
    assert.equal(result.invalid, 1)
    assert.ok(result.errors[0]?.includes('0x'))
  })

  it('rejects key with wrong length', () => {
    const result = validatePrivateKeys(['0xdeadbeef'])
    assert.equal(result.valid, false)
    assert.equal(result.invalid, 1)
    assert.ok(result.errors[0]?.includes('формат'))
  })

  it('rejects key with non-hex characters', () => {
    const result = validatePrivateKeys(['0x' + 'zz'.repeat(32)])
    assert.equal(result.valid, false)
    assert.equal(result.invalid, 1)
  })

  it('validates multiple keys and reports all errors', () => {
    const keys = [
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // valid
      '0xdeadbeef', // too short
      'no-prefix-key' // no prefix
    ]
    const result = validatePrivateKeys(keys)
    assert.equal(result.valid, false)
    assert.equal(result.total, 3)
    assert.equal(result.invalid, 2)
    assert.equal(result.errors.length, 2)
  })

  it('returns valid for empty array', () => {
    const result = validatePrivateKeys([])
    assert.equal(result.valid, true)
    assert.equal(result.total, 0)
  })
})
