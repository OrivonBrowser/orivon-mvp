import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env, fakeTabs, page } from './fakes.js'

const blank = { webContents: { id: 'blank' } }
const { makeTabView, wireView, closeParkedViews } = vi.hoisted(() => ({
  makeTabView: vi.fn(),
  wireView: vi.fn(),
  closeParkedViews: vi.fn()
}))
vi.mock('../../shell/tab-view.js', () => ({ makeTabView, wireView }))
vi.mock('../../shell/tab-parking.js', () => ({ closeParkedViews }))
vi.mock('../../shell/tab-partition.js', () => ({ appTabViews: new WeakSet() }))
vi.mock('../../overlays/tab-slots.js', () => ({ hasAsk: () => false }))

const { reloadOrWake, sleepTab, sleepTabWhy, wakeTab } = await import('../sleep-tab.js')
const { snapshotOf } = await import('../../session-restore/tab-snapshot.js')

beforeEach(() => {
  makeTabView.mockReset().mockReturnValue(blank)
  wireView.mockReset()
  closeParkedViews.mockReset()
})

function setup (over: Parameters<typeof page>[1] = {}) {
  const a = page('https://a.example/page', over)
  const b = page('https://b.example/', { entries: [{ url: 'https://b.example/', title: 'B' }], active: 0 })
  const fake = fakeTabs({ a, b })
  fake.setActive('b')
  return { a, b, ...fake }
}

