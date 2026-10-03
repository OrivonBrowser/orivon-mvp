import { describe, expect, it, vi } from 'vitest'
import { stampInFront, sweepIdleTabs } from '../idle-sweep.js'
import type { SweepDeps } from '../idle-sweep.js'
import { fakeTabs, page } from './fakes.js'

const MIN = 60_000
const settings = { memorySaver: true, sleepAfter: '15m', energySaver: 'off' }

function setup (over: Partial<SweepDeps> = {}) {
  const fake = fakeTabs({ a: page(), b: page(), c: page() })
  fake.setActive('a')
  const sleep = vi.fn(async (_tabs: unknown, id: string) => { void id; return true })
  const deps: SweepDeps = {
    windows: () => [{ tabs: fake.tabs, window: { isDestroyed: () => false } }],
    settings: () => settings, onBattery: () => false, memoryLow: () => false, now: () => 100 * MIN, sleep, ...over
  }
  return { ...fake, deps, sleep }
}

describe('sweepIdleTabs', () => {
  it('sleeps exactly the tabs idle for the whole wait, one after another', async () => {
    const { deps, records, sleep } = setup()
    const b = records.get('b')
    const c = records.get('c')
    if (b !== undefined) b.lastActiveAt = 100 * MIN - 16 * MIN
    if (c !== undefined) c.lastActiveAt = 100 * MIN - 14 * MIN
    expect(await sweepIdleTabs(deps)).toEqual(['b'])
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[1]).toBe('b')
  })

  it('stamps the tab in front, and one never seen before, instead of sleeping them', async () => {
    const { deps, records, sleep } = setup()
    expect(await sweepIdleTabs(deps)).toEqual([])
    expect(records.get('a')?.lastActiveAt).toBe(100 * MIN)
    expect(records.get('b')?.lastActiveAt).toBe(100 * MIN)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('never offers the tab in front, however long ago it was stamped', async () => {
    const { deps, records, sleep } = setup()
    const a = records.get('a')
    if (a !== undefined) a.lastActiveAt = 0
    await sweepIdleTabs(deps)
    expect(sleep).not.toHaveBeenCalled()
    expect(records.get('a')?.lastActiveAt).toBe(100 * MIN)
  })

  it('skips tabs already asleep, and counts only the tabs that did sleep', async () => {
    const { deps, records, sleep } = setup({ sleep: vi.fn(async (_tabs: unknown, id: string) => id === 'c') })
    for (const id of ['b', 'c']) { const record = records.get(id); if (record !== undefined) record.lastActiveAt = 0 }
    const asleep = records.get('b')
    if (asleep !== undefined) asleep.sleeping = { url: '', title: '', favicon: null, entries: [], index: 0, at: 0 }
    expect(await sweepIdleTabs(deps)).toEqual(['c'])
    expect(sleep).not.toHaveBeenCalledWith(expect.anything(), 'b')
  })

  it('sleeps nothing while the memory saver is off, but still keeps the stamps', async () => {
    const { deps, records, sleep } = setup({ settings: () => ({ ...settings, memorySaver: false }) })
    const b = records.get('b')
    if (b !== undefined) b.lastActiveAt = 0
    expect(await sweepIdleTabs(deps)).toEqual([])
    expect(sleep).not.toHaveBeenCalled()
    expect(records.get('a')?.lastActiveAt).toBe(100 * MIN)
  })

  it('waits five minutes on battery with the energy saver on', async () => {
    const fresh = setup({ settings: () => ({ ...settings, energySaver: 'battery' }), onBattery: () => true })
    const b = fresh.records.get('b')
    if (b !== undefined) b.lastActiveAt = 100 * MIN - 6 * MIN
    expect(await sweepIdleTabs(fresh.deps)).toEqual(['b'])
    const plugged = setup({ settings: () => ({ ...settings, energySaver: 'battery' }), onBattery: () => false })
    const pluggedB = plugged.records.get('b')
    if (pluggedB !== undefined) pluggedB.lastActiveAt = 100 * MIN - 6 * MIN
    expect(await sweepIdleTabs(plugged.deps)).toEqual([])
  })

  it('skips a window that is being destroyed', async () => {
    const { deps, sleep, records } = setup()
    const b = records.get('b')
    if (b !== undefined) b.lastActiveAt = 0
    expect(await sweepIdleTabs({ ...deps, windows: () => [{ tabs: deps.windows()[0]?.tabs as never, window: { isDestroyed: () => true } }] })).toEqual([])
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('sweepIdleTabs under memory pressure', () => {
  function crowded (over: Partial<SweepDeps> = {}) {
    const fake = fakeTabs({ a: page(), b: page(), c: page(), d: page(), e: page(), f: page() })
    fake.setActive('a')
    const sleep = vi.fn(async (_tabs: unknown, id: string) => { void id; return true })
    const deps: SweepDeps = {
      windows: () => [{ tabs: fake.tabs, window: { isDestroyed: () => false } }],
      settings: () => settings, onBattery: () => false, memoryLow: () => true, now: () => 100 * MIN, sleep, ...over
    }
    const leftFront = (id: string, minutesAgo: number): void => {
      const record = fake.records.get(id)
      if (record !== undefined) record.lastActiveAt = 100 * MIN - minutesAgo * MIN
    }
    return { ...fake, deps, sleep, leftFront }
  }

  it('sleeps the least recently used tabs first, three at most, before their wait is over', async () => {
    const { deps, sleep, leftFront } = crowded()
    leftFront('b', 6); leftFront('c', 9); leftFront('d', 7); leftFront('e', 14); leftFront('f', 8)
    expect(await sweepIdleTabs(deps)).toEqual(['e', 'c', 'f'])
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('leaves a tab that left the front less than five minutes ago', async () => {
    const { deps, sleep, leftFront } = crowded()
    leftFront('b', 4); leftFront('c', 5); leftFront('d', 1)
    expect(await sweepIdleTabs(deps)).toEqual(['c'])
    expect(sleep).not.toHaveBeenCalledWith(expect.anything(), 'b')
  })

  it('counts only the tabs that did sleep, so a tab the rules keep awake does not use up a place', async () => {
    const { deps, leftFront } = crowded({ sleep: vi.fn(async (_tabs: unknown, id: string) => id !== 'e') })
    leftFront('b', 6); leftFront('c', 7); leftFront('d', 8); leftFront('e', 20); leftFront('f', 9)
    expect(await sweepIdleTabs(deps)).toEqual(['f', 'd', 'c'])
  })

  it('does not ask again, in the same pass, for a tab whose wait was over and that the rules kept awake', async () => {
    const sleep = vi.fn(async (_tabs: unknown, id: string) => id !== 'e')
    const { deps, leftFront } = crowded({ sleep })
    leftFront('e', 20); leftFront('b', 8)
    await sweepIdleTabs(deps)
    expect(sleep.mock.calls.filter((call) => call[1] === 'e')).toHaveLength(1)
  })

  it('does nothing extra while memory is normal', async () => {
    const { deps, sleep, leftFront } = crowded({ memoryLow: () => false })
    leftFront('b', 10); leftFront('c', 12)
    expect(await sweepIdleTabs(deps)).toEqual([])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does nothing extra while the memory saver is off', async () => {
    const { deps, sleep, leftFront } = crowded({ settings: () => ({ ...settings, memorySaver: false }) })
    leftFront('b', 10)
    expect(await sweepIdleTabs(deps)).toEqual([])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not offer a tab twice when its wait is over too, and does not offer the tab in front or one already asleep', async () => {
    const { deps, sleep, records, leftFront } = crowded()
    leftFront('b', 30); leftFront('c', 40); leftFront('d', 10)
    const asleep = records.get('c')
    if (asleep !== undefined) asleep.sleeping = { url: '', title: '', favicon: null, entries: [], index: 0, at: 0 }
    const a = records.get('a')
    if (a !== undefined) a.lastActiveAt = 0
    expect(await sweepIdleTabs(deps)).toEqual(['b', 'd'])
    expect(sleep.mock.calls.map((call) => call[1])).toEqual(['b', 'd'])
  })

  it('keeps sweeping when the reading of memory throws', async () => {
    const { deps, sleep, leftFront } = crowded({ memoryLow: () => { throw new Error('no reading') } })
    leftFront('b', 10)
    expect(await sweepIdleTabs(deps)).toEqual([])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('reads memory once per pass', async () => {
    const memoryLow = vi.fn(() => true)
    const { deps, leftFront } = crowded({ memoryLow })
    leftFront('b', 8); leftFront('c', 9)
    await sweepIdleTabs(deps)
    expect(memoryLow).toHaveBeenCalledTimes(1)
  })
})

describe('stampInFront', () => {
  it('stamps a tab and the one beside it in a split', () => {
    const { tabs, pair, records } = fakeTabs({ a: page(), b: page(), c: page() })
    pair('a', 'b')
    stampInFront(tabs, 'a', 7)
    expect(records.get('a')?.lastActiveAt).toBe(7)
    expect(records.get('b')?.lastActiveAt).toBe(7)
    expect(records.get('c')?.lastActiveAt).toBeUndefined()
  })
})
