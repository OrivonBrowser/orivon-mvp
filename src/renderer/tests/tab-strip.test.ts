import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { TabGroupState } from '../../main/shell/tab-extra-types.js'
import type { ChromeContext, TabDecorator } from '../chrome/context.js'
import type { StripFinisher } from '../chrome/tab-strip.js'
import type { FakeNode as FakeNodeType } from './fake-dom.js'
import { fakeDocument } from './fake-dom.js'

const drag = vi.hoisted(() => ({ held: false, hosts: [] as Array<{ id: string, host: Record<string, (...args: never[]) => unknown> }> }))
const icons = vi.hoisted(() => ({ favicons: [] as string[] }))

vi.mock('../icons.js', async () => {
  const { FakeNode } = await import('./fake-dom.js')
  return {
    closeIcon: () => new FakeNode('svg'),
    faviconElement: (dataUrl: string | null) => {
      const img = new FakeNode(dataUrl === null ? 'svg' : 'img')
      img.attrs.set('src', dataUrl ?? '')
      icons.favicons.push(dataUrl ?? '')
      return img
    }
  }
})
vi.mock('../tab-drag.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../tab-drag.js')>(),
  isDraggingTab: () => drag.held,
  makeTabDraggable: (_el: unknown, id: string, host: Record<string, (...args: never[]) => unknown>) => { drag.hosts.push({ id, host }) }
}))
vi.mock('../pages/shared/icons.js', async () => {
  const { FakeNode } = await import('./fake-dom.js')
  return { speakerIcon: () => new FakeNode('svg'), speakerOffIcon: () => new FakeNode('svg'), warningIcon: () => new FakeNode('svg'), eyeIcon: () => new FakeNode('svg') }
})
vi.mock('../pages/shared/site-kind-icons.js', async () => {
  const { FakeNode } = await import('./fake-dom.js')
  return { SITE_KIND_ICONS: { screenShare: () => new FakeNode('svg') } }
})

const { createTabStrip } = await import('../chrome/tab-strip.js')
const { decorateTabBadges } = await import('../chrome/tab-badges.js')
const { decorateTabCrashed } = await import('../chrome/tab-crashed.js')
const { decorateTabGroup, placeGroupChips } = await import('../chrome/tab-groups.js')

const tab = (id: string, over: Partial<TabState> = {}): TabState => ({
  id, url: `https://${id}.example/`, displayUrl: `https://${id}.example/`, title: id, canGoBack: false, canGoForward: false, loading: false,
  favicon: `data:image/png;base64,${id}`, isNewTab: false, splitWith: null, isInternal: false, pinned: false, muted: false, audible: false,
  crashed: null, connection: 'none', ...over
})
const state = (tabs: TabState[], activeTabId: string | null = tabs[0]?.id ?? null, groups: ShellState['groups'] = []): ShellState =>
  ({ tabs, activeTabId, groups }) as unknown as ShellState

function setup (decorators: readonly TabDecorator[] = [], finishers: readonly StripFinisher[] = []) {
  const dom = fakeDocument()
  vi.stubGlobal('document', dom.document)
  let current: ShellState | null = null
  const shell = { activateTab: vi.fn(), closeTab: vi.fn(), showTabMenu: vi.fn(), moveTab: vi.fn(), newTab: vi.fn(), act: vi.fn() }
  const ctx = { shell, state: () => current, anchorFor: () => ({ x: 0, y: 0, width: 0, height: 0 }) } as unknown as ChromeContext
  const module = createTabStrip(decorators, finishers)
  module.init(ctx)
  const push = (next: ShellState): void => {
    current = next
    module.render?.(next, ctx)
  }
  const tabEl = (id: string): FakeNodeType => {
    const found = [...dom.row.querySelectorAll('.tab')].find((el) => el.dataset['id'] === id)
    if (found === undefined) throw new Error(`no element for tab ${id}`)
    return found
  }
  const order = (): string[] => dom.row.querySelectorAll('.tab').map((el) => el.dataset['id'] ?? '')
  return { ...dom, shell, ctx, push, tabEl, order }
}