describe('sleepTab', () => {
  it('swaps in a blank view, keeps the address, title, icon and history with its page state, and closes the old page', async () => {
    const { a, tabs, records, changed, viewReplaced } = setup()
    const record = records.get('a')
    const oldView = record?.view

    expect(await sleepTab(tabs, 'a', env())).toBe(true)

    expect(record?.view).toBe(blank)
    expect(record?.sleeping).toEqual({
      url: 'https://a.example/page', title: 'A page', favicon: 'data:image/png;base64,AAAA', at: 5000, index: 1,
      entries: [{ url: 'https://a.example/first', title: 'First', pageState: 'secret' }, { url: 'https://a.example/page', title: 'A page', pageState: 'typed' }]
    })
    expect(makeTabView).toHaveBeenCalledWith('/preload.js', undefined)
    expect(wireView).toHaveBeenCalledWith('a', record)
    expect(viewReplaced).toHaveBeenCalledWith((oldView as unknown as { webContents: unknown }).webContents, blank.webContents, undefined)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(closeParkedViews).toHaveBeenCalledWith(record)
    expect(changed).toHaveBeenCalled()
  })

  it('wires the new view before the old page is closed, so the old page\'s handlers find the record elsewhere', async () => {
    const { a, tabs } = setup()
    const order: string[] = []
    wireView.mockImplementation(() => { order.push('wire') })
    a.close.mockImplementation(() => { order.push('close') })
    await sleepTab(tabs, 'a', env())
    expect(order).toEqual(['wire', 'close'])
  })

  it('leaves a tab alone when a rule keeps it awake, and says which', async () => {
    const cases: Array<[string, () => ReturnType<typeof setup>, string]> = [
      ['sound', () => setup({ audible: true }), 'sound'],
      ['capture', () => setup({ captured: true }), 'media'],
      ['devtools', () => setup({ devtools: true }), 'devtools'],
      ['loading', () => setup({ loading: true }), 'loading'],
      ['crashed', () => setup({ crashed: true }), 'crashed'],
      ['unrestorable address', () => setup({ url: 'file:///x.html' }), 'address'],
      ['a blank page', () => setup({ url: 'about:blank' }), 'new-tab']
    ]
    for (const [name, build, why] of cases) {
      const { tabs, records } = build()
      const verdict = await sleepTabWhy(tabs, 'a', env())
      expect(verdict, name).toEqual({ ok: false, why })
      expect(records.get('a')?.sleeping ?? null, name).toBeNull()
    }
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('refuses the tab in front, its split partner, a pinned tab, a partitioned tab and the new-tab page', async () => {
    const front = setup()
    front.setActive('a')
    expect(await sleepTabWhy(front.tabs, 'a', env())).toEqual({ ok: false, why: 'active' })

    const split = setup()
    split.pair('b', 'a')
    expect(await sleepTabWhy(split.tabs, 'a', env())).toEqual({ ok: false, why: 'split' })

    const pinned = setup()
    const pinnedRecord = pinned.records.get('a')
    if (pinnedRecord !== undefined) pinnedRecord.pinned = true
    expect(await sleepTabWhy(pinned.tabs, 'a', env())).toEqual({ ok: false, why: 'pinned' })

    const app = setup()
    const appRecord = app.records.get('a')
    if (appRecord !== undefined) appRecord.partition = 'persist:app'
    expect(await sleepTabWhy(app.tabs, 'a', env())).toEqual({ ok: false, why: 'partition' })

    const dashboard = setup()
    const dashboardRecord = dashboard.records.get('a')
    if (dashboardRecord !== undefined) dashboardRecord.isDashboardTab = true
    expect(await sleepTabWhy(dashboard.tabs, 'a', env())).toEqual({ ok: false, why: 'new-tab' })
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('refuses a tab with a prompt waiting, media in use, a kept site, an internal page or unsaved input', async () => {
    const one = async (e: ReturnType<typeof env>, mutate?: (record: NonNullable<ReturnType<ReturnType<typeof setup>['records']['get']>>) => void) => {
      const { tabs, records } = setup()
      const record = records.get('a')
      if (record !== undefined) mutate?.(record)
      return await sleepTabWhy(tabs, 'a', e)
    }
    expect(await one(env({ hasAsk: () => true }))).toEqual({ ok: false, why: 'ask' })
    expect(await one(env({ mediaInUse: () => true }))).toEqual({ ok: false, why: 'media' })
    expect(await one(env({ keepAwakeList: () => 'example\na.example' }))).toEqual({ ok: false, why: 'kept' })
    expect(await one(env(), (record) => { record.internalPage = 'settings' })).toEqual({ ok: false, why: 'internal' })
    expect(await one(env({ unsaved: async () => true }))).toEqual({ ok: false, why: 'unsaved' })
  })

  it('asks the page about unsaved input only once nothing else keeps the tab awake', async () => {
    const unsaved = vi.fn(async () => false)
    expect(await sleepTabWhy(setup({ audible: true }).tabs, 'a', env({ unsaved }))).toEqual({ ok: false, why: 'sound' })
    expect(unsaved).not.toHaveBeenCalled()
    expect((await sleepTabWhy(setup().tabs, 'a', env({ unsaved }))).ok).toBe(true)
    expect(unsaved).toHaveBeenCalledTimes(1)
  })

  it('checks the rules again after the page answers: a tab that came to the front meanwhile stays', async () => {
    const { tabs, records, setActive } = setup()
    const verdict = await sleepTabWhy(tabs, 'a', env({ unsaved: async () => { setActive('a'); return false } }))
    expect(verdict).toEqual({ ok: false, why: 'active' })
    expect(records.get('a')?.sleeping ?? null).toBeNull()
  })

  it('does nothing for a tab that is gone or already asleep', async () => {
    const { tabs, records } = setup()
    expect(await sleepTabWhy(tabs, 'nope', env())).toEqual({ ok: false, why: 'gone' })
    expect(await sleepTab(tabs, 'a', env())).toBe(true)
    makeTabView.mockClear()
    const record = records.get('a')
    expect(record?.sleeping).not.toBeNull()
    expect(await sleepTabWhy(tabs, 'a', env())).toEqual({ ok: false, why: 'asleep' })
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('keeps a tab whose history cannot be read awake', async () => {
    const { tabs, records } = setup({ entries: [], active: -1 })
    expect(await sleepTabWhy(tabs, 'a', env())).toEqual({ ok: false, why: 'address' })
    expect(records.get('a')?.sleeping ?? null).toBeNull()
    expect(makeTabView).not.toHaveBeenCalled()
  })

  it('does not sleep a tab of a window that is closing', async () => {
    const { tabs, records } = setup()
    const record = records.get('a')
    if (record !== undefined) record.host = { ...record.host, isClosing: () => true }
    expect((await sleepTabWhy(tabs, 'a', env())).ok).toBe(false)
    expect(makeTabView).not.toHaveBeenCalled()
  })
})

describe('reloadOrWake', () => {
  it('wakes a sleeping tab, whose view has no page to reload, and reloads one that is awake', async () => {
    const { tabs, records } = setup()
    const reload = vi.fn()
    ;(tabs as unknown as { reload: typeof reload }).reload = reload
    await sleepTab(tabs, 'a', env())
    const wc = { isDestroyed: () => false, loadURL: vi.fn(), navigationHistory: { restore: vi.fn(async () => {}) } }
    const record = records.get('a')
    if (record !== undefined) record.view = { webContents: wc } as never

    reloadOrWake(tabs, 'a')
    expect(wc.navigationHistory.restore).toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    reloadOrWake(tabs, 'b')
    expect(reload).toHaveBeenCalledWith('b')
  })
})

describe('wakeTab', () => {
  it('gives the history back to the view the tab has now and clears the sleep', async () => {
    const { tabs, records, changed } = setup()
    await sleepTab(tabs, 'a', env())
    const kept = records.get('a')?.sleeping
    const wc = { ...blank.webContents, isDestroyed: () => false, loadURL: vi.fn(), navigationHistory: { restore: vi.fn(async () => {}) } }
    const record = records.get('a')
    if (record !== undefined) record.view = { webContents: wc } as never
    changed.mockClear()

    wakeTab(tabs, 'a')

    expect(wc.navigationHistory.restore).toHaveBeenCalledWith({ entries: kept?.entries, index: 1 })
    expect(record?.sleeping).toBeNull()
    expect(changed).toHaveBeenCalled()
  })

  it('keeps what the tab was for the session file until the page commits', async () => {
    const { tabs, records } = setup()
    await sleepTab(tabs, 'a', env())
    const wc = { isDestroyed: () => false, getURL: () => '', getTitle: () => '', loadURL: vi.fn(), navigationHistory: { restore: vi.fn(async () => {}) } }
    const record = records.get('a')
    if (record !== undefined) record.view = { webContents: wc } as never

    wakeTab(tabs, 'a')

    expect(record === undefined ? null : snapshotOf(record, wc as never)).toEqual({
      url: 'https://a.example/page', title: 'A page', pinned: false,
      entries: [{ url: 'https://a.example/first', title: 'First' }, { url: 'https://a.example/page', title: 'A page' }], index: 1
    })
  })

  it('loads the address when a restore that started is refused and the view is still blank', async () => {
    const { tabs, records } = setup()
    await sleepTab(tabs, 'a', env())
    const wc = { isDestroyed: () => false, getURL: () => '', loadURL: vi.fn(async () => {}), navigationHistory: { restore: vi.fn(async () => { throw new Error('ERR_ABORTED') }) } }
    const record = records.get('a')
    if (record !== undefined) record.view = { webContents: wc } as never
    wakeTab(tabs, 'a')
    await vi.waitFor(() => { expect(wc.loadURL).toHaveBeenCalledWith('https://a.example/page') })

    const committed = { isDestroyed: () => false, getURL: () => 'https://a.example/page', loadURL: vi.fn(async () => {}), navigationHistory: { restore: vi.fn(async () => { throw new Error('ERR_ABORTED') }) } }
    const second = setup()
    await sleepTab(second.tabs, 'a', env())
    const other = second.records.get('a')
    if (other !== undefined) other.view = { webContents: committed } as never
    wakeTab(second.tabs, 'a')
    await Promise.resolve()
    await Promise.resolve()
    expect(committed.loadURL).not.toHaveBeenCalled()
  })

  it('loads the address when the history cannot be restored', async () => {
    const { tabs, records } = setup()
    await sleepTab(tabs, 'a', env())
    const wc = { isDestroyed: () => false, loadURL: vi.fn(async () => {}), navigationHistory: { restore: () => { throw new Error('refused') } } }
    const record = records.get('a')
    if (record !== undefined) record.view = { webContents: wc } as never
    wakeTab(tabs, 'a')
    expect(wc.loadURL).toHaveBeenCalledWith('https://a.example/page')
  })

  it('leaves an awake tab alone', () => {
    const { tabs, a, changed } = setup()
    wakeTab(tabs, 'a')
    expect(a.restore).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })
})
