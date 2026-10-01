import { describe, expect, it } from 'vitest'
import { groupsFor } from '../../tab-groups/groups-model.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { TabRecord } from '../../shell/tab-types.js'
import { fillTabs } from '../restore.js'
import { snapshotWindow } from '../session-recorder.js'
import { cleanWindow, parseSession } from '../session-types.js'
import type { SavedWindow } from '../session-types.js'
import { fakeTabs } from './tabs-fake.js'

const tab = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ url: `https://t${String(n)}.example/`, title: `T${String(n)}`, pinned: false, ...extra })
const file = (tabs: unknown[], groups?: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, clean: true, windows: [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs, ...(groups === undefined ? {} : { groups }), ...extra }] })

describe('reading the groups of a saved window', () => {
  it('keeps a group with its name, colour and collapsed state, and the tabs that point at it', () => {
    const parsed = parseSession(file([tab(1), tab(2, { group: 0 }), tab(3, { group: 0 })], [{ title: 'Work', color: 'green', collapsed: true }]))
    expect(parsed?.windows[0]?.groups).toEqual([{ title: 'Work', color: 'green', collapsed: true }])
    expect(parsed?.windows[0]?.tabs.map((entry) => entry.group)).toEqual([undefined, 0, 0])
  })

  it('writes a window without groups as it always was', () => {
    const window = cleanWindow({ bounds: {}, tabs: [tab(1)] })
    expect(window).not.toHaveProperty('groups')
    expect(window?.tabs[0]).not.toHaveProperty('group')
  })

  it('drops a tab\'s group when its index is bad or points at nothing', () => {
    const window = cleanWindow({ bounds: {}, tabs: [tab(1, { group: 5 }), tab(2, { group: -1 }), tab(3, { group: 'x' }), tab(4, { group: 1.5 }), tab(5, { group: 0 })], groups: [{ title: 'A', color: 'red', collapsed: false }] })
    expect(window?.tabs.map((entry) => entry.group)).toEqual([undefined, undefined, undefined, undefined, 0])
  })

  it('refuses a colour outside the list, a long title, and a pinned tab in a group', () => {
    const window = cleanWindow({
      bounds: {},
      tabs: [tab(1, { group: 0 }), tab(2, { group: 1 }), tab(3, { group: 1, pinned: true })],
      groups: [{ title: 'Bad', color: 'chartreuse', collapsed: false }, { title: 'y'.repeat(100), color: 'blue', collapsed: 'yes' }]
    })
    expect(window?.tabs.map((entry) => [entry.url.slice(8, 10), entry.group])).toEqual([['t3', undefined], ['t1', undefined], ['t2', 1]])
    expect(window?.groups?.[1]).toEqual({ title: 'y'.repeat(40), color: 'blue', collapsed: false })
  })

  it('keeps at most 50 groups', () => {
    const groups = Array.from({ length: 80 }, () => ({ title: '', color: 'gray', collapsed: false }))
    const window = cleanWindow({ bounds: {}, tabs: [tab(1, { group: 49 }), tab(2, { group: 50 })], groups })
    expect(window?.groups).toHaveLength(50)
    expect(window?.tabs.map((entry) => entry.group)).toEqual([49, undefined])
  })

  it('has no groups at all when no tab points at one', () => {
    expect(cleanWindow({ bounds: {}, tabs: [tab(1)], groups: [{ title: 'A', color: 'red', collapsed: false }] })).not.toHaveProperty('groups')
  })
})

