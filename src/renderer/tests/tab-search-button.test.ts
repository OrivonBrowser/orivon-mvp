import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHROME_MODULES } from '../chrome/modules.js'
import type { ChromeContext } from '../chrome/context.js'
import { createTabSearchButton } from '../chrome/tab-search-button.js'

interface FakeButton {
  id: string
  type: string
  className: string
  title: string
  attributes: Map<string, string>
  children: unknown[]
  listeners: Map<string, () => void>
  setAttribute: (name: string, value: string) => void
  append: (child: unknown) => void
  addEventListener: (type: string, listener: () => void) => void
}

function setup (platform: string): { button: FakeButton, row: { append: ReturnType<typeof vi.fn> }, act: ReturnType<typeof vi.fn> } {
  const button: FakeButton = {
    id: '',
    type: '',
    className: '',
    title: '',
    attributes: new Map(),
    children: [],
    listeners: new Map(),
    setAttribute (name, value) { this.attributes.set(name, value) },
    append (child) { this.children.push(child) },
    addEventListener (type, listener) { this.listeners.set(type, listener) }
  }
  const row = { append: vi.fn() }
  const icon = { setAttribute: vi.fn(), append: vi.fn(), classList: { add: vi.fn() } }
  vi.stubGlobal('document', {
    documentElement: { dataset: { platform } },
    getElementById: (id: string) => id === 'tabrow' ? row : null,
    createElement: () => button,
    createElementNS: () => icon
  })
  const act = vi.fn()
  const ctx = { shell: { act }, anchorFor: () => ({ x: 1, y: 2, width: 28, height: 28 }) } as unknown as ChromeContext
  createTabSearchButton().init(ctx)
  return { button, row, act }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the tab search button', () => {
  it('is one of the chrome modules, right after the strip', () => {
    const names = CHROME_MODULES.map((module) => module.name)
    expect(names.indexOf('tab-search')).toBe(names.indexOf('tab-strip') + 1)
  })

  it('ends the tab strip, named for what it does, with the key in its tooltip', () => {
    const { button, row } = setup('linux')
    expect(row.append).toHaveBeenCalledExactlyOnceWith(button)
    expect(button.attributes.get('aria-label')).toBe('Search tabs')
    expect(button.title).toBe('Search tabs (Ctrl+Shift+A)')
    expect(button.className).toContain('no-drag')
  })

  it('writes the key the Mac way on a Mac', () => {
    expect(setup('darwin').button.title).toBe('Search tabs (⌘⇧A)')
  })

  it('toggles the overlay under itself on a click', () => {
    const { button, act } = setup('linux')
    button.listeners.get('click')?.()
    expect(act).toHaveBeenCalledExactlyOnceWith('overlay.toggle', { name: 'tab-search', anchor: { x: 1, y: 2, width: 28, height: 28 } })
  })
})
