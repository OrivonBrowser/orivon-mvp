// Lays the window's views out again when its size changes, and keeps checking for a moment after, because the window
// manager reports a new size in steps: a layout read inside the event, or one turn after it, can still see the old
// size (window.ts, the 'resize' comment), and a view left at the old size is not corrected by any later event.
// No Electron import: the window is anything that emits those events and reports its content size.
import type { EventEmitter } from 'node:events'

/** The events after which the window's size can be new: its own resize, and the states that change it. */
export const SIZE_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const

/** How long after a size event the size is read again; each read that differs from the last layout lays out again. */
export const SETTLE_CHECKS_MS = [60, 250, 800] as const

export interface SizedWindow extends Pick<EventEmitter, 'on' | 'removeListener'> {
  isDestroyed: () => boolean
  getContentBounds: () => { width: number, height: number }
}

/** Starts the watch; the returned function stops it. `relayout` is the window's one layout. */
export function relayoutOnSizeChange (win: SizedWindow, relayout: () => void): () => void {
  let laidOutAt = ''
  let immediate: ReturnType<typeof setImmediate> | undefined
  let timers: Array<ReturnType<typeof setTimeout>> = []
  const sizeNow = (): string => {
    const { width, height } = win.getContentBounds()
    return `${String(width)}x${String(height)}`
  }
  const layOut = (): void => {
    if (win.isDestroyed()) return
    laidOutAt = sizeNow()
    relayout()
  }
  const clear = (): void => {
    if (immediate !== undefined) clearImmediate(immediate)
    immediate = undefined
    for (const timer of timers) clearTimeout(timer)
    timers = []
  }
  const changed = (): void => {
    clear()
    immediate = setImmediate(layOut)
    for (const ms of SETTLE_CHECKS_MS) {
      timers.push(setTimeout(() => { if (!win.isDestroyed() && sizeNow() !== laidOutAt) layOut() }, ms))
    }
  }
  for (const event of SIZE_EVENTS) win.on(event, changed)
  return () => {
    clear()
    for (const event of SIZE_EVENTS) win.removeListener(event, changed)
  }
}
