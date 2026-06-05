import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, retryWithBackoff } from '../src/backoff.js'

describe('backoffDelay', () => {
  it('returns exponentially increasing delays', () => {
    const d0 = backoffDelay(0, { jitter: 0 })
    const d1 = backoffDelay(1, { jitter: 0 })
    const d2 = backoffDelay(2, { jitter: 0 })

    assert.equal(d0, 1000)
    assert.equal(d1, 2000)
    assert.equal(d2, 4000)
  })

  it('respects maxMs cap', () => {
    const d = backoffDelay(20, { jitter: 0, maxMs: 5000 })
    assert.equal(d, 5000)
  })

  it('adds jitter when jitter > 0', () => {
    const delays = Array.from({ length: 50 }, () => backoffDelay(2, { jitter: 0.5 }))
    const unique = new Set(delays)
    // With jitter, not all values should be identical
    assert.ok(unique.size > 1, 'Expected jitter to produce varying delays')
  })

  it('uses custom baseMs', () => {
    const d = backoffDelay(0, { baseMs: 500, jitter: 0 })
    assert.equal(d, 500)
  })
})

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const result = await retryWithBackoff(async () => 42)
    assert.equal(result, 42)
  })

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0
    const result = await retryWithBackoff(async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      return 'ok'
    }, { maxAttempts: 5, baseMs: 10 })

    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  it('throws after maxAttempts exhausted', async () => {
    await assert.rejects(
      () => retryWithBackoff(async () => { throw new Error('always fails') }, { maxAttempts: 2, baseMs: 10 }),
      { message: 'always fails' }
    )
  })

  it('calls onRetry callback', async () => {
    const retries: number[] = []
    let calls = 0
    await retryWithBackoff(
      async () => { calls++; if (calls < 2) throw new Error('fail') },
      { maxAttempts: 3, baseMs: 10, onRetry: (_err, attempt) => retries.push(attempt) }
    )
    assert.deepEqual(retries, [0])
  })
})
