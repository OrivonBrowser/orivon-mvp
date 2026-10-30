// The line of readers per partition (buffer-budget.ts): the oldest reader is let past the partition's limit so it can
// finish and give its share back, a later one waits its turn, and a wait ends only when nothing in the partition moves.

import { describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES } from '../../../../broker/policy/bundle-hash.js'
import { BufferBudget, MAX_BUFFERED_BYTES } from '../buffer-budget.js'

// buffer-budget.ts keeps these two limits private: four files' worth per partition, sixteen over every partition.
const PARTITION = 4 * MAX_BUFFERED_BYTES
const TOTAL = 16 * MAX_BUFFERED_BYTES
const CHUNK = 256 * 1024
const WAIT_MS = 60
const P = 'https://turns.example'

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))

describe('the buffer budget, with readers waiting in line', () => {
  it('lets the oldest reader take a chunk past a full partition, and holds a later reader back', async () => {
    const budget = new BufferBudget()
    const oldest = budget.enter(P)
    const later = budget.enter(P)
    for (let each = 0; each < 4; each++) expect(await budget.takeWithin(P, MAX_BUFFERED_BYTES, WAIT_MS, oldest)).toBe(true)
    expect(budget.reserve(P, CHUNK)).toBe(false)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest)).toBe(true)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, later)).toBe(false)
    // Another partition has its own share, whatever this one holds.
    expect(budget.reserve('https://other.example', CHUNK)).toBe(true)
  })

  it('lets the oldest reader take the largest file an app may carry past a full partition, and not a byte more', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    expect(await budget.takeWithin(P, MAX_ASSET_BYTES, WAIT_MS, oldest)).toBe(true)
    expect(await budget.takeWithin(P, 1, WAIT_MS, oldest)).toBe(false)
  })

  it('lets a later reader in once the oldest has given its share back and left', async () => {
    const budget = new BufferBudget()
    // Held by a request that is not in the line, so the partition stays full after the oldest reader is gone.
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    const later = budget.enter(P)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest)).toBe(true)
    const waiting = budget.takeWithin(P, CHUNK, 5_000, later)
    await sleep(2 * WAIT_MS)
    budget.release(P, CHUNK)
    budget.leave(P, oldest)
    expect(await waiting).toBe(true)
  })

  it('refuses a later reader after the wait when nothing in the partition moves', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    budget.enter(P)
    const later = budget.enter(P)
    const started = Date.now()
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, later)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 10)
  })

  it('does not refuse a later reader at the wait while the partition keeps moving', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    const later = budget.enter(P)
    const wait = 150
    let taken = 0
    const slowRead = setInterval(() => {
      if (budget.reserve(P, 1024, true)) taken += 1024
    }, 20)
    const started = Date.now()
    const waiting = budget.takeWithin(P, CHUNK, wait, later)
    await sleep(4 * wait)
    clearInterval(slowRead)
    budget.release(P, taken)
    budget.leave(P, oldest)
    expect(await waiting).toBe(true)
    expect(Date.now() - started).toBeGreaterThan(2 * wait)
  })

  it('still stops the oldest reader at the combined backstop', async () => {
    const budget = new BufferBudget()
    for (let each = 0; each < TOTAL / PARTITION; each++) expect(budget.reserve(`https://full${String(each)}.example`, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    expect(budget.reserve(P, 1, true)).toBe(false)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest)).toBe(false)
  })

  it('makes the next reader the oldest when the line empties and fills again', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    budget.leave(P, budget.enter(P))
    const next = budget.enter(P)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, next)).toBe(true)
  })
})
