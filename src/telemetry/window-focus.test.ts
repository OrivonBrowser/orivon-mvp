import { describe, expect, it } from 'vitest'
import { reconcileWindowFocus, type TrackedWindow } from './window-focus.js'

describe('reconcileWindowFocus', () => {
  it('reports "gained-focus" the first time any window is focused', () => {
    const windows: TrackedWindow[] = [{ id: 1, focused: true }]
    const result = reconcileWindowFocus(new Set(), windows)
    expect(result.transition).toBe('gained-focus')
    expect(result.nextFocusedIds).toEqual(new Set([1]))
  })

  it('reports "unchanged" while the same window stays focused', () => {
    const windows: TrackedWindow[] = [{ id: 1, focused: true }]
    const result = reconcileWindowFocus(new Set([1]), windows)
    expect(result.transition).toBe('unchanged')
    expect(result.nextFocusedIds).toEqual(new Set([1]))
  })

  it('reports "lost-focus" when the only focused window blurs', () => {
    const windows: TrackedWindow[] = [{ id: 1, focused: false }]
    const result = reconcileWindowFocus(new Set([1]), windows)
    expect(result.transition).toBe('lost-focus')
    expect(result.nextFocusedIds).toEqual(new Set())
  })

  it('reports "unchanged" when no window was focused and none is now', () => {
    const windows: TrackedWindow[] = [{ id: 1, focused: false }, { id: 2, focused: false }]
    const result = reconcileWindowFocus(new Set(), windows)
    expect(result.transition).toBe('unchanged')
  })

  it('does not report "lost-focus" while a second window keeps the shell focused -- A16 reopens a new window, closing the old one must not blur the whole shell if a new one already has focus', () => {
    const windows: TrackedWindow[] = [{ id: 1, focused: false }, { id: 2, focused: true }]
    const result = reconcileWindowFocus(new Set([1]), windows)
    expect(result.transition).toBe('unchanged')
    expect(result.nextFocusedIds).toEqual(new Set([2]))
  })

  it('a window that closed and disappeared from the list is simply dropped, not treated as a blur event on its own', () => {
    // id 1 is gone entirely (closed) but id 2 was already focused -- still "unchanged".
    const windows: TrackedWindow[] = [{ id: 2, focused: true }]
    const result = reconcileWindowFocus(new Set([1, 2]), windows)
    expect(result.transition).toBe('unchanged')
    expect(result.nextFocusedIds).toEqual(new Set([2]))
  })

  it('closing the last focused window (list becomes empty) is "lost-focus"', () => {
    const result = reconcileWindowFocus(new Set([1]), [])
    expect(result.transition).toBe('lost-focus')
    expect(result.nextFocusedIds).toEqual(new Set())
  })

  it('empty to empty is "unchanged"', () => {
    const result = reconcileWindowFocus(new Set(), [])
    expect(result.transition).toBe('unchanged')
    expect(result.nextFocusedIds).toEqual(new Set())
  })
})
