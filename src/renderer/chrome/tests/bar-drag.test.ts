import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BAR_DRAG_THRESHOLD_PX, isDraggingBarItem, makeBarDraggable } from '../bar-drag.js'
import type { BarDragHost } from '../bar-drag.js'

type Handler = (event: Record<string, unknown>) => void

function fakeItem () {
  const handlers = new Map<string, Handler[]>()
  const classes = new Set<string>()
  const el = {
    addEventListener: (type: string, handler: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), handler]) },
    removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }),
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) }
  }
  const fire = (type: string, event: Record<string, unknown> = {}): void => { for (const handler of handlers.get(type) ?? []) handler(event) }
  return { el: el as unknown as HTMLElement, fire, classes }
}

describe('dragging a bar item', () => {
  let reorder: ReturnType<typeof vi.fn>
  let host: BarDragHost
  beforeEach(() => {
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    reorder = vi.fn()
    const mark = { hidden: true, style: {}, offsetParent: null }
    host = {
      items: () => [],
      mark: () => mark as unknown as HTMLElement,
      idOf: () => 'a',
      isFolder: () => false,
      reorder: reorder as unknown as BarDragHost['reorder'],
      fileInto: vi.fn()
    }
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('starts a drag once the pointer has moved past the threshold with the button down', () => {
    const { el, fire, classes } = fakeItem()
    makeBarDraggable(el, host)
    fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fire('pointermove', { buttons: 1, clientX: 10 + BAR_DRAG_THRESHOLD_PX + 1, clientY: 10 })
    expect(classes.has('dragging')).toBe(true)
    expect(isDraggingBarItem()).toBe(true)
    fire('pointerup', {})
    expect(isDraggingBarItem()).toBe(false)
  })

  it('does not start a drag from a hover after a press that was let go elsewhere', () => {
    const { el, fire, classes } = fakeItem()
    makeBarDraggable(el, host)
    fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fire('pointermove', { buttons: 1, clientX: 11, clientY: 10 })
    // The pointer left and the button went up outside: this item never saw the release.
    fire('pointermove', { buttons: 0, clientX: 60, clientY: 10 })
    expect(classes.has('dragging')).toBe(false)
    expect(isDraggingBarItem()).toBe(false)
    fire('pointermove', { buttons: 0, clientX: 90, clientY: 10 })
    expect(isDraggingBarItem()).toBe(false)
  })

  it('ends a drag whose button was released out of sight, without reordering', () => {
    const { el, fire } = fakeItem()
    makeBarDraggable(el, host)
    fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    fire('pointermove', { buttons: 1, clientX: 40, clientY: 10 })
    expect(isDraggingBarItem()).toBe(true)
    fire('pointermove', { buttons: 0, clientX: 45, clientY: 10 })
    expect(isDraggingBarItem()).toBe(false)
    expect(reorder).not.toHaveBeenCalled()
  })
})
