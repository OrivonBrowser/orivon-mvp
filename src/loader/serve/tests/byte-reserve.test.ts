import { describe, expect, it } from 'vitest'
import { ByteReserve } from '../byte-reserve.js'

const live = new AbortController().signal

async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A take that can be asked, without waiting for it, whether it has settled. */
function watch (taking: Promise<boolean>): { readonly promise: Promise<boolean>, readonly settled: () => boolean | undefined } {
  let result: boolean | undefined
  const promise = taking.then((value) => { result = value; return value })
  return { promise, settled: () => result }
}

describe('ByteReserve', () => {
  it('lets the oldest reader hold its total plus one file, and not a byte more', async () => {
    const reserve = new ByteReserve(100, 40)
    const reader = reserve.enter()
    expect(await reserve.take(100, 0, reader, live)).toBe(true)
    expect(await reserve.take(40, 0, reader, live)).toBe(true)
    expect(await reserve.take(1, 0, reader, live)).toBe(false)
  })

  it('never lets a later reader past the total, however long it waits', async () => {
    const reserve = new ByteReserve(100, 40)
    const first = reserve.enter()
    const later = reserve.enter()
    expect(await reserve.take(60, 0, first, live)).toBe(true)
    expect(await reserve.take(40, 0, later, live)).toBe(true)
    const left = new AbortController()
    const waiting = watch(reserve.take(1, 0, later, left.signal))
    await sleep(80)
    expect(waiting.settled()).toBeUndefined()
    left.abort()
    expect(await waiting.promise).toBe(false)
  })

  it('refuses the oldest reader once nothing has moved for the wait', async () => {
    const reserve = new ByteReserve(100, 40)
    const reader = reserve.enter()
    expect(await reserve.take(140, 0, reader, live)).toBe(true)
    expect(await reserve.take(1, 60, reader, live)).toBe(false)
  })

  it('does not refuse a later reader while an older one sits in line, and lets it in once that one leaves', async () => {
    const reserve = new ByteReserve(100, 40)
    const older = reserve.enter()
    const later = reserve.enter()
    expect(await reserve.take(100, 0, later, live)).toBe(true)
    const waiting = watch(reserve.take(30, 40, later, live))
    await sleep(200)
    expect(waiting.settled()).toBeUndefined()
    reserve.leave(older)
    expect(await waiting.promise).toBe(true)
  })

  it('counts a take and a give of equal size as movement', async () => {
    const reserve = new ByteReserve(100, 40)
    const oldest = reserve.enter()
    const other = reserve.enter()
    expect(await reserve.take(100, 0, other, live)).toBe(true)
    const waiting = watch(reserve.take(41, 150, oldest, live))
    const churn = setInterval(() => {
      reserve.give(10)
      void reserve.take(10, 0, other, live)
    }, 15)
    await sleep(450)
    clearInterval(churn)
    expect(waiting.settled()).toBeUndefined()
    expect(await waiting.promise).toBe(false)
  })

  it('serves a waiter as soon as bytes are given back', async () => {
    const reserve = new ByteReserve(100, 10)
    const reader = reserve.enter()
    await reserve.take(100, 0, reader, live)
    const waiting = reserve.take(30, 2_000, reader, live)
    setTimeout(() => { reserve.give(50) }, 60)
    expect(await waiting).toBe(true)
  })

  it('returns false at once when the signal of a waiting read aborts', async () => {
    const reserve = new ByteReserve(10, 0)
    const reader = reserve.enter()
    expect(await reserve.take(10, 0, reader, live)).toBe(true)
    const left = new AbortController()
    const waiting = reserve.take(1, 60_000, reader, left.signal)
    setTimeout(() => { left.abort() }, 30)
    expect(await waiting).toBe(false)
  })

  it('takes nothing once its signal has aborted', async () => {
    const reserve = new ByteReserve(10, 0)
    const reader = reserve.enter()
    const left = new AbortController()
    left.abort()
    expect(await reserve.take(1, 0, reader, left.signal)).toBe(false)
    expect(await reserve.take(10, 0, reader, live)).toBe(true)
  })

  it('never goes below nothing when more is given back than was taken', async () => {
    const reserve = new ByteReserve(10, 0)
    const reader = reserve.enter()
    reserve.give(1_000)
    expect(await reserve.take(10, 0, reader, live)).toBe(true)
    expect(await reserve.take(1, 0, reader, live)).toBe(false)
  })

  it('lets a reader leave twice without touching the readers behind it', async () => {
    const reserve = new ByteReserve(10, 5)
    const first = reserve.enter()
    const second = reserve.enter()
    reserve.leave(first)
    reserve.leave(first)
    expect(await reserve.take(15, 0, second, AbortSignal.timeout(500))).toBe(true)
  })
})
