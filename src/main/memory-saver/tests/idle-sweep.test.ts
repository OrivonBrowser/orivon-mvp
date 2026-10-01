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
    settings: () => settings, onBattery: () => false, now: () => 100 * MIN, sleep, ...over
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
