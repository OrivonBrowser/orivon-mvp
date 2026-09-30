import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../main/shell/tabs.js'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'

// A node-only stand-in for the few parts of the DOM the decorator touches.
class FakeEl {
  className = ''
  title = ''
  type = ''
  tabIndex = 0
  children: FakeEl[] = []
  attrs = new Map<string, string>()
  listeners = new Map<string, Array<(event: { stopPropagation: () => void }) => void>>()
  classes = new Set<string>()
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name) },
    toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name) },
    contains: (name: string) => this.classes.has(name)
  }

  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  append (...nodes: FakeEl[]): void { this.children.push(...nodes) }
  addEventListener (type: string, listener: (event: { stopPropagation: () => void }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  querySelector (selector: string): FakeEl | null { return this.children.find((child) => `.${child.className}` === selector || child.classes.has(selector.slice(1))) ?? null }
  before (node: FakeEl): void { this.parent?.children.splice(this.parent.children.indexOf(this), 0, node) }
  remove (): void { if (this.parent !== undefined) this.parent.children.splice(this.parent.children.indexOf(this), 1) }
  parent: FakeEl | undefined
}

vi.mock('../pages/shared/icons.js', () => ({ speakerIcon: () => 'speaker', speakerOffIcon: () => 'speaker-off' }))

const { decorateTabBadges, muteLabel, tabTooltip } = await import('../chrome/tab-badges.js')

afterEach(() => { vi.unstubAllGlobals() })

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 'a', url: 'https://example.com/page', displayUrl: 'https://example.com/page', title: 'Example', canGoBack: false, canGoForward: false, loading: false,
  favicon: null, isNewTab: false, splitWith: null, isInternal: false, pinned: false, muted: false, audible: false, crashed: null, ...over
})

describe('a tab\'s tooltip', () => {
  it('is the title, then the address\'s host', () => {
    expect(tabTooltip(tab())).toBe('Example\nexample.com')
  })

  it('says what is true of the tab: playing audio, or muted', () => {
    expect(tabTooltip(tab({ audible: true }))).toBe('Example\nexample.com (playing audio)')
    expect(tabTooltip(tab({ audible: true, muted: true }))).toBe('Example\nexample.com (muted)')
    expect(tabTooltip(tab({ muted: true }))).toBe('Example\nexample.com (muted)')
  })

  it('keeps "Split view" as a third line', () => {
    expect(tabTooltip(tab({ splitWith: 'b' }))).toBe('Example\nexample.com\nSplit view')
  })

  it('is "New tab" for the new-tab page, and the address alone for a page with no title', () => {
    expect(tabTooltip(tab({ isNewTab: true, title: '' }))).toBe('New tab')
    expect(tabTooltip(tab({ title: '' }))).toBe('example.com')
  })

  it('shows a whole address that has no host: a file or a shell page', () => {
    expect(tabTooltip(tab({ displayUrl: 'file:///tmp/a.html' }))).toBe('Example\nfile:///tmp/a.html')
    expect(tabTooltip(tab({ displayUrl: 'not an address' }))).toBe('Example\nnot an address')
  })
})

describe('the speaker badge', () => {
  function decorate (over: Partial<TabState>, act = vi.fn(async () => undefined)): { el: FakeEl, act: typeof act, state: ShellState } {
    vi.stubGlobal('document', { createElement: () => { const created = new FakeEl(); return created } })
    const el = new FakeEl()
    const close = new FakeEl()
    close.className = 'close'
    close.parent = el
    el.children.push(close)
    const current = tab(over)
    const state = { tabs: [current], activeTabId: 'a' } as unknown as ShellState
    decorateTabBadges(el as never, current, state, { shell: { act } } as unknown as ChromeContext)
    return { el, act, state }
  }

  it('is absent while the tab is silent and unmuted', () => {
    const { el } = decorate({})
    expect(el.children.map((child) => child.className)).toEqual(['close'])
  })

  it('shows the speaker before the close button while audible, labelled to mute', () => {
    const { el } = decorate({ audible: true })
    const badge = el.children[0]
    expect(badge?.className).toContain('tab-audio')
    expect(badge?.attrs.get('aria-label')).toBe('Mute tab')
    expect(badge?.title).toBe('Mute tab')
    expect(badge?.children).toEqual(['speaker'])
    expect(el.children[1]?.className).toBe('close')
    expect(el.classes.has('has-sound')).toBe(true)
  })

  it('shows a muted tab as muted even when it is silent, and offers to unmute', () => {
    const { el } = decorate({ muted: true, audible: false })
    expect(el.children[0]?.children).toEqual(['speaker-off'])
    expect(el.children[0]?.attrs.get('aria-label')).toBe('Unmute tab')
    expect(muteLabel(tab({ muted: true }))).toBe('Unmute tab')
  })

  it('toggles the mute on a click, without activating the tab, and is no tab stop', () => {
    const { el, act } = decorate({ audible: true })
    const stopPropagation = vi.fn()
    for (const listener of el.children[0]?.listeners.get('click') ?? []) listener({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalled()
    expect(act).toHaveBeenCalledWith('tab.mute', { id: 'a' })
    expect(el.children[0]?.tabIndex).toBe(-1)
  })
})

describe('a pinned tab', () => {
  function decorate (over: Partial<TabState>, next?: Partial<TabState>): FakeEl {
    vi.stubGlobal('document', { createElement: () => new FakeEl() })
    const el = new FakeEl()
    const close = new FakeEl()
    close.className = 'close'
    close.parent = el
    el.children.push(close)
    const current = tab({ pinned: true, ...over })
    const tabs = next === undefined ? [current] : [current, tab({ id: 'b', ...next })]
    decorateTabBadges(el as never, current, { tabs, activeTabId: 'a' } as unknown as ShellState, {} as ChromeContext)
    return el
  }

  it('is pinned, has no close button, and keeps its title as its name', () => {
    const el = decorate({})
    expect(el.classes.has('pinned')).toBe(true)
    expect(el.querySelector('.close')).toBeNull()
    expect(el.attrs.get('aria-label')).toBe('Example')
  })

  it('marks the last pinned tab, where a hairline follows it', () => {
    expect(decorate({}, { pinned: false }).classes.has('last-pinned')).toBe(true)
    expect(decorate({}, { pinned: true }).classes.has('last-pinned')).toBe(false)
    expect(decorate({}).classes.has('last-pinned')).toBe(false)
  })

  it('shows its sound as a mark on the icon, not a button', () => {
    const el = decorate({ muted: true })
    expect(el.children.at(-1)?.className).toBe('tab-sound-mark')
    expect(el.children.at(-1)?.children).toEqual(['speaker-off'])
    expect(el.classes.has('has-sound')).toBe(false)
    expect(decorate({}).children.some((child) => child.className === 'tab-sound-mark')).toBe(false)
  })
})
