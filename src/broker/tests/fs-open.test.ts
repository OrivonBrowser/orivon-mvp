import { describe, expect, it } from 'vitest'
import { never, outcomeNow, rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, stubFs } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'
import { LIMITS } from '../../contracts/index.js'

// `orivon.fs.open` (A184) -- the FileHandle half of `orivon.fs`, built
// against the POLICY layer (confinement, the grant, the running quota, the
// per-origin in-flight budget, revocation) using `index.test-helpers.ts`'s
// in-memory `stubFs`. Real fd/stream mechanics -- does a positional write
// actually land on disk, does destroy() really flush or discard a queued
// writable() chunk -- are node-fs-adapter-open.test.ts's job, against a
// real temp file; this file only has to prove fs-capability.ts's OWN
// wiring: every method routes through confineForOrigin exactly once, and
// every guard (grant absent, confinement, quota, revocation, the in-flight
// cap, the file-handle limit) actually refuses when it should.
//
// THE FAILURE PATH IS THE POINT, not an afterthought
// (test-the-guards-failure-path per CLAUDE.md): every describe block below
// proves a REFUSAL, not only a success.

/** One real event-loop tick -- long enough for a `stubFs` operation gated on a promise to settle, short enough that nothing here waits on real I/O. */
function nextTick (): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** A broker with `fs` granted (no patterns -- FsCapability carries none), matching index-fs-extended.test.ts's own fixture. */
async function fsBroker (files = new Map<string, Uint8Array>()): Promise<Broker> {
  const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
  broker.registerApp(APP, manifestWith({ fs: {} }))
  await broker.grant(APP, 'fs', [])
  return broker
}

describe('fs.open -- the guard rail failure path', () => {
  it('denies when fs was never granted', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({}))

    const error = await rejection(broker.fs.open(APP, 'piece.bin', 'w+'))

    expect(error.code).toBe('denied')
  })

  it('denies a traversal attempt outside the app root, with no platformCode', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.open(APP, '../../etc/passwd', 'r'))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('rejects an unrecognised flags string as invalid, never reaching the adapter', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.open(APP, 'piece.bin', 'not-a-real-flag'))

    expect(error.code).toBe('invalid')
  })

  it('revoking the fs grant denies a subsequent open', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    await broker.revoke(APP, g.id)

    const error = await rejection(broker.fs.open(APP, 'piece.bin', 'w+'))

    expect(error.code).toBe('denied')
  })

  it('a read past a missing file surfaces notFound, never the confined path', async () => {
    const broker = await fsBroker()

    const error = await rejection(broker.fs.open(APP, 'missing.bin', 'r'))

    expect(error.code).toBe('notFound')
    expect(error.message).not.toContain('/apps/app')
  })

  it('opening the same file twice yields two independent, live handles', async () => {
    const broker = await fsBroker()
    const first = await broker.fs.open(APP, 'shared.bin', 'w+')

    const second = await broker.fs.open(APP, 'shared.bin', 'r+')

    expect(second.id).not.toBe(first.id)
    await first.close()
    await second.close()
  })

  it('LIMITS.concurrentFileHandles refuses a handle beyond the per-origin cap', async () => {
    const broker = await fsBroker()
    const opened = []
    for (let i = 0; i < LIMITS.concurrentFileHandles; i++) {
      opened.push(await broker.fs.open(APP, `f${String(i)}.bin`, 'w+'))
    }

    const error = await rejection(broker.fs.open(APP, 'one-too-many.bin', 'w+'))

    expect(error.code).toBe('limit')
    await Promise.all(opened.map(async (handle) => { await handle.close() }))
  })

  it('an open FileHandle does NOT consume the socket budget (SOCKET_KINDS excludes \'file\')', async () => {
    // A regression this lane's brief calls out by name: HandleKind already
    // includes 'file' and SOCKET_KINDS already excludes it -- this proves
    // that stays true through fs-capability.ts's own wiring, not only
    // handles.ts's own unit tests. The origin declares a socket allowance
    // of exactly 1 -- if 'file' were wrongly counted against it, the SECOND
    // open below would fail with 'limit' long before LIMITS.
    // concurrentFileHandles (64) is anywhere close.
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: {}, net: { concurrentSockets: 1 } }))
    await broker.grant(APP, 'fs', [])
    const files = []
    for (let i = 0; i < LIMITS.concurrentFileHandles; i++) {
      files.push(await broker.fs.open(APP, `f${String(i)}.bin`, 'w+'))
    }

    expect(files).toHaveLength(LIMITS.concurrentFileHandles)
    await Promise.all(files.map(async (handle) => { await handle.close() }))
  })
})

