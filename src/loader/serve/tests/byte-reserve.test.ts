import { describe, expect, it } from 'vitest'
import { ByteReserve } from '../byte-reserve.js'

async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A take that can be asked, without waiting for it, whether it has settled. */
function watch (taking: Promise<boolean>): { readonly promise: Promise<boolean>, readonly settled: () => boolean | undefined } {
  let result: boolean | undefined
  const promise = taking.then((value) => { result = value; return value })
  return { promise, settled: () => result }
}

/** Gives back and takes again `bytes` every `everyMs`: the reserve moves while its held total stays where it was. */
function churn (reserve: ByteReserve, reader: symbol, bytes: number, everyMs: number): () => void {
  const timer = setInterval(() => {
    reserve.give(bytes)
    void reserve.take(bytes, 0, reader)
  }, everyMs)
  return () => { clearInterval(timer) }
}

describe('ByteReserve', () => {
  it('lets the oldest reader hold its total plus one file, and not a byte more', async () => {
    const reserve = new ByteReserve(100, 40)
    const reader = reserve.enter()
    expect(await reserve.take(100, 0, reader)).toBe(true)
    expect(await reserve.take(40, 0, reader)).toBe(true)
    expect(await reserve.take(1, 0, reader)).toBe(false)
  })

  it('never lets a later reader past the total', async () => {
    const reserve = new ByteReserve(100, 40)
    const oldest = reserve.enter()
    const later = reserve.enter()
    expect(await reserve.take(100, 0, later)).toBe(true)
    expect(await reserve.take(1, 0, later)).toBe(false)
    expect(await reserve.take(1, 0, oldest)).toBe(true)
  })

  it('refuses the oldest reader once nothing has moved for the wait', async () => {
    const reserve = new ByteReserve(100, 40)
    const reader = reserve.enter()
    expect(await reserve.take(140, 0, reader)).toBe(true)
    expect(await reserve.take(1, 60, reader)).toBe(false)
  })

  it('refuses a later reader once nothing has moved for the wait, though an older reader sits in line', async () => {
    const reserve = new ByteReserve(100, 40)
    reserve.enter()
    const later = reserve.enter()
    expect(await reserve.take(100, 0, later)).toBe(true)
    expect(await reserve.take(30, 60, later)).toBe(false)
  })

  it('does not refuse a later reader while the reserve keeps moving, and lets it in once the reader ahead leaves', async () => {
    const reserve = new ByteReserve(100, 40)
    const older = reserve.enter()
    const later = reserve.enter()
    const mover = reserve.enter()
    expect(await reserve.take(100, 0, mover)).toBe(true)
    const waiting = watch(reserve.take(30, 400, later))
    const stop = churn(reserve, mover, 10, 15)
    await sleep(600)
    expect(waiting.settled()).toBeUndefined()
    stop()
    reserve.leave(older)
    expect(await waiting.promise).toBe(true)
  })

  it('counts a take and a give of equal size as movement', async () => {
    const reserve = new ByteReserve(100, 40)
    const oldest = reserve.enter()
    const other = reserve.enter()
    expect(await reserve.take(100, 0, other)).toBe(true)
    const waiting = watch(reserve.take(41, 400, oldest))
    const stop = churn(reserve, other, 10, 15)
    await sleep(600)
    expect(waiting.settled()).toBeUndefined()
    stop()
    expect(await waiting.promise).toBe(false)
  })

  it('serves a waiter as soon as bytes are given back', async () => {
    const reserve = new ByteReserve(100, 10)
    const reader = reserve.enter()
    await reserve.take(100, 0, reader)
    const waiting = reserve.take(30, 2_000, reader)
    setTimeout(() => { reserve.give(50) }, 60)
    expect(await waiting).toBe(true)
  })

  it('never goes below nothing when more is given back than was taken', async () => {
    const reserve = new ByteReserve(10, 0)
    const reader = reserve.enter()
    reserve.give(1_000)
    expect(await reserve.take(10, 0, reader)).toBe(true)
    expect(await reserve.take(1, 0, reader)).toBe(false)
  })

  it('lets a reader leave twice without touching the readers behind it', async () => {
    const reserve = new ByteReserve(10, 5)
    const first = reserve.enter()
    const second = reserve.enter()
    reserve.leave(first)
    reserve.leave(first)
    expect(await reserve.take(15, 0, second)).toBe(true)
  })
})
