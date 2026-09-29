import { describe, expect, it, vi } from 'vitest'
import { makeStripDraggable } from '../strip-drag.js'
import type { StripDragHost } from '../strip-drag.js'

type Handler = (event: Record<string, unknown>) => void

function fakeTail (): { el: HTMLElement, fire: (type: string, event?: Record<string, unknown>) => void } {
  const handlers = new Map<string, Handler[]>()
  const el = {
    addEventListener: (type: string, handler: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), handler]) },
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn()
  }
  return {
    el: el as unknown as HTMLElement,
    fire: (type, event = {}) => { for (const handler of handlers.get(type) ?? []) handler({ button: 0, pointerId: 1, screenX: 100, screenY: 100, ...event }) }
  }
}

function fakeHost (): StripDragHost & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { newTab: [], toggleMaximize: [], moveStart: [], moveTo: [], moveEnd: [], moveCancel: [] }
  return {
    calls,
    newTab: (...args) => { calls['newTab']?.push(args) },
    toggleMaximize: (...args) => { calls['toggleMaximize']?.push(args) },
    moveStart: (...args) => { calls['moveStart']?.push(args) },
    moveTo: (...args) => { calls['moveTo']?.push(args) },
    moveEnd: (...args) => { calls['moveEnd']?.push(args) },
    moveCancel: (...args) => { calls['moveCancel']?.push(args) }
  }
}

describe('makeStripDraggable', () => {
  it('opens a new tab on a middle click, and prevents the default autoscroll arm on mousedown', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    const preventDefault = vi.fn()
    tail.fire('mousedown', { button: 1, preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    tail.fire('auxclick', { button: 1, preventDefault: vi.fn() })
    expect(host.calls['newTab']).toHaveLength(1)
  })

  it('ignores a middle auxclick\'s sibling: a left double click toggles maximize instead', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    tail.fire('dblclick', { button: 0 })
    expect(host.calls['toggleMaximize']).toHaveLength(1)
    expect(host.calls['newTab']).toHaveLength(0)
  })

  it('starts a window move once the press moves past the threshold, in screen coordinates', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    tail.fire('pointerdown', { screenX: 100, screenY: 100 })
    expect(host.calls['moveStart']).toHaveLength(0)

    tail.fire('pointermove', { screenX: 101, screenY: 100 }) // under the threshold
    expect(host.calls['moveStart']).toHaveLength(0)

    tail.fire('pointermove', { screenX: 120, screenY: 100 })
    expect(host.calls['moveStart']).toEqual([[100, 100]])
    expect(host.calls['moveTo']).toEqual([[120, 100]])

    tail.fire('pointerup', { screenX: 130, screenY: 100 })
    expect(host.calls['moveEnd']).toEqual([[130, 100]])
  })

  it('never starts a move for a plain click that never crosses the threshold', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    tail.fire('pointerdown', { screenX: 100, screenY: 100 })
    tail.fire('pointerup', { screenX: 100, screenY: 100 })
    expect(host.calls['moveStart']).toHaveLength(0)
    expect(host.calls['moveEnd']).toHaveLength(0)
  })

  it('a pointercancel during a move ends it without any edge-snap action, even at 0,0', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    tail.fire('pointerdown', { screenX: 100, screenY: 100 })
    tail.fire('pointermove', { screenX: 120, screenY: 100 })
    expect(host.calls['moveStart']).toHaveLength(1)

    // A real pointercancel's own coordinates, nowhere the pointer actually was.
    tail.fire('pointercancel', { screenX: 0, screenY: 0 })
    expect(host.calls['moveCancel']).toHaveLength(1)
    expect(host.calls['moveEnd']).toHaveLength(0)
  })

  it('a pointercancel before any move crossed the threshold calls nothing', () => {
    const tail = fakeTail()
    const host = fakeHost()
    makeStripDraggable(tail.el, host)

    tail.fire('pointerdown', { screenX: 100, screenY: 100 })
    tail.fire('pointercancel', { screenX: 0, screenY: 0 })
    expect(host.calls['moveCancel']).toHaveLength(0)
    expect(host.calls['moveEnd']).toHaveLength(0)
  })
})
