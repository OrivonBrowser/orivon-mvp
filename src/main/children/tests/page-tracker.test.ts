import { describe, expect, it, vi } from 'vitest'
import { createPageTracker } from '../page-tracker.js'

describe('createPageTracker', () => {
  it('counts pages opened and closed at one origin', () => {
    const tracker = createPageTracker()
    expect(tracker.countAt('https://a.example')).toBe(0)
    tracker.recordPageOpened('https://a.example')
    expect(tracker.countAt('https://a.example')).toBe(1)
    tracker.recordPageOpened('https://a.example')
    expect(tracker.countAt('https://a.example')).toBe(2)
    tracker.recordPageClosed('https://a.example')
    expect(tracker.countAt('https://a.example')).toBe(1)
  })

  it('fires onceEmpty only once the LAST page at that origin closes', () => {
    const tracker = createPageTracker()
    const onEmpty = vi.fn()
    tracker.recordPageOpened('https://a.example')
    tracker.recordPageOpened('https://a.example')
    tracker.onceEmpty('https://a.example', onEmpty)

    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).not.toHaveBeenCalled()

    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).toHaveBeenCalledOnce()
    expect(tracker.countAt('https://a.example')).toBe(0)
  })

  it('never fires for an origin already at zero when subscribed', () => {
    const tracker = createPageTracker()
    const onEmpty = vi.fn()
    tracker.onceEmpty('https://a.example', onEmpty)
    tracker.recordPageOpened('https://a.example')
    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('is one-shot: a second empty crossing does not fire the same listener again', () => {
    const tracker = createPageTracker()
    const onEmpty = vi.fn()
    tracker.recordPageOpened('https://a.example')
    tracker.onceEmpty('https://a.example', onEmpty)
    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).toHaveBeenCalledOnce()

    tracker.recordPageOpened('https://a.example')
    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).toHaveBeenCalledOnce()
  })

  it('unsubscribing stops the listener from firing', () => {
    const tracker = createPageTracker()
    const onEmpty = vi.fn()
    tracker.recordPageOpened('https://a.example')
    const unsubscribe = tracker.onceEmpty('https://a.example', onEmpty)
    unsubscribe()
    tracker.recordPageClosed('https://a.example')
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('keeps origins independent', () => {
    const tracker = createPageTracker()
    const onEmptyA = vi.fn()
    tracker.recordPageOpened('https://a.example')
    tracker.recordPageOpened('https://b.example')
    tracker.onceEmpty('https://a.example', onEmptyA)
    tracker.recordPageClosed('https://b.example')
    expect(onEmptyA).not.toHaveBeenCalled()
    expect(tracker.countAt('https://a.example')).toBe(1)
  })
})
