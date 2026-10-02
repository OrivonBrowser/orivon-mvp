import { describe, expect, it, vi } from 'vitest'
import { closeOnEscape } from '../escape-closes.js'
import type { KeyEventLike } from '../escape-closes.js'

function setup (): { press: (event: Partial<KeyEventLike>) => void, close: ReturnType<typeof vi.fn> } {
  let listener: ((event: KeyEventLike) => void) | undefined
  const close = vi.fn()
  closeOnEscape({ addEventListener: (_type, fn) => { listener = fn } }, close)
  return {
    close,
    press: (event) => { listener?.({ key: 'Escape', defaultPrevented: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...event }) }
  }
}

describe('closeOnEscape', () => {
  it('closes on a plain Escape', () => {
    const { press, close } = setup()
    press({})
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves an Escape the page already took (an open select, a cleared field)', () => {
    const { press, close } = setup()
    press({ defaultPrevented: true })
    expect(close).not.toHaveBeenCalled()
  })

  it.each([
    ['another key', { key: 'Enter' }],
    ['a held modifier', { ctrlKey: true }],
    ['an input method composing', { isComposing: true }]
  ])('does not close on %s', (_label, event) => {
    const { press, close } = setup()
    press(event)
    expect(close).not.toHaveBeenCalled()
  })
})