beforeEach(() => {
  drag.held = false
  drag.hosts.length = 0
  icons.favicons.length = 0
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the tab strip updating in place', () => {
  it('keeps every element when only a title changed, and changes that title alone', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b'), tab('c')]))
    const before = ['a', 'b', 'c'].map((id) => strip.tabEl(id))
    const created = strip.created.length
    const insertions = before.map((el) => el.insertions)

    strip.push(state([tab('a'), tab('b', { title: 'Renamed' }), tab('c')]))

    expect(['a', 'b', 'c'].map((id) => strip.tabEl(id))).toEqual(before)
    expect(strip.tabEl('a')).toBe(before[0])
    expect(strip.tabEl('b')).toBe(before[1])
    expect(strip.created.length).toBe(created)
    expect(before.map((el) => el.insertions)).toEqual(insertions)
    expect(strip.tabEl('b').querySelector('.title')?.textContent).toBe('Renamed')
    expect(strip.tabEl('b').querySelector('.close')?.getAttribute('aria-label')).toBe('Close Renamed')
    expect(strip.tabEl('a').querySelector('.title')?.textContent).toBe('a')
  })

  it('shows a tab with no title as "New tab"', () => {
    const strip = setup()
    strip.push(state([tab('a', { title: '' })]))
    expect(strip.tabEl('a').querySelector('.title')?.textContent).toBe('New tab')
  })

  it('keeps the icon image while the icon is unchanged, and draws a new one when it changed', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b')]))
    const img = strip.tabEl('a').querySelector('.fav')?.children[0]

    strip.push(state([tab('a', { title: 'Other' }), tab('b')]))
    expect(strip.tabEl('a').querySelector('.fav')?.children[0]).toBe(img)
    expect(icons.favicons).toEqual(['data:image/png;base64,a', 'data:image/png;base64,b'])

    strip.push(state([tab('a', { favicon: 'data:image/png;base64,new' }), tab('b')]))
    expect(strip.tabEl('a').querySelector('.fav')?.children[0]).not.toBe(img)
    expect(icons.favicons).toEqual(['data:image/png;base64,a', 'data:image/png;base64,b', 'data:image/png;base64,new'])
  })

  it('shows the loading spinner instead of the icon, and the icon again after', () => {
    const strip = setup()
    strip.push(state([tab('a')]))
    strip.push(state([tab('a', { loading: true })]))
    const fav = strip.tabEl('a').querySelector('.fav')
    expect(fav?.classList.contains('loading')).toBe(true)
    expect(fav?.children).toEqual([])
    strip.push(state([tab('a')]))
    expect(fav?.classList.contains('loading')).toBe(false)
    expect(fav?.children).toHaveLength(1)
  })

  it('removes the element of a tab that is gone and keeps its neighbours', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b'), tab('c')]))
    const [a, b, c] = ['a', 'b', 'c'].map((id) => strip.tabEl(id))

    strip.push(state([tab('a'), tab('c')]))

    expect(strip.order()).toEqual(['a', 'c'])
    expect(b?.parentElement).toBeNull()
    expect(strip.tabEl('a')).toBe(a)
    expect(strip.tabEl('c')).toBe(c)
  })

  it('moves elements when the order changed, and builds none', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b'), tab('c'), tab('d'), tab('e')]))
    const els = ['a', 'b', 'c', 'd', 'e'].map((id) => strip.tabEl(id))
    const created = strip.created.length
    const insertions = els.map((el) => el.insertions)

    strip.push(state([tab('a'), tab('c'), tab('b'), tab('d'), tab('e')]))

    expect(strip.order()).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(strip.created.length).toBe(created)
    expect(els.map((el, at) => el.insertions - (insertions[at] ?? 0)).reduce((sum, n) => sum + n, 0)).toBe(1)
    expect(strip.tabEl('b')).toBe(els[1])
  })

  it('touches no element when nothing about the tabs changed', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b')]))
    const els = [strip.tabEl('a'), strip.tabEl('b')]
    const insertions = els.map((el) => el.insertions)
    strip.push(state([tab('a'), tab('b')]))
    expect(els.map((el) => el.insertions)).toEqual(insertions)
  })

  it('puts a pinned tab in front of the scrolling run and back, with the same element', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b'), tab('c')]))
    const b = strip.tabEl('b')

    strip.push(state([tab('b', { pinned: true }), tab('a'), tab('c')]))
    expect(b.parentElement).toBe(strip.row)
    expect(strip.row.kids.indexOf(b)).toBeLessThan(strip.row.kids.indexOf(strip.scroller))
    expect(strip.scroller.kids.map((el) => el.dataset['id'])).toEqual(['a', 'c'])

    strip.push(state([tab('a'), tab('b'), tab('c')]))
    expect(b.parentElement).toBe(strip.scroller)
    expect(strip.order()).toEqual(['a', 'b', 'c'])
    expect(strip.tabEl('b')).toBe(b)
  })

  it('marks the active tab and the joined pair, and clears the marks when they go', () => {
    const strip = setup()
    strip.push(state([tab('a', { splitWith: 'b' }), tab('b', { splitWith: 'a' }), tab('c')], 'a'))
    expect(strip.tabEl('a').classList.contains('active')).toBe(true)
    expect(strip.tabEl('a').classList.contains('joined-first')).toBe(true)
    expect(strip.tabEl('b').classList.contains('joined-second')).toBe(true)
    expect(strip.tabEl('a').getAttribute('aria-selected')).toBe('true')

    strip.push(state([tab('a'), tab('b'), tab('c')], 'c'))
    expect(strip.tabEl('a').classList.contains('active')).toBe(false)
    expect(strip.tabEl('a').classList.contains('joined')).toBe(false)
    expect(strip.tabEl('b').classList.contains('joined-second')).toBe(false)
    expect(strip.tabEl('c').classList.contains('active')).toBe(true)
    expect(strip.tabEl('a').getAttribute('aria-selected')).toBe('false')
  })

  it('runs the decorators on the tabs that changed only', () => {
    const decorate = vi.fn()
    const strip = setup([decorate])
    strip.push(state([tab('a'), tab('b'), tab('c')]))
    expect(decorate).toHaveBeenCalledTimes(3)
    decorate.mockClear()

    strip.push(state([tab('a'), tab('b', { title: 'x' }), tab('c')]))
    expect(decorate.mock.calls.map((call) => (call[1] as TabState).id)).toEqual(['b'])
  })
})

