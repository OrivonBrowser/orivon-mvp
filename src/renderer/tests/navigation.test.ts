import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { createNavigation } from '../chrome/navigation.js'

class FakeEl {
  value = ''
  disabled = false
  selected = false
  listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener (type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  fire (type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  select (): void { this.selected = true }
  blur (): void {}
  focus (): void {}
  closest (): null { return null }
}

interface Tab { id: string, displayUrl: string, isNewTab: boolean, canGoBack: boolean, canGoForward: boolean }

afterEach(() => { vi.unstubAllGlobals() })

function mount () {
  const els: Record<string, FakeEl> = { '#back': new FakeEl(), '#forward': new FakeEl(), '#reload': new FakeEl(), '#address-form': new FakeEl(), '#address': new FakeEl() }
  const doc = { activeElement: null as unknown, querySelector: (selector: string) => els[selector] ?? null }
  vi.stubGlobal('document', doc)
  const input = els['#address'] as FakeEl
  let tabs: Tab[] = [{ id: 'a', displayUrl: 'https://a.example/', isNewTab: false, canGoBack: false, canGoForward: false }, { id: 'b', displayUrl: 'https://b.example/', isNewTab: false, canGoBack: false, canGoForward: false }]
  let activeTabId = 'a'
  const state = (): never => ({ activeTabId, tabs }) as never
  const ctx = { shell: { navigate: vi.fn() }, state, activeTab: () => tabs.find((tab) => tab.id === activeTabId) } as unknown as ChromeContext
  const nav = createNavigation()
  nav.init(ctx)
  const push = (): void => { nav.render?.(state(), ctx) }
  push()
  return {
    input,
    doc,
    push,
    focusField: () => { doc.activeElement = input; input.fire('focus') },
    activate: (id: string) => { activeTabId = id; push() },
    moveTo: (url: string) => { tabs = tabs.map((tab) => tab.id === activeTabId ? { ...tab, displayUrl: url } : tab); push() }
  }
}

describe('the address field and the state pushes', () => {
  it('keeps an edit while the field is focused, and gives the page address back when the field is left', () => {
    const s = mount()
    s.focusField()
    s.input.value = 'half typed'
    s.push()
    expect(s.input.value).toBe('half typed')
    s.doc.activeElement = null
    s.input.fire('blur')
    expect(s.input.value).toBe('https://a.example/')
  })

  it('keeps an edit when the keyboard goes to another app or the page and the field stays the focused element, until the page moves on', () => {
    const s = mount()
    s.focusField()
    s.input.value = 'half typed'
    s.input.fire('blur')
    s.push()
    expect(s.input.value).toBe('half typed')
    s.input.fire('focus')
    s.push()
    expect(s.input.value).toBe('half typed')

    s.input.fire('blur')
    s.moveTo('https://a.example/next')
    expect(s.input.value).toBe('https://a.example/next')
    s.moveTo('https://a.example/later')
    expect(s.input.value).toBe('https://a.example/later')
  })

  it('shows the new tab\'s address, selected, when the tab changes under a focused field', () => {
    const s = mount()
    s.focusField()
    s.input.value = 'typed on a'
    s.input.selected = false
    s.activate('b')
    expect(s.input.value).toBe('https://b.example/')
    expect(s.input.selected).toBe(true)
  })
})
