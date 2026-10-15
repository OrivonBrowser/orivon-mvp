import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relayoutOnSizeChange, SETTLE_CHECKS_MS, SIZE_EVENTS } from '../window-size-settle.js'

class FakeWindow extends EventEmitter {
  size = { width: 1280, height: 800 }
  destroyed = false
  isDestroyed (): boolean { return this.destroyed }
  getContentBounds (): { width: number, height: number } { return this.size }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('relayoutOnSizeChange', () => {
  it('lays out once the turn after a size event, and again when the size was still the old one then', () => {
    const win = new FakeWindow()
    const seen: string[] = []
    relayoutOnSizeChange(win, () => { seen.push(`${String(win.size.width)}x${String(win.size.height)}`) })
    win.emit('maximize')
    // The window manager has not yet reported the new size when the layout runs.
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['1280x800'])
    win.size = { width: 1920, height: 1080 }
    vi.advanceTimersByTime(SETTLE_CHECKS_MS[0])
    expect(seen).toEqual(['1280x800', '1920x1080'])
  })

  it('does not lay out again when the size did not move after the first layout', () => {
    const win = new FakeWindow()
    const relayout = vi.fn()
    relayoutOnSizeChange(win, relayout)
    win.emit('resize')
    vi.advanceTimersByTime(Math.max(...SETTLE_CHECKS_MS) + 10)
    expect(relayout).toHaveBeenCalledTimes(1)
  })

  it('answers every event that can change the size', () => {
    const win = new FakeWindow()
    const relayout = vi.fn()
    relayoutOnSizeChange(win, relayout)
    for (const event of SIZE_EVENTS) {
      win.emit(event)
      vi.advanceTimersByTime(1)
    }
    expect(relayout).toHaveBeenCalledTimes(SIZE_EVENTS.length)
  })

  it('starts the checks over on each event, so a burst of resizes leaves one set of timers', () => {
    const win = new FakeWindow()
    const relayout = vi.fn()
    relayoutOnSizeChange(win, relayout)
    for (let i = 0; i < 5; i += 1) win.emit('resize')
    vi.advanceTimersByTime(1)
    expect(relayout).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a destroyed window, and nothing after it is stopped', () => {
    const win = new FakeWindow()
    const relayout = vi.fn()
    const stop = relayoutOnSizeChange(win, relayout)
    win.emit('resize')
    win.destroyed = true
    vi.advanceTimersByTime(2_000)
    expect(relayout).not.toHaveBeenCalled()
    win.destroyed = false
    stop()
    win.emit('resize')
    vi.advanceTimersByTime(2_000)
    expect(relayout).not.toHaveBeenCalled()
    expect(win.listenerCount('resize')).toBe(0)
  })
})
