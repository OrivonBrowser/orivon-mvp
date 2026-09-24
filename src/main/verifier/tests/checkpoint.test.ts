import { describe, expect, it } from 'vitest'
import { MAINNET_GENESIS_SECONDS, chooseCheckpoint, parseCheckpoint, slotTimestamp } from '../checkpoint.js'
import type { Checkpoint } from '../checkpoint.js'

const DAY = 86_400
const NOW = 1_790_000_000
const MAX = 14 * DAY
const root = (c: string): string => '0x' + c.repeat(64)

function checkpoint (daysOld: number, c = 'a'): Checkpoint {
  return { root: root(c), timestamp: NOW - daysOld * DAY }
}

describe('chooseCheckpoint', () => {
  it('uses the one this install verified when it is the newer and fresh', () => {
    expect(chooseCheckpoint(checkpoint(30, 'a'), checkpoint(1, 'b'), NOW, MAX)).toEqual({ ok: true, checkpoint: checkpoint(1, 'b'), source: 'this-install', ageSeconds: DAY })
  })

  it("falls back to the release's when the stored one is stale and the release's is fresh", () => {
    expect(chooseCheckpoint(checkpoint(2, 'a'), checkpoint(20, 'b'), NOW, MAX)).toMatchObject({ ok: true, source: 'release', ageSeconds: 2 * DAY })
  })

  it('refuses when both are past the limit, and says what would fix it', () => {
    const choice = chooseCheckpoint(checkpoint(40, 'a'), checkpoint(20, 'b'), NOW, MAX)
    expect(choice.ok).toBe(false)
    expect(choice.ok === false && choice.reason).toMatch(/last verified on this install.*20\.0 days old.*14\.0 days limit.*newer release/)
  })

  it("uses the release's when nothing is stored", () => {
    expect(chooseCheckpoint(checkpoint(3), undefined, NOW, MAX)).toMatchObject({ ok: true, source: 'release' })
  })

  it("prefers the release's on a tie", () => {
    expect(chooseCheckpoint(checkpoint(3, 'a'), checkpoint(3, 'b'), NOW, MAX)).toMatchObject({ ok: true, source: 'release', checkpoint: { root: root('a') } })
  })

  it('ignores a stored checkpoint from the future', () => {
    const future = { root: root('b'), timestamp: NOW + DAY }
    expect(chooseCheckpoint(checkpoint(3, 'a'), future, NOW, MAX)).toMatchObject({ ok: true, source: 'release' })
  })

  it('refuses, naming the clock, when every checkpoint is from the future', () => {
    const choice = chooseCheckpoint({ root: root('a'), timestamp: NOW + DAY }, undefined, NOW, MAX)
    expect(choice).toEqual({ ok: false, reason: expect.stringMatching(/system clock/) })
  })

  it('accepts a checkpoint exactly at the limit', () => {
    expect(chooseCheckpoint(checkpoint(14), undefined, NOW, MAX)).toMatchObject({ ok: true })
  })
})

describe('parseCheckpoint', () => {
  it('accepts a lowercase 32-byte root and a timestamp after genesis', () => {
    expect(parseCheckpoint({ root: root('c'), timestamp: NOW })).toEqual({ root: root('c'), timestamp: NOW })
  })

  it('refuses anything else', () => {
    for (const bad of [null, 'x', {}, { root: root('c') }, { root: 'c'.repeat(64), timestamp: NOW }, { root: '0x' + 'C'.repeat(64), timestamp: NOW }, { root: root('c'), timestamp: MAINNET_GENESIS_SECONDS - 1 }, { root: root('c'), timestamp: 1.5 + NOW }]) {
      expect(parseCheckpoint(bad)).toBeUndefined()
    }
  })
})

describe('slotTimestamp', () => {
  it('is genesis plus twelve seconds a slot', () => {
    expect(slotTimestamp(0)).toBe(MAINNET_GENESIS_SECONDS)
    expect(slotTimestamp(15_285_536)).toBe(MAINNET_GENESIS_SECONDS + 15_285_536 * 12)
  })
})
