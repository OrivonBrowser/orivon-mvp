import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { createNavigation } from '../chrome/navigation.js'

class FakeEl {
  value = ''
  disabled = false
  selected = false
  caretAtEnd = false
  dataset: Record<string, string | undefined> = {}
  listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener (type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  fire (type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  select (): void { this.selected = true }
  setSelectionRange (start: number, end: number): void { this.caretAtEnd = start === end && end === this.value.length }
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
    nav,
    ctx,
    input,
    form: els['#address-form'] as FakeEl,
    doc,
    push,
    focusField: () => { doc.activeElement = input; input.fire('focus') },
    type: (text: string) => { input.value = text; input.fire('input') },
    activate: (id: string) => { activeTabId = id; push() },
    /** The keyboard leaves the field for something else in the chrome, then the tab is chosen: a click on the strip. */
    clickTab: (id: string) => { doc.activeElement = null; input.fire('blur'); activeTabId = id; push() },
    leave: () => { doc.activeElement = null; input.fire('blur') },
    moveTo: (url: string) => { tabs = tabs.map((tab) => tab.id === activeTabId ? { ...tab, displayUrl: url } : tab); push() },
    moveTabTo: (id: string, url: string) => { tabs = tabs.map((tab) => tab.id === id ? { ...tab, displayUrl: url } : tab); push() },
    openTab: (tab: Partial<Tab> & { id: string }) => { tabs = [...tabs, { displayUrl: '', isNewTab: false, canGoBack: false, canGoForward: false, ...tab }]; activeTabId = tab.id; push() },
    closeTab: (id: string) => { tabs = tabs.filter((tab) => tab.id !== id); if (activeTabId === id) activeTabId = tabs[0]?.id ?? ''; push() }
  }
}

describe('the address field and the state pushes', () => {
  it('keeps an edit while the field is focused, and when the field is left', () => {
    const s = mount()
    s.focusField()
    s.type('half typed')
    s.push()
    expect(s.input.value).toBe('half typed')
    s.leave()
    expect(s.input.value).toBe('half typed')
    s.push()
    expect(s.input.value).toBe('half typed')
    expect(s.input.dataset['draft']).toBe('true')
  })

  it('takes an emptied field, a blank one and one showing the address for no edit once it is left', () => {
    const s = mount()
    for (const text of ['', '   ', 'https://a.example/']) {
      s.focusField()
      s.type(text)
      expect(s.input.dataset['draft']).toBe('false')
      s.leave()
      expect(s.input.value).toBe('https://a.example/')
    }
  })

  it('keeps an edit when the keyboard goes to another app or the page and the field stays the focused element, until the page moves on', () => {
    const s = mount()
    s.focusField()
    s.type('half typed')
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
    s.type('typed on a')
    s.input.selected = false
    s.activate('b')
    expect(s.input.value).toBe('https://b.example/')
    expect(s.input.selected).toBe(true)
  })

  it('shows a navigation that did not come from the bar while the field is focused and untouched, selected', () => {
    const s = mount()
    s.focusField()
    s.input.selected = false
    s.moveTo('https://a.example/settings')
    expect(s.input.value).toBe('https://a.example/settings')
    expect(s.input.selected).toBe(true)
  })

  it('keeps typed text across a navigation from elsewhere, and follows the page again once the field is submitted, or left and the page then moves on', () => {
    const s = mount()
    s.focusField()
    s.type('abc')
    s.moveTo('https://a.example/next')
    expect(s.input.value).toBe('abc')

    s.form.fire('submit', { preventDefault: () => {} })
    s.moveTo('https://a.example/after-enter')
    expect(s.input.value).toBe('https://a.example/after-enter')

    s.type('def')
    s.leave()
    expect(s.input.value).toBe('def')
    s.moveTo('https://a.example/after-blur')
    expect(s.input.value).toBe('https://a.example/after-blur')
  })

  it('keeps the text the search key put in the field through a state push that arrives before the first letter', () => {
    const s = mount()
    s.nav.event?.({ type: 'focusSearch' }, s.ctx)
    s.focusField()
    s.input.value = '? '
    s.input.selected = false
    s.push()
    expect(s.input.value).toBe('? ')
    expect(s.input.selected).toBe(false)
    s.moveTo('https://a.example/next')
    expect(s.input.value).toBe('? ')
  })

  it('does not reselect an untouched focused field that already shows the address', () => {
    const s = mount()
    s.focusField()
    s.push()
    s.input.selected = false
    s.push()
    expect(s.input.selected).toBe(false)
  })

  it('keeps an edit through a navigation from elsewhere while the field is typed in, and over the page it moved to once the field is left', () => {
    const s = mount()
    s.focusField()
    s.type('abc')
    s.moveTo('https://a.example/next')
    s.leave()
    expect(s.input.value).toBe('abc')
    s.push()
    expect(s.input.value).toBe('abc')
    s.moveTo('https://a.example/later')
    expect(s.input.value).toBe('https://a.example/later')
  })

  it('shows an edit again, as typed, when its tab comes back after the field was left and another tab was chosen', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.clickTab('b')
    expect(s.input.value).toBe('https://b.example/')
    expect(s.input.dataset['draft']).toBe('false')
    s.activate('a')
    expect(s.input.value).toBe('typed on a')
    expect(s.input.dataset['draft']).toBe('true')
    s.push()
    expect(s.input.value).toBe('typed on a')
  })

  it('keeps one edit for each tab', () => {
    const s = mount()
    s.focusField()
    s.type('for a')
    s.clickTab('b')
    s.focusField()
    s.type('for b')
    s.clickTab('a')
    expect(s.input.value).toBe('for a')
    s.clickTab('b')
    expect(s.input.value).toBe('for b')
    s.clickTab('a')
    expect(s.input.value).toBe('for a')
  })

  it('keeps an edit when another tab comes to the front under the focused field, and puts the caret after it when the tab returns', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.activate('b')
    expect(s.input.value).toBe('https://b.example/')
    s.input.selected = false
    s.activate('a')
    expect(s.input.value).toBe('typed on a')
    expect(s.input.selected).toBe(false)
    expect(s.input.caretAtEnd).toBe(true)
    s.moveTo('https://a.example/next')
    expect(s.input.value).toBe('typed on a')
  })

