// The line of readers per partition (buffer-budget.ts): the oldest reader may go past the partition's limit so it can
// finish and give its share back; only it can be refused, and only when nothing in the budget moves; a later reader
// waits for its turn with no limit of its own; a reader whose client left stops waiting.

import { describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES } from '../../../../broker/policy/bundle-hash.js'
import { BufferBudget, MAX_BUFFERED_BYTES } from '../buffer-budget.js'

// buffer-budget.ts keeps these two limits private: four files' worth per partition, sixteen over every partition.
const PARTITION = 4 * MAX_BUFFERED_BYTES
const TOTAL = 16 * MAX_BUFFERED_BYTES
const CHUNK = 256 * 1024
const WAIT_MS = 60
const P = 'https://turns.example'
const live = new AbortController().signal

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a promise has settled yet, for a wait that must still be going. */
function watch (promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false }
  void promise.then(() => { state.settled = true })
  return state
}

/** Every partition but `P` filled to its limit, so the combined backstop is full but for `spare` bytes in the last one. */
function fillBackstop (budget: BufferBudget, spare = 0): string[] {
  const others = Array.from({ length: TOTAL / PARTITION }, (_, each) => `https://full${String(each)}.example`)
  others.forEach((partition, each) => { expect(budget.reserve(partition, each === others.length - 1 ? PARTITION - spare : PARTITION)).toBe(true) })
  return others
}

describe('the buffer budget, with readers waiting in line', () => {
  it('lets the oldest reader take a chunk past a full partition', async () => {
    const budget = new BufferBudget()
    const oldest = budget.enter(P)
    for (let each = 0; each < 4; each++) expect(await budget.takeWithin(P, MAX_BUFFERED_BYTES, WAIT_MS, oldest, live)).toBe(true)
    expect(budget.reserve(P, CHUNK)).toBe(false)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest, live)).toBe(true)
    // Another partition has its own share, whatever this one holds.
    expect(budget.reserve('https://other.example', CHUNK)).toBe(true)
  })

  it('lets the oldest reader take the largest file an app may carry past a full partition, and not a byte more', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    expect(await budget.takeWithin(P, MAX_ASSET_BYTES, WAIT_MS, oldest, live)).toBe(true)
    expect(await budget.takeWithin(P, 1, WAIT_MS, oldest, live)).toBe(false)
  })

  it('refuses the oldest reader after the wait when nothing in the budget moves', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    expect(await budget.takeWithin(P, MAX_ASSET_BYTES, WAIT_MS, oldest, live)).toBe(true)
    const started = Date.now()
    expect(await budget.takeWithin(P, 1, WAIT_MS, oldest, live)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 10)
  })

  it('does not refuse a later reader however long it waits behind an older one, and lets it in once that one leaves', async () => {
    const budget = new BufferBudget()
    // Held by a request that is not in the line, so the partition stays full after the oldest reader is gone.
    expect(budget.reserve(P, PARTITION)).toBe(true)
    const oldest = budget.enter(P)
    const later = budget.enter(P)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest, live)).toBe(true)
    const taking = budget.takeWithin(P, CHUNK, WAIT_MS, later, live)
    const waiting = watch(taking)
    await sleep(4 * WAIT_MS)
    expect(waiting.settled).toBe(false)
    budget.release(P, CHUNK)
    budget.leave(P, oldest)
    expect(await taking).toBe(true)
  })

  it('does not refuse the oldest reader while another partition keeps moving', async () => {
    const budget = new BufferBudget()
    const others = fillBackstop(budget, 4096)
    const oldest = budget.enter(P)
    const wait = 150
    const busy = others[others.length - 1] as string
    const slowRead = setInterval(() => { budget.reserve(busy, 1) }, 20)
    const started = Date.now()
    const taking = budget.takeWithin(P, CHUNK, wait, oldest, live)
    await sleep(4 * wait)
    clearInterval(slowRead)
    budget.release(others[0] as string, PARTITION)
    expect(await taking).toBe(true)
    expect(Date.now() - started).toBeGreaterThan(2 * wait)
  })

  it('counts a reserve and a release of the same size as movement', async () => {
    const budget = new BufferBudget()
    const others = fillBackstop(budget)
    const oldest = budget.enter(P)
    const wait = 150
    const busy = others[others.length - 1] as string
    // The budget holds the same bytes whenever the reader looks, yet something moved in between.
    const churn = setInterval(() => { budget.release(busy, 1); budget.reserve(busy, 1) }, 20)
    const started = Date.now()
    const taking = budget.takeWithin(P, CHUNK, wait, oldest, live)
    await sleep(4 * wait)
    clearInterval(churn)
    budget.release(others[0] as string, PARTITION)
    expect(await taking).toBe(true)
    expect(Date.now() - started).toBeGreaterThan(2 * wait)
  })

  it('stops waiting at once when the client of the read has left', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    budget.enter(P)
    const later = budget.enter(P)
    const left = new AbortController()
    const started = Date.now()
    const taking = budget.takeWithin(P, CHUNK, 5_000, later, left.signal)
    await sleep(2 * WAIT_MS)
    left.abort()
    expect(await taking).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_500)
    // A client that left before the wait began takes nothing.
    const gone = new AbortController()
    gone.abort()
    const elsewhere = 'https://elsewhere.example'
    expect(await budget.takeWithin(elsewhere, CHUNK, WAIT_MS, budget.enter(elsewhere), gone.signal)).toBe(false)
    expect(budget.reserve(elsewhere, PARTITION)).toBe(true)
  })

  it('still stops the oldest reader at the combined backstop', async () => {
    const budget = new BufferBudget()
    fillBackstop(budget)
    const oldest = budget.enter(P)
    expect(budget.reserve(P, 1, true)).toBe(false)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, oldest, live)).toBe(false)
  })

  it('makes the next reader the oldest when the line empties and fills again', async () => {
    const budget = new BufferBudget()
    expect(budget.reserve(P, PARTITION)).toBe(true)
    budget.leave(P, budget.enter(P))
    const next = budget.enter(P)
    expect(await budget.takeWithin(P, CHUNK, WAIT_MS, next, live)).toBe(true)
  })
})
