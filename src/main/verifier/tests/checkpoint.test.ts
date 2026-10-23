import { describe, expect, it } from 'vitest'
import { MAINNET_GENESIS_SECONDS, chooseCheckpoint, parseCheckpoint, parseStoredCheckpoint, slotTimestamp } from '../checkpoint.js'
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

  it('refuses when both are past the limit, naming the newer one and its age', () => {
    expect(chooseCheckpoint(checkpoint(40, 'a'), checkpoint(20, 'b'), NOW, MAX)).toEqual({ ok: false, problem: 'too-old', source: 'this-install', ageSeconds: 20 * DAY })
  })

  it('refuses when the clock is behind every checkpoint', () => {
    expect(chooseCheckpoint({ root: root('a'), timestamp: NOW + DAY }, undefined, NOW, MAX)).toEqual({ ok: false, problem: 'clock-behind' })
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

  it('accepts a checkpoint exactly at the limit', () => {
    expect(chooseCheckpoint(checkpoint(14), undefined, NOW, MAX)).toMatchObject({ ok: true })
  })
})

describe('chooseCheckpoint with a checkpoint fetched at run time', () => {
  const servers = ['https://a.example', 'https://b.example']

  it('names the servers that agreed on the stored checkpoint when it is the newest', () => {
    expect(chooseCheckpoint(checkpoint(30, 'a'), { ...checkpoint(0, 'b'), fetchedFrom: servers }, NOW, MAX)).toEqual({ ok: true, checkpoint: checkpoint(0, 'b'), source: 'fetched', ageSeconds: 0, fetchedFrom: servers })
  })

  it('is the install\'s own once the light client stored a newer one over it', () => {
    expect(chooseCheckpoint(checkpoint(30, 'a'), checkpoint(0, 'c'), NOW, MAX)).toMatchObject({ ok: true, source: 'this-install' })
  })

  it('still names its servers when it has aged past the limit too', () => {
    expect(chooseCheckpoint(checkpoint(40, 'a'), { ...checkpoint(20, 'b'), fetchedFrom: servers }, NOW, MAX)).toEqual({ ok: false, problem: 'too-old', source: 'fetched', ageSeconds: 20 * DAY, fetchedFrom: servers })
  })

  it('leaves the release\'s alone when it is the newer', () => {
    expect(chooseCheckpoint(checkpoint(1, 'a'), { ...checkpoint(5, 'b'), fetchedFrom: servers }, NOW, MAX)).toEqual({ ok: true, checkpoint: checkpoint(1, 'a'), source: 'release', ageSeconds: DAY })
  })
})

describe('chooseCheckpoint with roots the beacon server has no bootstrap for', () => {
  it('never chooses such a root, and takes the next newest checkpoint instead', () => {
    const unserved = new Set([root('a')])
    expect(chooseCheckpoint(checkpoint(1, 'a'), checkpoint(5, 'b'), NOW, MAX, unserved)).toEqual({ ok: true, checkpoint: checkpoint(5, 'b'), source: 'this-install', ageSeconds: 5 * DAY })
  })

  it('names the newest checkpoint as not served when every one is such a root, whatever its age', () => {
    const unserved = new Set([root('a'), root('b')])
    expect(chooseCheckpoint(checkpoint(1, 'a'), checkpoint(5, 'b'), NOW, MAX, unserved)).toEqual({ ok: false, problem: 'not-served', source: 'release', ageSeconds: DAY })
    expect(chooseCheckpoint(checkpoint(1, 'a'), undefined, NOW, MAX, new Set([root('a')]))).toEqual({ ok: false, problem: 'not-served', source: 'release', ageSeconds: DAY })
  })

  it('chooses as before when the set holds only other roots', () => {
    expect(chooseCheckpoint(checkpoint(1, 'a'), undefined, NOW, MAX, new Set([root('z')]))).toMatchObject({ ok: true, source: 'release' })
  })
})

describe('parseStoredCheckpoint', () => {
  it('reads the servers a fetched checkpoint carries', () => {
    expect(parseStoredCheckpoint({ root: root('c'), timestamp: NOW, fetchedFrom: ['https://a.example'] })).toEqual({ root: root('c'), timestamp: NOW, fetchedFrom: ['https://a.example'] })
  })

  it('reads one without servers as the light client\'s own', () => {
    expect(parseStoredCheckpoint({ root: root('c'), timestamp: NOW })).toEqual({ root: root('c'), timestamp: NOW })
  })

  it('drops servers that are not web origins, and refuses a bad checkpoint', () => {
    expect(parseStoredCheckpoint({ root: root('c'), timestamp: NOW, fetchedFrom: ['ftp://a.example'] })).toEqual({ root: root('c'), timestamp: NOW })
    expect(parseStoredCheckpoint({ root: root('c'), timestamp: NOW, fetchedFrom: [] })).toEqual({ root: root('c'), timestamp: NOW })
    expect(parseStoredCheckpoint({ root: root('c'), timestamp: NOW, fetchedFrom: 'https://a.example' })).toEqual({ root: root('c'), timestamp: NOW })
    expect(parseStoredCheckpoint({ root: 'x', timestamp: NOW, fetchedFrom: ['https://a.example'] })).toBeUndefined()
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