  it('keeps an edit of a tab the keyboard left for another app or the page, when another tab is chosen and the first returns', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.input.fire('blur')
    s.activate('b')
    expect(s.input.value).toBe('https://b.example/')
    s.activate('a')
    expect(s.input.value).toBe('typed on a')
  })

  it('keeps what was typed over the start page of a new tab', () => {
    const s = mount()
    s.openTab({ id: 'n', isNewTab: true })
    s.focusField()
    s.type('half a search')
    s.clickTab('a')
    expect(s.input.value).toBe('https://a.example/')
    s.activate('n')
    expect(s.input.value).toBe('half a search')
  })

  it('keeps a shown edit only until its page moves on, whether the tab was in the background or in front', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.clickTab('b')
    s.moveTabTo('a', 'https://a.example/elsewhere')
    s.activate('a')
    expect(s.input.value).toBe('https://a.example/elsewhere')
    expect(s.input.dataset['draft']).toBe('false')

    s.focusField()
    s.type('typed again')
    s.clickTab('b')
    s.activate('a')
    expect(s.input.value).toBe('typed again')
    s.moveTo('https://a.example/third')
    expect(s.input.value).toBe('https://a.example/third')
  })

  it('forgets the edit when it is submitted', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.form.fire('submit', { preventDefault: () => {} })
    expect(s.ctx.shell.navigate).toHaveBeenCalledWith('a', 'typed on a')
    s.leave()
    expect(s.input.value).toBe('https://a.example/')
    s.clickTab('b')
    s.activate('a')
    expect(s.input.value).toBe('https://a.example/')
  })

  it('forgets the edit when Escape puts the address back, and when a choice from the dropdown is made', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.input.value = 'https://a.example/'
    s.leave()
    expect(s.input.value).toBe('https://a.example/')
    s.activate('b')
    s.activate('a')
    expect(s.input.value).toBe('https://a.example/')

    s.focusField()
    s.type('a chosen row')
    s.input.fire('address-chosen')
    s.leave()
    expect(s.input.value).toBe('https://a.example/')
    expect(s.input.dataset['draft']).toBe('false')
    s.activate('b')
    s.activate('a')
    expect(s.input.value).toBe('https://a.example/')
  })

  it('forgets the edit of a closed tab', () => {
    const s = mount()
    s.openTab({ id: 'c', displayUrl: 'https://c.example/' })
    s.focusField()
    s.type('typed on c')
    s.clickTab('a')
    s.closeTab('c')
    s.openTab({ id: 'c', displayUrl: 'https://c.example/' })
    expect(s.input.value).toBe('https://c.example/')
  })

  it('does not keep an edit past the tab it was made on when that tab was closed in front', () => {
    const s = mount()
    s.focusField()
    s.type('typed on a')
    s.closeTab('a')
    expect(s.input.value).toBe('https://b.example/')
    s.openTab({ id: 'a', displayUrl: 'https://a.example/' })
    expect(s.input.value).toBe('https://a.example/')
  })
})