describe('writing the groups of a window', () => {
  it('numbers the groups by first appearance and saves each one once', () => {
    const records = new Map<string, Partial<TabRecord>>()
    const order = ['1', '2', '3', '4']
    const tabs = { getState: () => ({ activeTabId: '1' }), ids: () => order, record: (id: string) => records.get(id) } as unknown as ShellWindow['tabs']
    const groups = groupsFor(tabs)
    const first = groups.create('red', 'First')
    const second = groups.create('blue', '')
    groups.update(second, { collapsed: true })
    const view = { webContents: {} } as never
    records.set('1', { view, groupId: second })
    records.set('2', { view, groupId: first })
    records.set('3', { view, groupId: second })
    records.set('4', { view, groupId: first, pinned: true })
    const window = { isDestroyed: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), isMaximized: () => false }
    const live = snapshotWindow({ window, tabs } as unknown as ShellWindow, ((record: TabRecord) => ({ url: 'https://a.example/', title: '', pinned: record.pinned === true })) as never)
    expect(live?.groups).toEqual([{ title: '', color: 'blue', collapsed: true }, { title: 'First', color: 'red', collapsed: false }])
    expect(live?.tabs.map((entry) => entry.group)).toEqual([0, 1, 0, undefined])
  })
})

describe('bringing the groups back', () => {
  const withSplits = (fake: ReturnType<typeof fakeTabs>): ReturnType<typeof fakeTabs> => {
    Object.assign(fake.tabs, { splits: { groups: { pairs: () => [], partnerOf: () => null } } })
    return fake
  }
  const saved = (tabs: Array<Record<string, unknown>>, groups: SavedWindow['groups'], active = 0): SavedWindow =>
    ({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active, tabs: tabs as never, ...(groups === undefined ? {} : { groups }) })

  it('makes each group again with its tabs, name, colour and collapsed state', () => {
    const fake = withSplits(fakeTabs())
    fillTabs(saved([tab(1), tab(2, { group: 0 }), tab(3, { group: 0 }), tab(4)], [{ title: 'Work', color: 'green', collapsed: true }], 0))(fake.tabs)
    const [group] = groupsFor(fake.tabs).list()
    expect(group).toMatchObject({ title: 'Work', color: 'green', collapsed: true })
    expect(fake.order.map((id) => fake.records.get(id)?.groupId ?? null)).toEqual([null, group?.id, group?.id, null])
  })

  it('keeps open a group that holds the tab that was in front', () => {
    const fake = withSplits(fakeTabs())
    fillTabs(saved([tab(1), tab(2, { group: 0 })], [{ title: 'W', color: 'red', collapsed: true }], 1))(fake.tabs)
    expect(groupsFor(fake.tabs).list()[0]?.collapsed).toBe(false)
  })

  it('gathers a group the file scattered', () => {
    const fake = withSplits(fakeTabs())
    fillTabs(saved([tab(1, { group: 0 }), tab(2), tab(3, { group: 0 })], [{ title: 'W', color: 'red', collapsed: false }]))(fake.tabs)
    const [group] = groupsFor(fake.tabs).list()
    expect(fake.order.map((id) => fake.records.get(id)?.groupId ?? null)).toEqual([group?.id, group?.id, null])
  })

  it('makes no group for a window that has none', () => {
    const fake = fakeTabs()
    fillTabs(saved([tab(1), tab(2)], undefined))(fake.tabs)
    expect(groupsFor(fake.tabs).list()).toEqual([])
  })
})

describe('the tab that is in front when it is not kept', () => {
  it('puts a neighbour in front that a collapsed group does not hide', () => {
    const records = new Map<string, Partial<TabRecord>>()
    const order = ['new', 'a', 'b', 'c']
    const tabs = { getState: () => ({ activeTabId: 'new' }), ids: () => order, record: (id: string) => records.get(id) } as unknown as ShellWindow['tabs']
    const group = groupsFor(tabs).create('blue', 'W')
    groupsFor(tabs).update(group, { collapsed: true })
    const view = { webContents: { id: 0 } } as never
    for (const id of order) records.set(id, { view, groupId: id === 'a' || id === 'b' ? group : null })
    const window = { isDestroyed: () => false, getNormalBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), isMaximized: () => false }
    let call = 0
    const saved = snapshotWindow({ window, tabs } as unknown as ShellWindow, ((_record: TabRecord) => (call++ === 0 ? null : { url: `https://t${String(call)}.example/`, title: '', pinned: false })) as never)
    expect(saved?.tabs).toHaveLength(3)
    expect(saved?.active).toBe(2)
  })
})
