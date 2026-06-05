import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config.js'

describe('config', () => {
  it('has default RPC URLs', () => {
    assert.ok(Array.isArray(config.rpcUrls))
    assert.ok(config.rpcUrls.length >= 1)
    assert.ok(config.rpcUrls[0]!.startsWith('https://'))
  })

  it('has numeric timeout defaults', () => {
    assert.equal(typeof config.rpcTimeout, 'number')
    assert.ok(config.rpcTimeout > 0)
    assert.equal(typeof config.statsApiTimeout, 'number')
    assert.ok(config.statsApiTimeout > 0)
  })

  it('has valid API base URL', () => {
    assert.ok(config.statsApiBaseUrl.startsWith('https://'))
  })

  it('has valid explorer URL', () => {
    assert.ok(config.explorerUrl.startsWith('https://'))
  })
})
