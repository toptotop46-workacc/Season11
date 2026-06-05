import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Semaphore, mapConcurrent } from '../src/semaphore.js'

describe('Semaphore', () => {
  it('limits concurrency to the specified amount', async () => {
    const sem = new Semaphore(2)
    let maxRunning = 0
    let running = 0

    const task = async () => {
      await sem.acquire()
      running++
      if (running > maxRunning) maxRunning = running
      await new Promise(r => setTimeout(r, 20))
      running--
      sem.release()
    }

    await Promise.all([task(), task(), task(), task(), task()])
    assert.ok(maxRunning <= 2, `Expected max 2 concurrent, got ${maxRunning}`)
  })

  it('run() acquires and releases automatically', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    await Promise.all([
      sem.run(async () => { order.push(1); await new Promise(r => setTimeout(r, 10)) }),
      sem.run(async () => { order.push(2) })
    ])

    assert.deepEqual(order, [1, 2])
  })

  it('setLimit adjusts concurrency dynamically', () => {
    const sem = new Semaphore(5)
    assert.equal(sem.limit, 5)
    sem.setLimit(10)
    assert.equal(sem.limit, 10)
    sem.setLimit(0) // should clamp to 1
    assert.equal(sem.limit, 1)
  })
})

describe('mapConcurrent', () => {
  it('processes all items and respects concurrency', async () => {
    let maxRunning = 0
    let running = 0

    const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (item) => {
      running++
      if (running > maxRunning) maxRunning = running
      await new Promise(r => setTimeout(r, 10))
      running--
      return item * 2
    })

    assert.deepEqual(results, [2, 4, 6, 8, 10])
    assert.ok(maxRunning <= 2, `Expected max 2 concurrent, got ${maxRunning}`)
  })
})