describe('fs.open -- positional read/write, no implicit cursor', () => {
  it('writes at an explicit position and reads it back at that position', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')

    const written = await file.write({ position: 10, data: new Uint8Array([1, 2, 3]) })

    expect(written).toBe(3)
    expect(Array.from(await file.read({ position: 10, length: 3 }))).toEqual([1, 2, 3])
    await file.close()
  })

  it('read short-reads at EOF rather than padding the result', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'short.bin', 'w+')
    await file.write({ position: 0, data: new Uint8Array([9]) })

    const back = await file.read({ position: 0, length: 50 })

    expect(back.byteLength).toBe(1)
    await file.close()
  })

  it('close() is idempotent -- closing twice is a silent no-op', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')

    await file.close()
    await expect(file.close()).resolves.toBeUndefined()
  })

  it('an operation against an already-closed handle is refused, not silently served', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')
    await file.close()

    const error = await rejection(file.read({ position: 0, length: 1 }))

    expect(['denied', 'closed']).toContain(error.code)
  })

  it('stat/truncate/sync all work against the open handle, unlike a flat readFile/writeFile', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'meta.bin', 'w+')
    await file.write({ position: 0, data: new Uint8Array([1, 2, 3, 4]) })

    expect((await file.stat()).size).toBe(4)
    await file.truncate(2)
    expect((await file.stat()).size).toBe(2)
    await expect(file.sync()).resolves.toBeUndefined()
    await file.close()
  })
})

describe('fs.open -- the write quota applies to positional write(), exactly like writeFile', () => {
  it('exceeding the declared quota yields limit and reserves nothing', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 10 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'quota.bin', 'w+')

    const error = await rejection(file.write({ position: 0, data: new Uint8Array(20) }))

    expect(error.code).toBe('limit')
    await file.close()
  })

  it('a write that fits is accepted and counts against the running total for the NEXT write', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 10 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'quota.bin', 'w+')

    await file.write({ position: 0, data: new Uint8Array(6) })
    const error = await rejection(file.write({ position: 6, data: new Uint8Array(6) }))

    expect(error.code).toBe('limit')
    await file.close()
  })

  it('a write the raw call itself rejects refunds its reservation -- the quota is not permanently consumed by a refused attempt', async () => {
    // ENOSPC on the SECOND write only -- the first must land and count
    // against the quota; the second must fail AND be refunded, leaving
    // room for a THIRD write of the same size the second one was.
    let calls = 0
    const fs: CreateBrokerOptions['fs'] = {
      ...stubFs(),
      open: async () => ({
        read: async () => new Uint8Array(0),
        write: async ({ data }) => {
          calls += 1
          if (calls === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
          return data.length
        },
        readable: () => new ReadableStream(),
        writable: () => new WritableStream(),
        stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
        truncate: async () => {},
        sync: async () => {},
        destroy: () => {}
      })
    }
    const broker = createBroker(baseDeps({ fs }))
    // Room for exactly two 6-byte writes -- generous enough that the
    // SECOND write's reservation itself succeeds and the raw call is what
    // fails, not the quota check (that is the previous test's job).
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 12 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'quota.bin', 'w+')

    await file.write({ position: 0, data: new Uint8Array(6) })
    // ENOSPC itself maps to 'limit' (io-errors.ts's own table) -- the same
    // code the quota check above produces, for an unrelated reason. What
    // this test actually checks is the refund below, not this code.
    await rejection(file.write({ position: 6, data: new Uint8Array(6) }))

    // Refunded: a third write of the SAME size the failed one reserved must
    // still fit under the quota, proving the failed reservation was released.
    await expect(file.write({ position: 12, data: new Uint8Array(6) })).resolves.toBe(6)
    await file.close()
  })
})

