import { describe, expect, it } from 'vitest'
import { handleSyncFsRequest, isSyncFsRequest } from '../sync-fs.js'
import type { SyncFsPolicy } from '../sync-fs.js'
import type { BrokerFsSyncMethods } from '../../fs-contracts.js'
import { fail } from '../../errors.js'
import { APP, APP_SESSION, attributedFrom, DEFAULT_SESSION, frameFor, NO_FRAME } from './ipc.test-helpers.js'

// Mirrors ipc.test.ts's own shape: the pure handler, exercised with a fake
// SyncFsPolicy standing in for ./sync-fs-policy.ts's real one, so this suite
// proves handleSyncFsRequest's OWN behaviour (origin derivation, rate
// limiting, payload validation, and mapping a policy/IO failure onto the
// closed ResponseEnvelope shape) without needing real disk I/O or a real
// grant ledger.

interface PolicyCall { readonly kind: string, readonly arg: unknown }

/** Every broker sync op records itself as `{ kind: 'sync.<op>', arg: [origin, ...args] }` and defers to an override, else returns a marker value. */
function fakeSync (calls: PolicyCall[], overrides: Partial<BrokerFsSyncMethods> = {}): BrokerFsSyncMethods {
  const record = <K extends keyof BrokerFsSyncMethods>(name: K, fallback: ReturnType<BrokerFsSyncMethods[K]>): BrokerFsSyncMethods[K] =>
    ((...args: unknown[]) => {
      calls.push({ kind: `sync.${name}`, arg: args })
      const override = overrides[name] as ((...a: unknown[]) => unknown) | undefined
      return override === undefined ? fallback : override(...args)
    }) as BrokerFsSyncMethods[K]
  return {
    writeFile: record('writeFile', undefined), mkdir: record('mkdir', undefined), readdir: record('readdir', ['x', 'y']),
    stat: record('stat', { size: 3, isFile: true, isDirectory: false, mtimeMs: 1 }), rm: record('rm', undefined), rename: record('rename', undefined)
  }
}

function fakePolicy (overrides: Partial<{
  confine: (origin: string, path: string) => string
  readFileSync: (resolved: string) => Uint8Array
  sync: Partial<BrokerFsSyncMethods>
}> = {}): { policy: SyncFsPolicy, calls: PolicyCall[] } {
  const calls: PolicyCall[] = []
  const policy: SyncFsPolicy = {
    confine: (origin, path) => {
      calls.push({ kind: 'confine', arg: path })
      return overrides.confine?.(origin, path) ?? `/root/${path}`
    },
    readFileSync: (resolved) => {
      calls.push({ kind: 'readFileSync', arg: resolved })
      return overrides.readFileSync?.(resolved) ?? new Uint8Array([1, 2, 3])
    },
    sync: fakeSync(calls, overrides.sync)
  }
  return { policy, calls }
}

describe('isSyncFsRequest', () => {
  it('accepts each op with the arguments it takes', () => {
    const bytes = new Uint8Array([1])
    for (const request of [
      { op: 'stat', args: ['/a'] }, { op: 'readFile', args: ['/a'] }, { op: 'readdir', args: ['/a'] },
      { op: 'writeFile', args: ['/a', bytes] }, { op: 'mkdir', args: ['/a'] }, { op: 'mkdir', args: ['/a', { recursive: true }] },
      { op: 'mkdir', args: ['/a', undefined] }, { op: 'rm', args: ['/a', { recursive: false }] }, { op: 'rename', args: ['/a', '/b'] }
    ]) expect(isSyncFsRequest(request), JSON.stringify(request)).toBe(true)
  })

  it('rejects an unknown op (including open), wrong argument shapes, the old { path } shape, null and non-objects', () => {
    for (const request of [
      { op: 'open', args: ['/a', 'r'] }, { op: 'stat', args: [] }, { op: 'stat', args: [1] }, { op: 'stat', args: ['/a', '/b'] },
      { op: 'writeFile', args: ['/a', 'text'] }, { op: 'writeFile', args: ['/a'] }, { op: 'mkdir', args: ['/a', { recursive: 'yes' }] },
      { op: 'mkdir', args: ['/a', true] }, { op: 'rename', args: ['/a'] }, { op: 'stat', args: '/a' }, { op: 'stat' },
      { path: '/a.txt' }, {}, null, '/a.txt', undefined
    ]) expect(isSyncFsRequest(request), JSON.stringify(request)).toBe(false)
  })
})

describe('handleSyncFsRequest -- origin derivation (never the payload)', () => {
  it('denies with no authenticated origin when senderFrame is null, and never reaches the policy', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsRequest(policy, NO_FRAME, { op: 'readFile', args: ['/a.txt'] })

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  // MUTATION TEST: an implementation that read `payload.origin` instead of
  // (or in addition to) the sender frame would call policy.confine with the
  // attacker-chosen origin below rather than APP -- ipc.test.ts's own
  // precedent for handleControlRequest, applied to this handler.
  it('passes the sender-frame-derived origin to policy.confine, never one from the payload', () => {
    const seenOrigins: string[] = []
    const policy: SyncFsPolicy = {
      confine: (origin, path) => { seenOrigins.push(origin); return `/root/${path}` },
      readFileSync: () => new Uint8Array(),
      sync: fakeSync([])
    }

    handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['/a.txt'], origin: 'https://attacker.example' })

    expect(seenOrigins).toEqual([APP])
  })
})

