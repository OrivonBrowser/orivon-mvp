import { afterEach, describe, expect, it, vi } from 'vitest'
import { redrawKeepingFocus } from '../keep-focus.js'

afterEach(() => { vi.unstubAllGlobals() })

function control (key: string | undefined): { dataset: Record<string, string>, focus: ReturnType<typeof vi.fn> } {
  return { dataset: key === undefined ? {} : { focus: key }, focus: vi.fn() }
}

describe('redrawKeepingFocus', () => {
  it('puts the keyboard on the new control that carries the old one\'s key', () => {
    const before = control('p1:color:green')
    const after = control('p1:color:green')
    const doc = { activeElement: before }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('CSS', { escape: (text: string) => text.replace(/:/g, '\\:') })
    const root = { querySelector: vi.fn((selector: string) => selector === '[data-focus="p1\\:color\\:green"]' ? after : null) }
    const draw = vi.fn()
    redrawKeepingFocus(root as unknown as ParentNode, draw)
    expect(draw).toHaveBeenCalledOnce()
    expect(after.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('moves nothing when the control that had the keyboard carries no key', () => {
    vi.stubGlobal('document', { activeElement: control(undefined) })
    const root = { querySelector: vi.fn() }
    redrawKeepingFocus(root as unknown as ParentNode, () => {})
    expect(root.querySelector).not.toHaveBeenCalled()
  })
})
