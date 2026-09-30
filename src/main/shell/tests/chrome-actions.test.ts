import { describe, expect, it, vi } from 'vitest'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { WindowContext } from '../window-context.js'

function context (overlays?: { toggle: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn> }): WindowContext {
  return { window: { overlays } as never, services: {} as never }
}

describe('runChromeAction', () => {
  it('runs a registered action with its payload and the window context, and returns its answer', () => {
    const ctx = context()
    const original = CHROME_ACTIONS['overlay.close']
    const spy = vi.fn(() => 'answer')
    ;(CHROME_ACTIONS as Record<string, unknown>)['overlay.close'] = spy
    try {
      expect(runChromeAction('overlay.close', { name: 'menu' }, ctx)).toBe('answer')
      expect(spy).toHaveBeenCalledWith({ name: 'menu' }, ctx)
    } finally {
      ;(CHROME_ACTIONS as Record<string, unknown>)['overlay.close'] = original
    }
  })

  it('does nothing for a name that is not a registered key, whatever the prototype holds', () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 42, null, undefined]) {
      expect(runChromeAction(name, {}, context())).toBeUndefined()
    }
  })
})

describe('overlay.toggle', () => {
  const anchor = { x: 1, y: 2, width: 3, height: 4 }

  it('toggles the named overlay with its anchor and payload', () => {
    const overlays = { toggle: vi.fn(), close: vi.fn() }

    runChromeAction('overlay.toggle', { name: 'menu', anchor, payload: { a: 1 } }, context(overlays))

    expect(overlays.toggle).toHaveBeenCalledWith('menu', anchor, { a: 1 })
  })

  it('toggles without an anchor when the chrome sent none', () => {
    const overlays = { toggle: vi.fn(), close: vi.fn() }

    runChromeAction('overlay.toggle', { name: 'find' }, context(overlays))

    expect(overlays.toggle).toHaveBeenCalledWith('find', undefined, undefined)
  })

  it('refuses a payload that is not a name and a well-formed anchor', () => {
    const overlays = { toggle: vi.fn(), close: vi.fn() }
    const ctx = context(overlays)

    for (const payload of [undefined, null, 'menu', {}, { name: 7 }, { name: '' }, { name: 'menu', anchor: 5 },
      { name: 'menu', anchor: { x: 1, y: 2, width: 3 } }, { name: 'menu', anchor: { ...anchor, x: Number.NaN } },
      { name: 'menu', anchor: { ...anchor, y: '2' } }]) {
      runChromeAction('overlay.toggle', payload, ctx)
    }

    expect(overlays.toggle).not.toHaveBeenCalled()
  })

  it('does nothing in a window with no overlay host', () => {
    expect(() => runChromeAction('overlay.toggle', { name: 'menu', anchor }, context())).not.toThrow()
    expect(() => runChromeAction('overlay.close', { name: 'menu' }, context())).not.toThrow()
  })
})

describe('overlay.close', () => {
  it('closes the named overlay, and refuses a payload with no name', () => {
    const overlays = { toggle: vi.fn(), close: vi.fn() }
    const ctx = context(overlays)

    runChromeAction('overlay.close', { name: 'menu' }, ctx)
    runChromeAction('overlay.close', {}, ctx)
    runChromeAction('overlay.close', undefined, ctx)

    expect(overlays.close.mock.calls).toEqual([['menu']])
  })
})
