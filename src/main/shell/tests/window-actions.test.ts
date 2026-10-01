import { describe, expect, it, vi } from 'vitest'
import { shellActions } from '../window-actions.js'
import type { WindowParts } from '../window-actions.js'

/** A window fake standing in for X11's own behaviour: `unmaximize()` is asynchronous there, so
 * `getBounds()` called right after it still reports the maximized size, while `getNormalBounds()`
 * (queried before the request) already knows the restored one. */
function fakeMaximizedWindow (): { window: unknown, calls: string[] } {
  const calls: string[] = []
  const maximized = { x: 0, y: 0, width: 1920, height: 1080 }
  const normal = { x: 100, y: 80, width: 900, height: 600 }
  const window = {
    isMaximized: () => true,
    getNormalBounds: () => { calls.push('getNormalBounds'); return normal },
    unmaximize: () => { calls.push('unmaximize') },
    // Still the maximized size: the X11 behaviour this test exists to guard against.
    getBounds: () => { calls.push('getBounds'); return maximized },
    setPosition: vi.fn((x: number, y: number) => { calls.push(`setPosition:${String(x)},${String(y)}`) })
  }
  return { window, calls }
}

function makeParts (window: unknown): WindowParts {
  const entry = { window, chrome: {}, tabs: {}, overlays: {}, shortcutsSuspended: () => false }
  return {
    entry: entry as never,
    services: {} as never,
    panels: { permissions: { close: vi.fn() }, siteInfo: { close: vi.fn() } } as never,
    closeOverlays: vi.fn(),
    openWindow: vi.fn(),
    topHeight: 0,
    area: () => ({ x: 0, y: 0, width: 0, height: 0 })
  }
}

describe('shellActions windowMoveTo, restoring a maximized window on X11', () => {
  it('sizes the restore math from getNormalBounds, read before unmaximize is asked for', () => {
    const { window, calls } = fakeMaximizedWindow()
    const actions = shellActions(makeParts(window))

    // Grabbed at the horizontal midpoint of the maximized (1920-wide) window; the release is at
    // the same point, so the only question is which width the restore math used.
    actions.windowMoveStart({ x: 960, y: 20 })
    actions.windowMoveTo({ x: 960, y: 20 })

    // getBounds() is legitimate once, from windowMoveStart, while still maximized; getNormalBounds()
    // is read before unmaximize() is even asked for, and nothing reads getBounds() again after it --
    // never the stale answer a request still in flight on X11 would give for the maximized size.
    expect(calls.indexOf('getNormalBounds')).toBeLessThan(calls.indexOf('unmaximize'))
    expect(calls.lastIndexOf('getBounds')).toBeLessThan(calls.indexOf('unmaximize'))

    // The restored window is 900 wide; kept at the same horizontal share (here, the midpoint) of
    // that width, not the maximized window's 1920.
    const [x, y] = (window as { setPosition: ReturnType<typeof vi.fn> }).setPosition.mock.calls[0] as [number, number]
    expect(x).toBe(Math.round(960 - 900 * 0.5))
    expect(y).toBe(0) // dy from the grab (20 - 0) subtracted back off the same y the release used
  })
})

describe('shellActions openMenu', () => {
  it('toggles the menu under a rectangle of numbers, and ignores any other anchor', () => {
    const toggle = vi.fn()
    const parts = makeParts({})
    ;(parts.entry as unknown as { overlays: unknown }).overlays = { toggle }
    const actions = shellActions(parts)
    const anchor = { x: 900, y: 40, width: 30, height: 30 }
    actions.openMenu(anchor)
    expect(toggle).toHaveBeenCalledExactlyOnceWith('menu', anchor)
    for (const bad of [undefined, null, 'x', { x: Number.NaN, y: 1, width: 2, height: 3 }, { x: 1, y: 1, width: 2 }]) actions.openMenu(bad as never)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
