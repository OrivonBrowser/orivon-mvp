import { describe, expect, it } from 'vitest'
import { ByteReserve } from '../byte-reserve.js'

describe('ByteReserve', () => {
  it('holds bytes up to its total and refuses the rest once the wait is over', async () => {
    const reserve = new ByteReserve(100)
    expect(await reserve.take(60, 0)).toBe(true)
    expect(await reserve.take(40, 0)).toBe(true)
    expect(await reserve.take(1, 0)).toBe(false)
  })

  it('serves a waiter as soon as bytes are given back', async () => {
    const reserve = new ByteReserve(100)
    await reserve.take(100, 0)
    const waiting = reserve.take(30, 2_000)
    setTimeout(() => { reserve.give(50) }, 60)
    expect(await waiting).toBe(true)
  })

  it('never goes below nothing when more is given back than was taken', async () => {
    const reserve = new ByteReserve(10)
    reserve.give(1_000)
    expect(await reserve.take(10, 0)).toBe(true)
    expect(await reserve.take(1, 0)).toBe(false)
  })
})