describe('fs.open -- the per-origin in-flight budget and revocation mid-operation (T11b, CRITICAL)', () => {
  /** An fs whose `open` resolves immediately but whose `read`/`write` stall forever, for proving cancellation rather than a real result. */
  function stallingOpenFs (): CreateBrokerOptions['fs'] {
    return {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => await never<Uint8Array>(),
      writeFile: async () => { await never<void>() },
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }),
      rm: async () => {},
      rename: async () => {},
      open: async () => ({
        read: async () => await never<Uint8Array>(),
        write: async () => await never<number>(),
        readable: () => new ReadableStream(),
        writable: () => new WritableStream(),
        stat: async () => await never(),
        truncate: async () => { await never<void>() },
        sync: async () => { await never<void>() },
        destroy: () => {}
      })
    }
  }

  it('revoking the fs grant while a read is in flight rejects it with revoked, not the eventual result', async () => {
    const broker = createBroker(baseDeps({ fs: stallingOpenFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')

    const pending = file.read({ position: 0, length: 1 })
    await broker.revoke(APP, g.id)

    const error = await rejection(pending)
    expect(error.code).toBe('revoked')
  })

  it('revocation rejects an in-flight operation IMMEDIATELY -- it does not wait for the stalled call to finish', async () => {
    const broker = createBroker(baseDeps({ fs: stallingOpenFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')

    const pending = file.write({ position: 0, data: new Uint8Array([1]) })
    await broker.revoke(APP, g.id)

    const outcome = await outcomeNow(pending)
    expect(outcome.state).toBe('rejected')
  })

  it('a call beyond LIMITS.inFlightOperations rejects immediately with limit -- it does not queue', async () => {
    const broker = createBroker(baseDeps({ fs: stallingOpenFs() }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'piece.bin', 'w+')

    const stalled = []
    for (let i = 0; i < LIMITS.inFlightOperations; i++) {
      stalled.push(file.read({ position: 0, length: 1 }).catch(() => {}))
    }
    await nextTick()

    const overflow = await outcomeNow(file.read({ position: 0, length: 1 }))

    expect(overflow.state).toBe('rejected')
    if (overflow.state === 'rejected') expect(overflow.error.code).toBe('limit')
  })

  it('revoking the grant while `open` itself is still resolving refuses the acquisition, not the handle', async () => {
    let resolveOpen!: (value: Awaited<ReturnType<CreateBrokerOptions['fs']['open']>>) => void
    const openGate = new Promise<Awaited<ReturnType<CreateBrokerOptions['fs']['open']>>>((resolve) => { resolveOpen = resolve })
    const destroy = (): void => {}
    const fs: CreateBrokerOptions['fs'] = {
      ...stubFs(),
      open: async () => await openGate
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const g = await broker.grant(APP, 'fs', [])

    const pending = broker.fs.open(APP, 'piece.bin', 'w+')
    await nextTick()
    await broker.revoke(APP, g.id)
    // The adapter's own open() "arrives" only now -- late, after the grant is gone.
    resolveOpen({
      read: async () => await never<Uint8Array>(),
      write: async () => await never<number>(),
      readable: () => new ReadableStream(),
      writable: () => new WritableStream(),
      stat: async () => await never(),
      truncate: async () => { await never<void>() },
      sync: async () => { await never<void>() },
      destroy
    })

    const error = await rejection(pending)
    expect(error.code).toBe('revoked')
  })
})
