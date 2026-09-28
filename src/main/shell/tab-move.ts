// Moving a tab between windows. The tab is the same page throughout, with its
// history, scroll and state: its view is taken out of one window and shown in
// another. Never moves a tab out of a window where a page holds the screen.
import type { ShellWindow } from './window-registry.js'
import type { Placement, ShellWindowOptions } from './window-options.js'

/** True when the tab is now in `to`. `index` is where in its strip; the end by default. */
export function moveToWindow (from: ShellWindow, id: string, to: ShellWindow, index?: number): boolean {
  if (from === to || from.shortcutsSuspended() || !to.tabs.hasRoom()) return false
  const record = from.tabs.takeTab(id)
  if (record === null) return false
  to.tabs.giveTab(id, record, index)
  // A window that gave away its last tab has nothing left to show.
  if (from.tabs.tabCount === 0 && !from.window.isDestroyed()) from.window.close()
  if (!to.window.isDestroyed()) to.window.focus()
  return true
}

/** Opens a window for the tab. A window's only tab stays where it is: moving it would only move the window. */
export function moveToNewWindow (from: ShellWindow, id: string, openWindow: (options: ShellWindowOptions) => void, place?: Placement): boolean {
  if (from.tabs.tabCount < 2 || from.shortcutsSuspended()) return false
  openWindow({
    ...(place === undefined ? {} : { place }),
    first: (tabs) => {
      const record = from.tabs.takeTab(id)
      // Gone since it was asked for: the window still opens on a page.
      if (record === null) tabs.createTab()
      else tabs.giveTab(id, record)
    }
  })
  return true
}

interface Point { readonly x: number, readonly y: number }
interface Rect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** Whether a point of the screen is within a window's top `height` pixels: its tab strip and toolbar. */
function inTop (bounds: Rect, point: Point, height: number): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + height
}

/** A tab was let go outside its own strip, at `point` (screen coordinates): into another window's
 * strip if that is where it landed, else a window of its own under the pointer. */
export function dropTab (
  from: ShellWindow,
  id: string,
  point: Point,
  windows: readonly ShellWindow[],
  openWindow: (options: ShellWindowOptions) => void,
  topHeight: number
): void {
  // Nothing says which of overlapping windows is in front; the newest is the likeliest.
  const target = windows.filter((candidate) => candidate !== from && !candidate.window.isDestroyed() && inTop(candidate.window.getBounds(), point, topHeight)).at(-1)
  if (target !== undefined) {
    const bounds = target.window.getBounds()
    // Where along the strip it landed, as a share of the tabs there: the strip's own layout is the chrome's.
    moveToWindow(from, id, target, Math.round(((point.x - bounds.x) / bounds.width) * target.tabs.tabCount))
    return
  }
  const own = from.window.getBounds()
  if (inTop(own, point, topHeight)) return
  moveToNewWindow(from, id, openWindow, { x: Math.round(point.x - 120), y: Math.round(point.y - 16), width: own.width, height: own.height })
}