describe('a long-lived tab element', () => {
  it('acts on the tab\'s newest state, not the state it was made from', () => {
    const strip = setup()
    strip.push(state([tab('a', { splitWith: 'b' }), tab('b', { splitWith: 'a' }), tab('c')]))
    const host = drag.hosts.find((entry) => entry.id === 'a')?.host
    if (host === undefined) throw new Error('no drag host')
    const partnerOf = host['partnerOf'] as unknown as () => unknown
    const moveTab = host['moveTab'] as unknown as (id: string, index: number) => void
    expect(partnerOf()).toBe(strip.tabEl('b'))

    strip.push(state([tab('a'), tab('b'), tab('c')]))
    expect(partnerOf()).toBeNull()

    moveTab('a', 1)
    expect(strip.shell.moveTab).toHaveBeenCalledWith('a', 1)

    strip.push(state([tab('a', { splitWith: 'c' }), tab('b'), tab('c', { splitWith: 'a' })]))
    expect(partnerOf()).toBe(strip.tabEl('c'))
    strip.tabEl('a').fire('click')
    expect(strip.shell.activateTab).toHaveBeenCalledWith('a')
  })

  it('closes, activates and opens the menu of its own tab through listeners attached once', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b')]))
    const b = strip.tabEl('b')
    const attached = [...b.listeners.values()].flat().length

    strip.push(state([tab('a'), tab('b', { title: 'Renamed' })]))
    expect([...b.listeners.values()].flat().length).toBe(attached)
    b.querySelector('.close')?.fire('click')
    expect(strip.shell.closeTab).toHaveBeenCalledWith('b')
    b.fire('click')
    expect(strip.shell.activateTab).toHaveBeenCalledWith('b')
    b.fire('contextmenu')
    expect(strip.shell.showTabMenu).toHaveBeenCalledWith('b')
    b.fire('auxclick', { button: 1 })
    expect(strip.shell.closeTab).toHaveBeenCalledTimes(2)
  })

  it('is left alone while a tab is held, and brought up to date when it is let go', () => {
    const strip = setup()
    strip.push(state([tab('a'), tab('b')]))
    drag.held = true
    strip.push(state([tab('a', { title: 'Held' }), tab('b'), tab('c')]))
    expect(strip.order()).toEqual(['a', 'b'])
    expect(strip.tabEl('a').querySelector('.title')?.textContent).toBe('a')

    drag.held = false
    const host = drag.hosts[0]?.host
    ;(host?.['finished'] as unknown as (tornOut: boolean) => void)(false)
    expect(strip.order()).toEqual(['a', 'b', 'c'])
    expect(strip.tabEl('a').querySelector('.title')?.textContent).toBe('Held')
  })
})

