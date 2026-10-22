import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstContact } from '../first-contact.js'

const WAIT_MS = 3_000
const WARM_MS = 120_000

/** Whether `promise` has settled yet, after letting every already-due timer and microtask run. */
async function settled (promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('FirstContact', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = (): FirstContact => new FirstContact({ waitMs: WAIT_MS, warmMs: WARM_MS })

  it('lets the first request to a host go on at once, and holds the others until its connection is made', async () => {
    const contact = make()
    expect(await settled(contact.enter('pic.eth', 1))).toBe(true)
    const second = contact.enter('pic.eth', 2)
    const third = contact.enter('pic.eth', 3)
    expect(await settled(second)).toBe(false)
    expect(await settled(third)).toBe(false)
    contact.reached('pic.eth')
    expect(await settled(second)).toBe(true)
    expect(await settled(third)).toBe(true)
  })

  it('keeps one host from holding another', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    expect(await settled(contact.enter('other.eth', 2))).toBe(true)
  })

  it('lets every request go on at once once the host has been reached', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    contact.reached('pic.eth')
    expect(await settled(contact.enter('pic.eth', 2))).toBe(true)
    expect(await settled(contact.enter('pic.eth', 3))).toBe(true)
  })

  it('goes back to holding after the connection it made is old enough that a new one would be verified again', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    contact.reached('pic.eth')
    await vi.advanceTimersByTimeAsync(WARM_MS - 1)
    expect(await settled(contact.enter('pic.eth', 2))).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(contact.enter('pic.eth', 3))).toBe(true)
    const next = contact.enter('pic.eth', 4)
    expect(await settled(next)).toBe(false)
    contact.reached('pic.eth')
    expect(await settled(next)).toBe(true)
  })

  it('does not hold the request that is the one being waited for, when it comes round again after a redirect', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    expect(await settled(contact.enter('pic.eth', 1))).toBe(true)
  })

  it('hands the lead to one waiting request when the first ends without a connection', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    const second = contact.enter('pic.eth', 2)
    const third = contact.enter('pic.eth', 3)
    contact.ended('pic.eth', 1)
    expect(await settled(second)).toBe(true)
    expect(await settled(third)).toBe(false)
    contact.reached('pic.eth')
    expect(await settled(third)).toBe(true)
  })

  it('ignores the end of a request that is not the one being waited for', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    const second = contact.enter('pic.eth', 2)
    contact.ended('pic.eth', 2)
    expect(await settled(second)).toBe(false)
  })

  it('stops holding after the bound, and does not hold that host again until a later first connection', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    const second = contact.enter('pic.eth', 2)
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1)
    expect(await settled(second)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(second)).toBe(true)
    expect(await settled(contact.enter('pic.eth', 3))).toBe(true)
  })

  it('counts the bound from the first request, not from each waiting one', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    await vi.advanceTimersByTimeAsync(WAIT_MS - 10)
    const late = contact.enter('pic.eth', 2)
    await vi.advanceTimersByTimeAsync(10)
    expect(await settled(late)).toBe(true)
  })

  it('forgets everything on reset: held requests go on and the next one to a host leads again', async () => {
    const contact = make()
    await contact.enter('pic.eth', 1)
    contact.reached('pic.eth')
    contact.reset()
    const second = contact.enter('pic.eth', 2)
    expect(await settled(second)).toBe(true)
    const third = contact.enter('pic.eth', 3)
    expect(await settled(third)).toBe(false)
    contact.reset()
    expect(await settled(third)).toBe(true)
  })
})
