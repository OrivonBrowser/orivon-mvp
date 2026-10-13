import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcquireError, createInstances } from '../instances.js'
import type { InstancesSnapshot, Tunnel } from '../instances.js'

function fakeTunnel (log: string[], id: string): Tunnel {
  return {
    connectTcp: async () => { throw new Error('not used') },
    bindUdp: async () => { throw new Error('not used') },
    disconnect: async () => { log.push(`disconnect ${id}`) }
  }
}

interface Pending { readonly id: string, resolve: () => void, reject: (error: Error) => void }

function harness (options: { cap?: number, startWaitMs?: number, idleMs?: number } = {}) {
  const log: string[] = []
  const pending: Pending[] = []
  const snapshots: InstancesSnapshot[] = []
  const instances = createInstances({
    cap: options.cap ?? 2,
    startWaitMs: options.startWaitMs ?? 30_000,
    idleMs: options.idleMs ?? 600_000,
    onChange: (snapshot) => { snapshots.push(snapshot) },
    start: async (id) => {
      log.push(`start ${id}`)
      return await new Promise<Tunnel>((resolve, reject) => {
        pending.push({ id, resolve: () => { resolve(fakeTunnel(log, id)) }, reject })
      })
    }
  })
  return { instances, log, pending, snapshots }
}

describe('instances', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts a tunnel at the first request of a user name, and the request waits for it', async () => {
    const { instances, log, pending } = harness()
    let lease
    const asked = instances.acquire('app-a').then((got) => { lease = got })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(log).toEqual(['start app-a'])
    expect(lease).toBeUndefined()
    pending[0]?.resolve()
    await asked
    expect(lease).toBeDefined()
  })

  it('gives a second request of the same user name the same tunnel, and a different name its own', async () => {
    const { instances, log, pending } = harness()
    const first = instances.acquire('app-a')
    const second = instances.acquire('app-a')
    const other = instances.acquire('app-b')
    pending.forEach((entry) => { entry.resolve() })
    const [a1, a2, b] = await Promise.all([first, second, other])
    expect(log.filter((line) => line.startsWith('start'))).toEqual(['start app-a', 'start app-b'])
    expect(a1.tunnel).toBe(a2.tunnel)
    expect(a1.tunnel).not.toBe(b.tunnel)
  })

  it('refuses a request after 30 s, and keeps the tunnel coming up for the next one', async () => {
    const { instances, pending } = harness()
    const slow = instances.acquire('app-a')
    const failed = slow.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await failed
    expect(error).toBeInstanceOf(AcquireError)
    expect((error as AcquireError).kind).toBe('start-timeout')
    pending[0]?.resolve()
    const later = await instances.acquire('app-a')
    expect(later.tunnel).toBeDefined()
    expect(pending).toHaveLength(1)
  })

  it('drops a tunnel that could not come up and says why, so the next request tries again', async () => {
    const { instances, pending, snapshots } = harness()
    const asked = instances.acquire('app-a').catch((error: unknown) => error)
    pending[0]?.reject(new Error('no gateway answered'))
    const error = await asked
    expect((error as AcquireError).kind).toBe('start-failed')
    expect(snapshots.at(-1)?.problem).toContain('no gateway answered')
    expect(instances.snapshot().connecting).toBe(0)
    void instances.acquire('app-a').catch(() => {})
    expect(pending).toHaveLength(2)
  })

  it('closes a tunnel ten minutes after the last thing using it ends, not before', async () => {
    const { instances, log, pending } = harness()
    const asked = instances.acquire('app-a')
    pending[0]?.resolve()
    const lease = await asked
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(log).not.toContain('disconnect app-a')
    lease.release()
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(log).not.toContain('disconnect app-a')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(log).toContain('disconnect app-a')
    expect(instances.snapshot().ready).toBe(0)
  })

  it('closes a tunnel nobody ever used, ten minutes after it came up', async () => {
    const { instances, log, pending } = harness()
    const timedOut = instances.acquire('app-a').catch(() => {})
    await vi.advanceTimersByTimeAsync(30_000)
    await timedOut
    pending[0]?.resolve()
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
    expect(log).toContain('disconnect app-a')
  })

  it('keeps a tunnel while a second lease on it is held', async () => {
    const { instances, log, pending } = harness()
    const first = instances.acquire('app-a')
    pending[0]?.resolve()
    const a = await first
    const b = await instances.acquire('app-a')
    a.release()
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(log).not.toContain('disconnect app-a')
    b.release()
    b.release()
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
    expect(log).toContain('disconnect app-a')
  })

  it('refuses a new user name past the cap, and never hands it another name\'s tunnel', async () => {
    const { instances, pending, snapshots } = harness({ cap: 2 })
    const held = [instances.acquire('app-a'), instances.acquire('app-b')]
    pending.forEach((entry) => { entry.resolve() })
    await Promise.all(held)
    const error = await instances.acquire('app-c').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AcquireError)
    expect((error as AcquireError).kind).toBe('cap')
    expect(snapshots.at(-1)?.problem).toContain('2 apps')
    expect(pending).toHaveLength(2)
  })

  it('makes room past the cap by closing the tunnel nobody is using, longest idle first', async () => {
    const { instances, log, pending } = harness({ cap: 2 })
    const a = instances.acquire('app-a')
    pending[0]?.resolve()
    ;(await a).release()
    await vi.advanceTimersByTimeAsync(1_000)
    const b = instances.acquire('app-b')
    pending[1]?.resolve()
    await b
    const c = instances.acquire('app-c')
    expect(log).toContain('disconnect app-a')
    pending[2]?.resolve()
    expect((await c).tunnel).toBeDefined()
    expect(log).not.toContain('disconnect app-b')
  })

  it('closeAll disconnects every tunnel, including one still coming up', async () => {
    const { instances, log, pending } = harness()
    const a = instances.acquire('app-a')
    pending[0]?.resolve()
    await a
    const b = instances.acquire('app-b').catch(() => {})
    const closing = instances.closeAll()
    pending[1]?.resolve()
    await closing
    await b
    expect(log).toContain('disconnect app-a')
    expect(log).toContain('disconnect app-b')
  })
})
