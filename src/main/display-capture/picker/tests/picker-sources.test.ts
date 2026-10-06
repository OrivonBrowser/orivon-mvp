import { describe, expect, it, vi } from 'vitest'
import { createSourceFeed, SOURCE_REFRESH_MS, sourceCard } from '../picker-sources.js'
import type { FeedTimers, RawSource } from '../picker-sources.js'

const raw = (id: string, name = id): RawSource => ({
  id, name, thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') }, appIcon: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' }
})

function timers (): FeedTimers & { fire: () => void, pending: () => number } {
  const queue = new Map<number, () => void>()
  let next = 0
  return {
    after: (run, ms) => {
      expect(ms).toBe(SOURCE_REFRESH_MS)
      const key = next++
      queue.set(key, run)
      return () => { queue.delete(key) }
    },
    fire: () => { for (const [key, run] of [...queue]) { queue.delete(key); run() } },
    pending: () => queue.size
  }
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('the source feed', () => {
  it('lists the watched type at once and again after each refresh interval', async () => {
    const t = timers()
    const getSources = vi.fn(async () => [raw('a')])
    const delivered = vi.fn()
    const feed = createSourceFeed(getSources, delivered, t)
    feed.watch('window')
    await settle()
    expect(getSources).toHaveBeenCalledTimes(1)
    expect(delivered).toHaveBeenCalledWith('window', [expect.objectContaining({ id: 'a' })])
    t.fire()
    await settle()
    expect(getSources).toHaveBeenCalledTimes(2)
  })

  it('never has two listings in flight, and waits the interval after one ends', async () => {
    const t = timers()
    let resolve: (value: RawSource[]) => void = () => {}
    const getSources = vi.fn(async () => await new Promise<RawSource[]>((r) => { resolve = r }))
    const feed = createSourceFeed(getSources, () => {}, t)
    feed.watch('screen')
    feed.watch('screen')
    expect(getSources).toHaveBeenCalledTimes(1)
    expect(t.pending()).toBe(0)
    resolve([])
    await settle()
    expect(t.pending()).toBe(1)
    expect(getSources).toHaveBeenCalledTimes(1)
  })

  it('drops the answer for a type no longer watched and lists the new one when the old listing ends', async () => {
    const t = timers()
    const resolvers: Array<(value: RawSource[]) => void> = []
    const getSources = vi.fn(async (_type: string) => await new Promise<RawSource[]>((r) => { resolvers.push(r) }))
    const delivered = vi.fn()
    const feed = createSourceFeed(getSources, delivered, t)
    feed.watch('window')
    feed.watch('screen')
    expect(getSources).toHaveBeenCalledTimes(1)
    resolvers[0]?.([raw('w')])
    await settle()
    expect(delivered).not.toHaveBeenCalled()
    expect(getSources).toHaveBeenLastCalledWith('screen')
    resolvers[1]?.([raw('s')])
    await settle()
    expect(delivered).toHaveBeenCalledWith('screen', [expect.objectContaining({ id: 's' })])
  })

  it('stops: nothing is listed or delivered afterwards, and no timer is left', async () => {
    const t = timers()
    const getSources = vi.fn(async () => [raw('a')])
    const delivered = vi.fn()
    const feed = createSourceFeed(getSources, delivered, t)
    feed.watch('window')
    await settle()
    feed.stop()
    expect(t.pending()).toBe(0)
    t.fire()
    await settle()
    expect(getSources).toHaveBeenCalledTimes(1)
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('delivers an empty list when a listing fails, and tries again', async () => {
    const t = timers()
    const getSources = vi.fn(async () => { throw new Error('Failed to get sources.') })
    const delivered = vi.fn()
    createSourceFeed(getSources, delivered, t).watch('window')
    await settle()
    expect(delivered).toHaveBeenCalledWith('window', [])
    expect(t.pending()).toBe(1)
  })
})

describe('sourceCard', () => {
  it('draws a source as a JPEG thumbnail and the window icon under the id main gave it', () => {
    const made = sourceCard(raw('window:1:0', 'My   window'), 'card1')
    expect(made).toMatchObject({ id: 'card1', label: 'My window', thumb: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`, icon: 'data:image/png;base64,AAAA', self: false })
  })

  it('has no thumbnail for an empty image and no icon for a missing one', () => {
    const made = sourceCard({ ...raw('s'), thumbnail: { isEmpty: () => true, toJPEG: () => { throw new Error('empty') } }, appIcon: null }, 'c')
    expect(made.thumb).toBeNull()
    expect(made.icon).toBeNull()
  })
})
