import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolbarButtonSpec } from '../chrome/context.js'
import { toolbarButton } from '../chrome/toolbar-button.js'

class FakeButton {
  id = ''
  type = ''
  className = ''
  title = ''
  style: Record<string, string> = {}
  attrs = new Map<string, string>()
  listeners = new Map<string, Array<(event: unknown) => void>>()
  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  append (): void {}
  addEventListener (type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  fire (type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
}

afterEach(() => { vi.unstubAllGlobals() })

function make (spec: Partial<ToolbarButtonSpec>): { button: FakeButton, press: ReturnType<typeof vi.fn>, onClick: ReturnType<typeof vi.fn> } {
  const button = new FakeButton()
  vi.stubGlobal('document', { querySelector: () => ({ append: () => {} }), createElement: () => button })
  const press = vi.fn()
  const onClick = vi.fn()
  toolbarButton({ id: 'b', slot: 'cluster', order: 1, label: 'B', icon: () => ({}) as SVGSVGElement, onClick, ...spec }, { press })
  return { button, press, onClick }
}

describe('toolbarButton', () => {
  it('announces a primary press of a button that toggles an overlay, before its click', () => {
    const { button, press, onClick } = make({ presses: 'downloads' })
    button.fire('pointerdown', { button: 0 })
    expect(press).toHaveBeenCalledWith('downloads')
    button.fire('click', {})
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('announces nothing for another mouse button, or for a button that toggles no overlay', () => {
    const toggling = make({ presses: 'tab-search' })
    toggling.button.fire('pointerdown', { button: 1 })
    toggling.button.fire('pointerdown', { button: 2 })
    expect(toggling.press).not.toHaveBeenCalled()

    const plain = make({})
    plain.button.fire('pointerdown', { button: 0 })
    expect(plain.press).not.toHaveBeenCalled()
    expect(plain.button.listeners.has('pointerdown')).toBe(false)
  })
})
