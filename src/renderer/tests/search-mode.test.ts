import { describe, expect, it } from 'vitest'
import { CHROME_MODULES } from '../chrome/modules.js'
import { chipShown, chipView, createSearchMode } from '../chrome/search-mode.js'

describe('the search mode chip', () => {
  it('says the mode, the engine in use and what a click switches to, with the names main pushed', () => {
    expect(chipView({ searchMode: 'web3', searchWeb3Name: 'Explore', searchWeb2Name: 'DuckDuckGo' })).toEqual({
      text: 'Web3',
      label: 'Searching Web3 with Explore. Click to search Web2 with DuckDuckGo.',
      pressed: true
    })
    expect(chipView({ searchMode: 'web2', searchWeb3Name: 'Explore', searchWeb2Name: 'Brave Search' })).toEqual({
      text: 'Web2',
      label: 'Searching Web2 with Brave Search. Click to search Web3 with Explore.',
      pressed: false
    })
  })

  it('leaves the engine out when the Web2 address is the person\'s own and has no name', () => {
    expect(chipView({ searchMode: 'web2', searchWeb3Name: 'Explore', searchWeb2Name: '' }).label).toBe('Searching Web2. Click to search Web3 with Explore.')
  })

  it('shows while the field or the chip has the keyboard, or the field is empty, and not beside a loaded page\'s address', () => {
    expect(chipShown(true, false, 'https://example.com/')).toBe(true)
    expect(chipShown(false, true, 'https://example.com/')).toBe(true)
    expect(chipShown(false, false, '')).toBe(true)
    expect(chipShown(false, false, 'https://example.com/')).toBe(false)
  })

  it('is a module, placed after the address field it belongs to', () => {
    const names = CHROME_MODULES.map((module) => module.name)
    expect(names.indexOf('search-mode')).toBeGreaterThan(names.indexOf('address-suggest'))
  })
})

describe('the chip across state pushes', () => {
  class El {
    hidden = false
    title = ''
    textContent = ''
    value = ''
    dataset: Record<string, string> = {}
    attrs = new Map<string, string>()
    listeners = new Map<string, Array<(event: unknown) => void>>()
    addEventListener (type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
    setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
    dispatchEvent (): boolean { return true }
  }

  function mount () {
    const chip = new El()
    const input = new El()
    const page = { focused: true, active: undefined as unknown }
    const fakeDocument = {
      querySelector: (selector: string) => (selector === '#search-mode' ? chip : input),
      hasFocus: () => page.focused,
      get activeElement () { return page.active }
    }
    const original = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = fakeDocument
    const module = createSearchMode()
    const ctx = { shell: { runCommand: () => {} } } as never
    module.init(ctx)
    const state = { searchMode: 'web3', searchWeb3Name: 'Explore', searchWeb2Name: 'DuckDuckGo' } as never
    return {
      chip, input, page,
      push: (value: string): void => { input.value = value; module.render?.(state, ctx) },
      restore: (): void => { (globalThis as { document?: unknown }).document = original }
    }
  }

  it('stays hidden beside a page\'s address after the person clicks into the page, whatever the chrome document still calls active', () => {
    const m = mount()
    try {
      m.page.active = m.input
      m.push('https://example.com/')
      expect(m.chip.hidden).toBe(false)

      // The page took the keyboard: the chrome document is no longer the focused one, yet its active element is still the field.
      m.page.focused = false
      m.push('https://example.com/')
      expect(m.chip.hidden).toBe(true)
      m.push('https://example.com/')
      expect(m.chip.hidden).toBe(true)

      m.page.focused = true
      m.push('https://example.com/')
      expect(m.chip.hidden).toBe(false)
    } finally {
      m.restore()
    }
  })

  it('still shows on an empty field with nothing focused, as on a new tab', () => {
    const m = mount()
    try {
      m.page.focused = false
      m.push('')
      expect(m.chip.hidden).toBe(false)
    } finally {
      m.restore()
    }
  })
})
