import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { createMacWindowButtons } from '../chrome/mac-window-buttons.js'

interface FakeElement {
  id: string
  className: string
  hidden: boolean
  disabled: boolean
  title: string
  children: FakeElement[]
  attributes: Map<string, string>
  listeners: Map<string, () => void>
}

function fakeElement (): FakeElement & Record<string, unknown> {
  const el: FakeElement & Record<string, unknown> = {
    id: '',
    className: '',
    hidden: false,
    disabled: false,
    title: '',
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    append (...kids: FakeElement[]) { el.children.push(...kids) },
    prepend (...kids: FakeElement[]) { el.children.unshift(...kids) },
    setAttribute (name: string, value: string) { el.attributes.set(name, value) },
    addEventListener (type: string, listener: () => void) { el.listeners.set(type, listener) }
  }
  return el
}

function setup (platform: string): { row: FakeElement, runCommand: ReturnType<typeof vi.fn>, module: ReturnType<typeof createMacWindowButtons>, ctx: ChromeContext } {
  const row = fakeElement()
  vi.stubGlobal('document', {
    createElement: () => fakeElement(),
    createElementNS: () => fakeElement(),
    getElementById: (id: string) => (id === 'tabrow' ? row : null)
  })
  const runCommand = vi.fn()
  const ctx = { shell: { platform, runCommand } } as unknown as ChromeContext
  const module = createMacWindowButtons()
  module.init(ctx)
  return { row, runCommand, module, ctx }
}

const state = (fullScreen: boolean | undefined): ShellState => ({ fullScreen }) as unknown as ShellState

afterEach(() => { vi.unstubAllGlobals() })

describe('the window buttons drawn in macOS full screen', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('mac-window-buttons')
  })

  it('draws nothing on another system', () => {
    for (const platform of ['linux', 'win32']) {
      const { row, module, ctx } = setup(platform)
      module.render?.(state(true), ctx)
      expect(row.children).toEqual([])
    }
  })

  it('shows close, a greyed minimise and leave full screen only while the window fills the screen', () => {
    const { row, module, ctx } = setup('darwin')
    const group = row.children[0] as FakeElement
    expect(group.id).toBe('mac-window-buttons')
    expect(group.hidden).toBe(true)
    expect(group.children.map((button) => [button.attributes.get('aria-label'), button.disabled])).toEqual([
      ['Close window', false],
      ['Minimise is not available in full screen', true],
      ['Exit full screen', false]
    ])
    module.render?.(state(true), ctx)
    expect(group.hidden).toBe(false)
    module.render?.(state(false), ctx)
    expect(group.hidden).toBe(true)
    module.render?.(state(undefined), ctx)
    expect(group.hidden).toBe(true)
  })

  it('closes the window from the red button and leaves full screen from the green one', () => {
    const { row, runCommand } = setup('darwin')
    const [close, minimize, zoom] = (row.children[0] as FakeElement).children as [FakeElement, FakeElement, FakeElement]
    close.listeners.get('click')?.()
    zoom.listeners.get('click')?.()
    expect(minimize.listeners.size).toBe(0)
    expect(runCommand.mock.calls).toEqual([['window.close'], ['window.fullscreen']])
  })
})
