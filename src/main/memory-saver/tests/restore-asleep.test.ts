import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env, fakeTabs, page } from './fakes.js'

const blank = { webContents: { id: 'blank' } }
const { makeTabView, wireView } = vi.hoisted(() => ({ makeTabView: vi.fn(), wireView: vi.fn() }))
vi.mock('../../shell/tab-view.js', () => ({ makeTabView, wireView }))
vi.mock('../../shell/tab-parking.js', () => ({ closeParkedViews: vi.fn() }))
vi.mock('../../shell/tab-partition.js', () => ({ appTabViews: new WeakSet() }))
vi.mock('../../overlays/tab-slots.js', () => ({ hasAsk: () => false }))

const { restoreAsleep, restoreAsleepTabs } = await import('../restore-asleep.js')

beforeEach(() => { makeTabView.mockReset().mockReturnValue(blank); wireView.mockReset() })

// A tab just made from a snapshot has no address yet: its page is still loading.
function setup (saver: unknown = true, icons: Record<string, string> = {}) {
  const fake = fakeTabs({ a: page('', { loading: true }), b: page('https://b.example/') })
  fake.setActive('b')
  const record = fake.records.get('a')
  if (record !== undefined) record.host = { ...record.host, services: { settings: { get: () => saver }, history: { faviconsFor: () => icons } } as never }
  return fake
}

const SNAPSHOT = { url: 'https://a.example/page', title: 'A page', pinned: false }

describe('restoreAsleep', () => {
  it('puts a restored tab to sleep with its address, title and history, and no page state', () => {
    const { tabs, records } = setup()
    const snapshot = { ...SNAPSHOT, index: 1, entries: [{ url: 'https://a.example/first', title: 'First' }, { url: SNAPSHOT.url, title: 'A page' }] }
    expect(restoreAsleep(tabs, 'a', snapshot, env())).toBe(true)
    expect(records.get('a')?.sleeping).toEqual({ url: SNAPSHOT.url, title: 'A page', favicon: null, at: 5000, index: 1, entries: snapshot.entries })
    expect(records.get('a')?.view).toBe(blank)
  })

  it('gives a tab asleep from the start the icon history keeps for its site, and none when there is none', () => {
    const known = setup(true, { 'a.example': 'data:image/png;base64,AAAA' })
    restoreAsleep(known.tabs, 'a', SNAPSHOT, env())
    expect(known.records.get('a')?.sleeping?.favicon).toBe('data:image/png;base64,AAAA')
    const none = setup()
    restoreAsleep(none.tabs, 'a', SNAPSHOT, env())
    expect(none.records.get('a')?.sleeping?.favicon).toBeNull()
  })

  it('keeps a single address as a one-entry history', () => {
    const { tabs, records } = setup()
    restoreAsleep(tabs, 'a', SNAPSHOT, env())
    expect(records.get('a')?.sleeping).toMatchObject({ index: 0, entries: [{ url: SNAPSHOT.url, title: 'A page' }] })
  })

  it('leaves the tab awake when the memory saver is off', () => {
    const { tabs, records } = setup(false)
    expect(restoreAsleep(tabs, 'a', SNAPSHOT, env())).toBe(false)
    expect(records.get('a')?.sleeping ?? null).toBeNull()
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('leaves the tab in front, a pinned tab, a kept site and a shell page awake', () => {
    const front = setup()
    front.setActive('a')
    expect(restoreAsleep(front.tabs, 'a', SNAPSHOT, env())).toBe(false)

    const pinned = setup()
    const pinnedRecord = pinned.records.get('a')
    if (pinnedRecord !== undefined) pinnedRecord.pinned = true
    expect(restoreAsleep(pinned.tabs, 'a', SNAPSHOT, env())).toBe(false)

    expect(restoreAsleep(setup().tabs, 'a', SNAPSHOT, env({ keepAwakeList: () => 'a.example' }))).toBe(false)
    expect(restoreAsleep(setup().tabs, 'a', { ...SNAPSHOT, internal: { page: 'settings', path: '/' } }, env())).toBe(false)
    expect(restoreAsleep(setup().tabs, 'a', { ...SNAPSHOT, url: 'file:///x' }, env())).toBe(false)
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('does nothing for a tab that is gone or already asleep', () => {
    const { tabs } = setup()
    expect(restoreAsleep(tabs, 'nope', SNAPSHOT, env())).toBe(false)
    expect(restoreAsleep(tabs, 'a', SNAPSHOT, env())).toBe(true)
    expect(restoreAsleep(tabs, 'a', SNAPSHOT, env())).toBe(false)
  })
})

describe('restoreAsleepTabs', () => {
  it('puts each opened tab to sleep from its own snapshot and skips a tab that did not open', () => {
    const { tabs, records } = setup()
    restoreAsleepTabs(tabs, [SNAPSHOT, { ...SNAPSHOT, url: 'https://gone.example/' }, { ...SNAPSHOT, url: 'https://b.example/' }], ['a', '', 'b'], env())
    expect(records.get('a')?.sleeping?.url).toBe(SNAPSHOT.url)
    expect(records.get('b')?.sleeping ?? null).toBeNull()
  })
})