describe('the decorators on a kept element', () => {
  it('draws the sound badge when a tab turns audible and removes it when the sound stops', () => {
    const strip = setup([decorateTabBadges])
    strip.push(state([tab('a')]))
    const el = strip.tabEl('a')
    expect(el.querySelector('.tab-audio')).toBeNull()

    strip.push(state([tab('a', { audible: true })]))
    expect(el.querySelector('.tab-audio')).not.toBeNull()
    expect(el.classList.contains('has-sound')).toBe(true)
    expect(el.getAttribute('aria-label')).toBe('a, playing audio')

    strip.push(state([tab('a')]))
    expect(el.querySelector('.tab-audio')).toBeNull()
    expect(el.classList.contains('has-sound')).toBe(false)
    expect(el.getAttribute('aria-label')).toBe('a')
  })

  it('marks the page that shares and the tab being shown, and removes the mark when the share ends', () => {
    const strip = setup([decorateTabBadges])
    strip.push(state([tab('a'), tab('b')]))
    expect(strip.tabEl('a').querySelector('.tab-share')).toBeNull()

    strip.push(state([tab('a', { sharing: 'screen' }), tab('b', { shared: true })]))
    const sharing = strip.tabEl('a').querySelector('.tab-share')
    expect(sharing?.getAttribute('aria-label')).toBe('Sharing your screen')
    expect(sharing?.classList.contains('sharing')).toBe(true)
    expect(strip.tabEl('a').getAttribute('aria-label')).toBe('a, sharing your screen')
    const shown = strip.tabEl('b').querySelector('.tab-share')
    expect(shown?.getAttribute('aria-label')).toBe('This tab is being shared')
    expect(shown?.classList.contains('shared')).toBe(true)

    strip.push(state([tab('a'), tab('b')]))
    expect(strip.tabEl('a').querySelector('.tab-share')).toBeNull()
    expect(strip.tabEl('b').querySelector('.tab-share')).toBeNull()
  })

  it('marks a pinned tab that shares on the corner of its icon', () => {
    const strip = setup([decorateTabBadges])
    strip.push(state([tab('a', { pinned: true, sharing: 'window' })]))
    expect(strip.tabEl('a').querySelector('.tab-share-mark')?.getAttribute('aria-label')).toBe('Sharing a window')
  })

  it('takes the close button off a pinned tab and gives it back when the tab is unpinned', () => {
    const strip = setup([decorateTabBadges])
    strip.push(state([tab('a')]))
    const close = strip.tabEl('a').querySelector('.close')
    strip.push(state([tab('a', { pinned: true })]))
    expect(strip.tabEl('a').querySelector('.close')).toBeNull()
    expect(strip.tabEl('a').classList.contains('pinned')).toBe(true)
    strip.push(state([tab('a')]))
    expect(strip.tabEl('a').querySelector('.close')).toBe(close)
    expect(strip.tabEl('a').classList.contains('pinned')).toBe(false)
  })

  it('shows the crash mark and the icon again after the tab recovers', () => {
    const strip = setup([decorateTabBadges, decorateTabCrashed])
    strip.push(state([tab('a')]))
    strip.push(state([tab('a', { crashed: 'crashed' })]))
    expect(strip.tabEl('a').classList.contains('crashed')).toBe(true)
    expect(strip.tabEl('a').getAttribute('aria-label')).toBe('a, crashed')
    strip.push(state([tab('a')]))
    expect(strip.tabEl('a').classList.contains('crashed')).toBe(false)
    expect(strip.tabEl('a').querySelector('.fav')?.children[0]?.attrs.get('src')).toBe('data:image/png;base64,a')
  })
})

