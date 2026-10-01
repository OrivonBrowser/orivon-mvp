import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { throttleChanges } from '../change-throttle.js'
import type { DownloadEntry } from '../download-types.js'

const entry = (id: string, received: number): DownloadEntry => ({
  id, url: 'https://a.example/f', referrer: '', fileName: 'f', savePath: '/d/f', mime: '', total: 10, received, state: 'progressing', startedAt: 0, danger: false
})

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('throttleChanges', () => {
  it('sends the first change at once and folds the rest of a burst into one', () => {
    const send = vi.fn()
    const push = throttleChanges(send, 250)
    push(entry('a', 1))
    push(entry('a', 2))
    push(entry('a', 3))
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(entry('a', 3))
  })

  it('turns changes to different downloads into "the list changed"', () => {
    const send = vi.fn()
    const push = throttleChanges(send, 250)
    push(entry('a', 1))
    push(entry('a', 2))
    push(entry('b', 1))
    vi.advanceTimersByTime(250)
    expect(send).toHaveBeenLastCalledWith(null)
  })

  it('lets a change through at once after a quiet interval', () => {
    const send = vi.fn()
    const push = throttleChanges(send, 250)
    push(null)
    vi.advanceTimersByTime(1000)
    push(entry('a', 1))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('sends nothing after it is cancelled, and starts afresh when a change comes later', () => {
    const send = vi.fn()
    const push = throttleChanges(send, 250)
    push(entry('a', 1))
    push(entry('a', 2))
    push.cancel()
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(1)
    push(entry('a', 3))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(entry('a', 3))
  })

  it('keeps a null over an entry that follows it', () => {
    const send = vi.fn()
    const push = throttleChanges(send, 250)
    push(entry('a', 1))
    push(null)
    push(entry('a', 2))
    vi.advanceTimersByTime(250)
    expect(send).toHaveBeenLastCalledWith(null)
  })
})
