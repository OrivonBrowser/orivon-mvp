// The session a caller in main reads through a pinned endpoint.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasOwnProxy } from '../../own-proxy.js'
import { pinnedEndpoint } from '../pinned-endpoint.js'
import type { PinnedEndpoint } from '../pinned-endpoint.js'
import { PINNED_PARTITION, sessionThrough } from '../pinned-session.js'

const endpoints: PinnedEndpoint[] = []
afterEach(async () => { for (const endpoint of endpoints.splice(0)) await endpoint.close() })

async function endpoint (): Promise<PinnedEndpoint> {
  const made = await pinnedEndpoint({ systemAnswer: async () => 'DIRECT' })
  endpoints.push(made)
  return made
}

const fakeSession = (): { setProxy: ReturnType<typeof vi.fn> } => ({ setProxy: vi.fn(async () => {}) })

describe('the session a pinned endpoint is read through', () => {
  it('is made in memory, left alone by the shared identity, and set to the endpoint\'s config before it is handed back', async () => {
    const pinned = await endpoint()
    const session = fakeSession()
    const makeSession = vi.fn((_partition: string) => session)
    expect(await sessionThrough(pinned, makeSession)).toBe(session)
    expect(makeSession).toHaveBeenCalledExactlyOnceWith(PINNED_PARTITION)
    expect(PINNED_PARTITION.startsWith('persist:')).toBe(false)
    expect(hasOwnProxy(session)).toBe(true)
    expect(session.setProxy).toHaveBeenCalledExactlyOnceWith(pinned.config)
  })

  it('is one per endpoint, however many callers ask at once', async () => {
    const pinned = await endpoint()
    const makeSession = vi.fn((_partition: string) => fakeSession())
    const [first, second] = await Promise.all([sessionThrough(pinned, makeSession), sessionThrough(pinned, makeSession)])
    expect(second).toBe(first)
    expect(await sessionThrough(pinned, makeSession)).toBe(first)
    expect(makeSession).toHaveBeenCalledOnce()
  })

  it('is set again to an endpoint that was started afresh, on its new port', async () => {
    const one = await endpoint()
    const two = await endpoint()
    const session = fakeSession()
    await sessionThrough(one, () => session)
    await sessionThrough(two, () => session)
    expect(session.setProxy.mock.calls).toEqual([[one.config], [two.config]])
  })

  it('is made again by the next caller when it could not be set', async () => {
    const pinned = await endpoint()
    const broken = { setProxy: vi.fn(async () => { throw new Error('no proxy set') }) }
    await expect(sessionThrough(pinned, () => broken)).rejects.toThrow('no proxy set')
    const good = fakeSession()
    expect(await sessionThrough(pinned, () => good)).toBe(good)
  })
})