describe('group chips on a kept strip', () => {
  const work: TabGroupState = { id: 'g-1', title: 'Work', color: 'green', collapsed: false }
  const grouped = (over: Partial<TabGroupState> = {}): ShellState =>
    state([tab('a'), tab('b', { group: 'g-1' }), tab('c', { group: 'g-1' }), tab('d')], 'a', [{ ...work, ...over }])

  it('draws the chip once and keeps it while the group is unchanged', () => {
    const strip = setup([decorateTabBadges, decorateTabGroup], [placeGroupChips])
    strip.push(grouped())
    const chip = strip.scroller.querySelector('.tab-group-chip')
    expect(chip?.nextElementSibling).toBe(strip.tabEl('b'))

    strip.push(state([tab('a', { title: 'Renamed' }), tab('b', { group: 'g-1' }), tab('c', { group: 'g-1' }), tab('d')], 'a', [work]))
    expect(strip.scroller.querySelector('.tab-group-chip')).toBe(chip)
    expect(chip?.insertions).toBe(1)
  })

  it('draws it again when the group is renamed, collapsed, or its first tab changed', () => {
    const strip = setup([decorateTabBadges, decorateTabGroup], [placeGroupChips])
    strip.push(grouped())
    const first = strip.scroller.querySelector('.tab-group-chip')

    strip.push(grouped({ title: 'Play' }))
    const renamed = strip.scroller.querySelector('.tab-group-chip')
    expect(renamed).not.toBe(first)
    expect(renamed?.querySelector('.tg-title')?.textContent).toBe('Play')
    expect(strip.scroller.querySelectorAll('.tab-group-chip')).toHaveLength(1)

    strip.push(grouped({ title: 'Play', collapsed: true }))
    expect(strip.scroller.querySelector('.tab-group-chip')).not.toBe(renamed)
    expect(strip.tabEl('b').hidden).toBe(true)

    strip.push(state([tab('a'), tab('c', { group: 'g-1' }), tab('b', { group: 'g-1' }), tab('d')], 'a', [{ ...work, title: 'Play' }]))
    expect(strip.scroller.querySelectorAll('.tab-group-chip')).toHaveLength(1)
    expect(strip.scroller.querySelector('.tab-group-chip')?.nextElementSibling).toBe(strip.tabEl('c'))
  })

  it('removes the chip when the group goes, and keeps chips in front of their tabs when a tab moves', () => {
    const strip = setup([decorateTabBadges, decorateTabGroup], [placeGroupChips])
    strip.push(grouped())
    strip.push(state([tab('b', { group: 'g-1' }), tab('c', { group: 'g-1' }), tab('d'), tab('a')], 'a', [work]))
    const chip = strip.scroller.querySelector('.tab-group-chip')
    expect(chip?.nextElementSibling).toBe(strip.tabEl('b'))
    expect(strip.scroller.kids[0]).toBe(chip)

    strip.push(state([tab('b'), tab('c'), tab('d'), tab('a')], 'a', []))
    expect(strip.scroller.querySelectorAll('.tab-group-chip')).toHaveLength(0)
  })

  it('sizes the strip to its shown tabs and chips, and only writes the size when it changed', () => {
    const strip = setup([decorateTabBadges, decorateTabGroup], [placeGroupChips])
    strip.push(grouped())
    expect(strip.scroller.style.props.get('--tab-count')).toBe('4.5')
    strip.push(grouped({ collapsed: true }))
    expect(strip.scroller.style.props.get('--tab-count')).toBe('2.5')
    strip.push(state([tab('a'), tab('b')], 'a', []))
    expect(strip.scroller.style.props.get('--tab-count')).toBe('2')
  })
})