describe('handleSyncFsRequest -- rate limiting shares CONTROL_CHANNEL\'s limiter', () => {
  it('returns \'limit\' and never reaches the policy when the limiter refuses', () => {
    const { policy, calls } = fakePolicy()
    const limiter = { tryConsume: () => false }

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['/a.txt'] }, limiter)

    expect(response).toEqual({ id: '', ok: false, code: 'limit', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('proceeds when the limiter allows, or when none is supplied', () => {
    const { policy: p1, calls: c1 } = fakePolicy()
    handleSyncFsRequest(p1, frameFor(APP), { op: 'readFile', args: ['/a.txt'] }, { tryConsume: () => true })
    expect(c1.length).toBeGreaterThan(0)

    const { policy: p2, calls: c2 } = fakePolicy()
    handleSyncFsRequest(p2, frameFor(APP), { op: 'readFile', args: ['/a.txt'] })
    expect(c2.length).toBeGreaterThan(0)
  })
})

describe('handleSyncFsRequest -- session-bound attribution', () => {
  it('denies a sender in the default session when the origin belongs in an isolated one, and never reaches the policy', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsRequest(policy, frameFor(APP, DEFAULT_SESSION), { op: 'readFile', args: ['/a.txt'] }, undefined, attributedFrom(() => APP_SESSION))

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('allows a sender that already sits in the session its origin belongs in', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsRequest(policy, frameFor(APP, APP_SESSION), { op: 'readFile', args: ['/a.txt'] }, undefined, attributedFrom(() => APP_SESSION))

    expect(response.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('never checks the session when no attributed predicate is injected', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsRequest(policy, frameFor(APP, DEFAULT_SESSION), { op: 'readFile', args: ['/a.txt'] })

    expect(response.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('handleSyncFsRequest -- payload validation', () => {
  it('returns \'invalid\' for a malformed payload, and never reaches the policy', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsRequest(policy, frameFor(APP), { notPath: 1 })

    expect(response).toEqual({ id: '', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })
})

describe('handleSyncFsRequest -- the granted path', () => {
  it('returns the bytes policy.readFileSync produces for the path policy.confine resolved', () => {
    const bytes = new Uint8Array([9, 8, 7])
    const { policy, calls } = fakePolicy({
      confine: (_origin, path) => `/apps/app-root/${path}`,
      readFileSync: (resolved) => { expect(resolved).toBe('/apps/app-root/a.txt'); return bytes }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['a.txt'] })

    expect(response).toEqual({ id: '', ok: true, result: bytes })
    expect(calls).toEqual([{ kind: 'confine', arg: 'a.txt' }, { kind: 'readFileSync', arg: '/apps/app-root/a.txt' }])
  })
})

describe('handleSyncFsRequest -- confinement refuses a traversal attempt', () => {
  it('a path policy.confine rejects (no grant, or an escape attempt) comes back \'denied\' with no platformCode, and readFileSync is never called', () => {
    const { policy, calls } = fakePolicy({
      confine: () => { throw fail('denied', "the path is outside this app's files directory") }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['../../../etc/passwd'] })

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect((response as { platformCode?: unknown }).platformCode).toBeUndefined()
    expect(calls).toEqual([{ kind: 'confine', arg: '../../../etc/passwd' }])
  })

  it('an absent fs grant is refused the same way, before any disk access', () => {
    const { policy, calls } = fakePolicy({
      confine: () => { throw fail('denied', 'fs is not granted to this origin') }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['a.txt'] })

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([{ kind: 'confine', arg: 'a.txt' }])
  })
})

describe('handleSyncFsRequest -- disk errors are mapped through the same closed enum as fs.readFile', () => {
  it('an ENOENT-shaped raw error maps to \'notFound\', carrying the errno as platformCode', () => {
    const { policy } = fakePolicy({
      readFileSync: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['missing.txt'] })

    expect(response).toEqual({
      id: '', ok: false, code: 'notFound', message: expect.any(String), platformCode: 'ENOENT'
    })
  })

  it('an unrecognised raw error fails closed as \'internal\', never forwarding the raw message', () => {
    const { policy } = fakePolicy({
      readFileSync: () => { throw new Error('/apps/<sha256>/secret detail') }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['a.txt'] })

    expect(response.ok).toBe(false)
    expect((response as { code: string }).code).toBe('internal')
    expect((response as { message: string }).message).not.toContain('secret detail')
  })

  // R5-03: ./sync-fs-policy.ts's production readFileSync throws an already-
  // mapped OrivonError ('limit') when a file exceeds the size cap.
  // mapIoError's isOrivonError passthrough must hand that through unchanged
  // rather than re-wrapping it as 'internal'.
  it('a \'limit\' OrivonError from policy.readFileSync (the size cap) passes through unchanged', () => {
    const { policy } = fakePolicy({
      readFileSync: () => { throw fail('limit', 'the file exceeds the synchronous read size cap') }
    })

    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'readFile', args: ['huge.bin'] })

    expect(response).toEqual({ id: '', ok: false, code: 'limit', message: expect.any(String) })
  })
})

describe('handleSyncFsRequest -- the path-based ops', () => {
  const data = new Uint8Array([4, 5])

  it('runs each op on the broker with the sender-derived origin and returns its result', () => {
    const { policy, calls } = fakePolicy()
    const run = (request: unknown): unknown => handleSyncFsRequest(policy, frameFor(APP), request)

    expect(run({ op: 'stat', args: ['a'] })).toEqual({ id: '', ok: true, result: { size: 3, isFile: true, isDirectory: false, mtimeMs: 1 } })
    expect(run({ op: 'readdir', args: ['d'] })).toEqual({ id: '', ok: true, result: ['x', 'y'] })
    expect(run({ op: 'writeFile', args: ['a', data] })).toEqual({ id: '', ok: true, result: undefined })
    expect(run({ op: 'mkdir', args: ['d', { recursive: true }] })).toEqual({ id: '', ok: true, result: undefined })
    expect(run({ op: 'rm', args: ['d', { recursive: true }] })).toEqual({ id: '', ok: true, result: undefined })
    expect(run({ op: 'rename', args: ['a', 'b'] })).toEqual({ id: '', ok: true, result: undefined })

    expect(calls).toEqual([
      { kind: 'sync.stat', arg: [APP, 'a'] }, { kind: 'sync.readdir', arg: [APP, 'd'] }, { kind: 'sync.writeFile', arg: [APP, 'a', data] },
      { kind: 'sync.mkdir', arg: [APP, 'd', { recursive: true }] }, { kind: 'sync.rm', arg: [APP, 'd', { recursive: true }] },
      { kind: 'sync.rename', arg: [APP, 'a', 'b'] }
    ])
  })

  it('refuses an unknown op or a malformed argument list as \'invalid\' without reaching the broker', () => {
    const { policy, calls } = fakePolicy()
    for (const request of [{ op: 'open', args: ['a', 'r'] }, { op: 'writeFile', args: ['a', 'text'] }, { op: 'rename', args: ['a'] }]) {
      expect(handleSyncFsRequest(policy, frameFor(APP), request)).toEqual({ id: '', ok: false, code: 'invalid', message: expect.any(String) })
    }
    expect(calls).toEqual([])
  })

  it('maps a refusal to the closed code: a missing grant or an escape is \'denied\' with no platformCode', () => {
    const { policy } = fakePolicy({ sync: { stat: () => { throw fail('denied', "the path is outside this app's files directory") } } })
    const response = handleSyncFsRequest(policy, frameFor(APP), { op: 'stat', args: ['../../etc/passwd'] })
    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect((response as { platformCode?: unknown }).platformCode).toBeUndefined()
  })

  it('maps raw disk errors like the async path: ENOENT notFound, EEXIST exists, ENOTDIR internal with the errno, nothing path-shaped forwarded', () => {
    const raw = (code: string): never => { throw Object.assign(new Error(`${code}: /apps/<sha256>/secret`), { code }) }
    const { policy } = fakePolicy({ sync: { readdir: () => raw('ENOENT'), mkdir: () => raw('EEXIST'), rename: () => raw('ENOTDIR') } })
    const run = (request: unknown): { ok: boolean, code?: string, platformCode?: string, message?: string } =>
      handleSyncFsRequest(policy, frameFor(APP), request) as never

    expect(run({ op: 'readdir', args: ['missing'] })).toMatchObject({ ok: false, code: 'notFound', platformCode: 'ENOENT' })
    expect(run({ op: 'mkdir', args: ['d'] })).toMatchObject({ ok: false, code: 'exists', platformCode: 'EEXIST' })
    const notDir = run({ op: 'rename', args: ['a', 'b'] })
    expect(notDir).toMatchObject({ ok: false, code: 'internal', platformCode: 'ENOTDIR' })
    expect(notDir.message).not.toContain('secret')
  })

  it('passes a \'limit\' from the quota through unchanged', () => {
    const { policy } = fakePolicy({ sync: { writeFile: () => { throw fail('limit', "this write would exceed the app's declared storage quota") } } })
    expect(handleSyncFsRequest(policy, frameFor(APP), { op: 'writeFile', args: ['a', data] }))
      .toEqual({ id: '', ok: false, code: 'limit', message: expect.any(String) })
  })

  it('shares the rate limit and the session check with readFile', () => {
    const { policy, calls } = fakePolicy()
    expect(handleSyncFsRequest(policy, frameFor(APP), { op: 'mkdir', args: ['d'] }, { tryConsume: () => false }))
      .toEqual({ id: '', ok: false, code: 'limit', message: expect.any(String) })
    expect(handleSyncFsRequest(policy, frameFor(APP, DEFAULT_SESSION), { op: 'mkdir', args: ['d'] }, undefined, attributedFrom(() => APP_SESSION)))
      .toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([])
  })
})
