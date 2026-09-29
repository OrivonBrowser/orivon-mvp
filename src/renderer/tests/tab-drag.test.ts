import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEAR_DISTANCE_PX, dropIndex, isTornOut } from '../tab-drag.js'
import type { TabDragHost } from '../tab-drag.js'

describe('dropIndex', () => {
  it('counts the tabs whose centre the pointer has passed', () => {
    const centres = [50, 150, 250]
    expect(dropIndex(centres, 10)).toBe(0)
    expect(dropIndex(centres, 100)).toBe(1)
    expect(dropIndex(centres, 200)).toBe(2)
    expect(dropIndex(centres, 900)).toBe(3)
  })

  it('is zero when there are no other tabs', () => {
    expect(dropIndex([], 500)).toBe(0)
  })
})

describe('isTornOut', () => {
  const view = { width: 1000, stripHeight: 36 }

  it('is not while the pointer stays near the strip', () => {
    expect(isTornOut({ x: 500, y: 18 }, view)).toBe(false)
    expect(isTornOut({ x: 500, y: 36 + TEAR_DISTANCE_PX }, view)).toBe(false)
    expect(isTornOut({ x: 500, y: -TEAR_DISTANCE_PX }, view)).toBe(false)
  })

  it('is once it is well below or above the strip, or outside the window', () => {
    expect(isTornOut({ x: 500, y: 36 + TEAR_DISTANCE_PX + 1 }, view)).toBe(true)
    expect(isTornOut({ x: 500, y: -TEAR_DISTANCE_PX - 1 }, view)).toBe(true)
    expect(isTornOut({ x: -1, y: 10 }, view)).toBe(true)
    expect(isTornOut({ x: 1001, y: 10 }, view)).toBe(true)
  })
})

describe('a tab held by the pointer', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

  type Handler = (event: Record<string, unknown>) => void
  function fakeTab (): { el: HTMLElement, fire: (type: string, event?: Record<string, unknown>) => void } {
    const handlers = new Map<string, Handler[]>()
    const el = {
      addEventListener: (type: string, handler: Handler) => { handlers.set(type, [...(handlers.get(type) ?? []), handler]) },
      getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
      style: {}
    }
    return { el: el as unknown as HTMLElement, fire: (type, event = {}) => { for (const handler of handlers.get(type) ?? []) handler({ button: 0, target: { closest: () => null }, pointerId: 1, clientX: 10, clientY: 10, ...event }) } }
  }
  const host = (finished: () => void): TabDragHost => ({ tabs: () => [], partnerOf: () => null, stripHeight: () => 36, moveTab: vi.fn(), dragStarted: vi.fn(), hover: vi.fn(), dropTab: vi.fn(), finished, dragEnded: vi.fn() })

  it('listens for Escape once, however many tabs the strip has drawn', async () => {
    const added: string[] = []
    vi.stubGlobal('window', { addEventListener: (type: string) => { added.push(type) }, innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')

    for (let drawn = 0; drawn < 50; drawn += 1) makeTabDraggable(fakeTab().el, `tab-${String(drawn)}`, host(vi.fn()))

    expect(added.filter((type) => type === 'keydown')).toHaveLength(1)
  })

  it('keeps the strip from being redrawn between the press and the click, and redraws once the click is through', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable, isDraggingTab } = await import('../tab-drag.js')
    const finished = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', host(finished))

    tab.fire('pointerdown')
    expect(isDraggingTab()).toBe(true)
    tab.fire('pointerup')
    expect(isDraggingTab()).toBe(false)
    expect(finished).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(finished).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('tells the host a genuine drag has begun once the press moves past the threshold, not on a plain press', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')
    const dragStarted = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', { ...host(vi.fn()), dragStarted })

    tab.fire('pointerdown')
    expect(dragStarted).not.toHaveBeenCalled()
    tab.fire('pointermove', { clientX: 30, clientY: 10 })
    expect(dragStarted).toHaveBeenCalledExactlyOnceWith('tab-1')
  })

  it('gives main a point only once the tab is torn out, matching the .torn class', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')
    const hover = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', { ...host(vi.fn()), hover })

    tab.fire('pointerdown')
    tab.fire('pointermove', { clientX: 30, clientY: 10 }) // begins the drag, still well inside the strip
    expect(hover).toHaveBeenLastCalledWith('tab-1')

    const tornY = 36 + TEAR_DISTANCE_PX + 5
    tab.fire('pointermove', { clientX: 30, clientY: tornY })
    expect(hover).toHaveBeenLastCalledWith('tab-1', 30, tornY)
  })

  it('calls dragEnded once the drag is over, never merely on an in-strip move', async () => {
    // An in-strip pointermove sends hover(id) with no coordinates too (the case above), the exact
    // same shape as a drag actually ending inside the strip -- dragEnded is what a listener
    // relying on "the drag is really over" (releasing a started capture, say) has to use instead.
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')
    const dragEnded = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', { ...host(vi.fn()), dragEnded })

    tab.fire('pointerdown')
    tab.fire('pointermove', { clientX: 30, clientY: 10 }) // begins the drag
    expect(dragEnded).not.toHaveBeenCalled()
    tab.fire('pointermove', { clientX: 45, clientY: 10 }) // another in-strip move
    expect(dragEnded).not.toHaveBeenCalled()

    tab.fire('pointerup', { clientX: 45, clientY: 10 })
    expect(dragEnded).toHaveBeenCalledOnce()
  })

  it('calls dragEnded on a pointercancel as well', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')
    const dragEnded = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', { ...host(vi.fn()), dragEnded })

    tab.fire('pointerdown')
    tab.fire('pointermove', { clientX: 30, clientY: 10 })
    tab.fire('pointercancel')
    expect(dragEnded).toHaveBeenCalledOnce()
  })

  it('never calls dragEnded for a plain click that never became a drag', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), innerWidth: 800 })
    const { makeTabDraggable } = await import('../tab-drag.js')
    const dragEnded = vi.fn()
    const tab = fakeTab()
    makeTabDraggable(tab.el, 'tab-1', { ...host(vi.fn()), dragEnded })

    tab.fire('pointerdown')
    tab.fire('pointerup')
    expect(dragEnded).not.toHaveBeenCalled()
  })
})
