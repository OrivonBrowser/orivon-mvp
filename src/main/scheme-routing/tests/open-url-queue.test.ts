import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_PENDING_PER_APP, OpenUrlQueue, PENDING_LIFETIME_MS } from '../open-url-queue.js'

const APP = 'https://torrent.example'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('OpenUrlQueue', () => {
  it('holds a link until the page asks, then gives it once', async () => {
    const queue = new OpenUrlQueue()
    queue.push(APP, 'magnet:one')
    expect(await queue.next(APP, 1000)).toBe('magnet:one')
    const second = queue.next(APP, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await second).toBeNull()
  })

  it('gives held links in the order they were routed', async () => {
    const queue = new OpenUrlQueue()
    queue.push(APP, 'a')
    queue.push(APP, 'b')
    expect(await queue.next(APP, 10)).toBe('a')
    expect(await queue.next(APP, 10)).toBe('b')
  })

  it('hands a link straight to a page that is already waiting', async () => {
    const queue = new OpenUrlQueue()
    const waiting = queue.next(APP, 10_000)
    queue.push(APP, 'magnet:now')
    expect(await waiting).toBe('magnet:now')
    expect(queue.pending(APP)).toBe(0)
  })

  it('keeps one app\'s links from another app', async () => {
    const queue = new OpenUrlQueue()
    queue.push(APP, 'for-torrent')
    const other = queue.next('https://other.example', 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await other).toBeNull()
    expect(await queue.next(APP, 10)).toBe('for-torrent')
  })

  it('stops waiting when the page that asked is gone, and loses no link to it', async () => {
    const queue = new OpenUrlQueue()
    const gone = new AbortController()
    const waiting = queue.next(APP, 10_000, gone.signal)
    gone.abort()
    expect(await waiting).toBeNull()
    queue.push(APP, 'magnet:kept')
    expect(queue.pending(APP)).toBe(1)
    expect(await queue.next(APP, 10)).toBe('magnet:kept')
  })

  it('answers null at once for a page that was already gone', async () => {
    const queue = new OpenUrlQueue()
    const gone = new AbortController()
    gone.abort()
    expect(await queue.next(APP, 10_000, gone.signal)).toBeNull()
  })

  it('drops the oldest link past the bound, so an app that never listens holds a few', async () => {
    const queue = new OpenUrlQueue()
    for (let i = 0; i < MAX_PENDING_PER_APP + 3; i += 1) queue.push(APP, `link-${String(i)}`)
    expect(queue.pending(APP)).toBe(MAX_PENDING_PER_APP)
    expect(await queue.next(APP, 10)).toBe('link-3')
  })

  it('drops a link nobody took within its lifetime', async () => {
    let now = 1_000
    const queue = new OpenUrlQueue(() => now)
    queue.push(APP, 'stale')
    now += PENDING_LIFETIME_MS + 1
    queue.push(APP, 'fresh')
    expect(queue.pending(APP)).toBe(1)
    expect(await queue.next(APP, 10)).toBe('fresh')
  })
})
