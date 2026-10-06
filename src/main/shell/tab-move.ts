// Moving a tab between windows. The tab is the same page throughout, with its
// history, scroll and state: its view is taken out of one window and shown in
// another. Never moves a tab out of a window where a page holds the screen.
import { stripCentresFor } from './strip-centres.js'
import { clampToRun, dropIndex } from './tab-order.js'
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

/** Opens a window for the tab. A window's only tab stays where it is: moving it would only move the window.
 * Like every window opened in front after the launch's first, it is shown at once (window-frame.ts's
 * `showWhenReady`). */
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

export interface Point { readonly x: number, readonly y: number }
export interface Rect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** Whether a point of the screen is within a window's top `height` pixels: its tab strip and toolbar.
 * Exported for tear-drag.ts's own use: the floating preview hides there too, so what it shows matches
 * what letting go there does (nothing). */
export function inTop (bounds: Rect, point: Point, height: number): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + height
}

/** The other window a dragged tab is over, and where in its strip it would land, or `null` when the point is
 * over no window's strip but its own. Shared by `dropTab` below (the actual move) and the floating preview's
 * own cross-window mark (`tear-drag.ts`), so the place the mark is drawn at is always the place a drop right
 * now would use. The place is the number of the strip's tabs whose centre is left of the point, as the strip's
 * own drag counts it. Without the centres of the tabs now in that strip (`strip-centres.ts`), the point's share
 * of the window's width stands in for them. */
export function crossWindowTargetFor (
  from: ShellWindow,
  point: Point,
  windows: readonly ShellWindow[],
  topHeight: number,
  pinned = false
): { window: ShellWindow, index: number } | null {
  // Nothing says which of overlapping windows is in front; the newest is the likeliest.
  const target = windows.filter((candidate) => candidate !== from && !candidate.window.isDestroyed() && inTop(candidate.window.getBounds(), point, topHeight)).at(-1)
  if (target === undefined) return null
  const bounds = target.window.getBounds()
  return { window: target, index: stripSlot(target, () => point.x - target.window.getContentBounds().x, (point.x - bounds.x) / bounds.width, pinned) }
}

/** The place in `target`'s strip for a tab let go `contentX()` pixels from the left of its content area: the number
 * of the strip's tabs whose centre is left of it. `share` (how far across the window, 0 to 1) stands in when the
 * centres of the tabs now in the strip are not known. A pinned tab lands in the pinned run, and any other outside
 * it, as `giveTab` will place it. */
export function stripSlot (target: ShellWindow, contentX: () => number, share: number, pinned: boolean): number {
  const tabs = target.tabs.getState().tabs
  const centres = stripCentresFor(target)
  const wanted = centres === null ? Math.round(share * tabs.length) : dropIndex(centres, contentX())
  return clampToRun(wanted, pinned, tabs.filter((tab) => tab.pinned).length, tabs.length)
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
  const target = crossWindowTargetFor(from, point, windows, topHeight, from.tabs.record(id)?.pinned === true)
  if (target !== null) {
    moveToWindow(from, id, target.window, target.index)
    return
  }
  const own = from.window.getBounds()
  if (inTop(own, point, topHeight)) return
  moveToNewWindow(from, id, openWindow, { x: Math.round(point.x - 120), y: Math.round(point.y - 16), width: own.width, height: own.height })
}
