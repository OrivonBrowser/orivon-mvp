import { describe, expect, it, vi } from 'vitest'
import { TabLifecycle } from '../../shell/tab-lifecycle.js'
import { fakeTabs, page } from './fakes.js'

const wakeTab = vi.hoisted(() => vi.fn())
vi.mock('../sleep-tab.js', () => ({ wakeTab }))

const { startMemorySaver, SWEEP_EVERY_MS } = await import('../start-memory-saver.js')

function setup (settings = { memorySaver: true, sleepAfter: '15m', energySaver: 'off' }) {
  const fake = fakeTabs({ a: page(), b: page() })
  const lifecycle = new TabLifecycle()
  let clock = 1000
  let tick: (() => void) | undefined
  let changed: (() => void) | undefined
  const sleep = vi.fn(async () => true)
  const stopTimer = vi.fn()
  const saver = startMemorySaver({
    lifecycle,
    windows: () => [{ tabs: fake.tabs, window: { isDestroyed: () => false } }],
    findTab: (contents) => {
      const found = [...fake.records].find(([, record]) => record.view.webContents === (contents as unknown))
      return found === undefined ? null : { window: { tabs: fake.tabs, window: { isDestroyed: () => false } }, tabId: found[0] }
    },
    settings: () => settings, onBattery: () => false, memoryLow: () => false, now: () => clock, sleep,
    onSettingChange: (listener) => { changed = listener; return () => {} },
    every: (run, ms) => { expect(ms).toBe(SWEEP_EVERY_MS); tick = run; return { stop: stopTimer } }
  })
  const wcOf = (id: string): never => fake.records.get(id)?.view.webContents as never
  return { ...fake, lifecycle, saver, sleep, wcOf, stopTimer, advance: (ms: number) => { clock += ms }, tick: () => { tick?.() }, change: () => { changed?.() } }
}

describe('startMemorySaver', () => {
  it('wakes a tab when it comes to the front, and the tab beside it in a split', () => {
    wakeTab.mockClear()
    const { lifecycle, wcOf, pair, tabs } = setup()
    pair('a', 'b')
    lifecycle.tabActivated(wcOf('a'))
    expect(wakeTab.mock.calls).toEqual([[tabs, 'a'], [tabs, 'b']])
  })

  it('stamps the tab that left the front as last used when the next one arrives', () => {
    const { lifecycle, wcOf, records, advance } = setup()
    lifecycle.tabActivated(wcOf('a'))
    advance(5000)
    lifecycle.tabActivated(wcOf('b'))
    expect(records.get('a')?.lastActiveAt).toBe(6000)
    expect(records.get('b')?.lastActiveAt).toBe(6000)
  })

  it('ignores a tab it cannot find', () => {
    wakeTab.mockClear()
    const { lifecycle } = setup()
    lifecycle.tabActivated({} as never)
    expect(wakeTab).not.toHaveBeenCalled()
  })

  it('sweeps when the timer fires, and once when a setting changes', async () => {
    const { tick, change, sleep, records, advance, saver } = setup()
    const b = records.get('b')
    if (b !== undefined) b.lastActiveAt = 0
    advance(20 * 60_000)
    tick()
    await saver.sweep()
    expect(sleep).toHaveBeenCalledTimes(1)
    change()
    await saver.sweep()
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('runs one pass at a time: a second call while one is going is that pass', async () => {
    const { saver, records, sleep, advance } = setup()
    const b = records.get('b')
    if (b !== undefined) b.lastActiveAt = 0
    advance(20 * 60_000)
    const first = saver.sweep()
    const second = saver.sweep()
    expect(await first).toEqual(await second)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('stops the timer and the listeners', () => {
    wakeTab.mockClear()
    const { saver, lifecycle, wcOf, stopTimer } = setup()
    saver.stop()
    expect(stopTimer).toHaveBeenCalled()
    lifecycle.tabActivated(wcOf('a'))
    expect(wakeTab).not.toHaveBeenCalled()
  })
})
