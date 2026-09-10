import { describe, expect, it } from 'vitest'
import { handleSyncFsReadRequest, isSyncFsReadRequest } from '../sync-fs.js'
import type { SyncFsPolicy } from '../sync-fs.js'
import { fail } from '../../errors.js'
import { APP, frameFor, NO_FRAME } from './ipc.test-helpers.js'

// Mirrors ipc.test.ts's own shape: the pure handler, exercised with a fake
// SyncFsPolicy standing in for ./sync-fs-policy.ts's real one, so this suite
// proves handleSyncFsReadRequest's OWN behaviour (origin derivation, rate
// limiting, payload validation, and mapping a policy/IO failure onto the
// closed ResponseEnvelope shape) without needing real disk I/O or a real
// grant ledger.

interface PolicyCall { readonly kind: 'confine' | 'readFileSync', readonly arg: string }

function fakePolicy (overrides: Partial<{
  confine: (origin: string, path: string) => string
  readFileSync: (resolved: string) => Uint8Array
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
    }
  }
  return { policy, calls }
}

describe('isSyncFsReadRequest', () => {
  it('accepts { path: string }', () => {
    expect(isSyncFsReadRequest({ path: '/a.txt' })).toBe(true)
  })

  it('rejects a missing path, a non-string path, null and non-objects', () => {
    expect(isSyncFsReadRequest({})).toBe(false)
    expect(isSyncFsReadRequest({ path: 1 })).toBe(false)
    expect(isSyncFsReadRequest(null)).toBe(false)
    expect(isSyncFsReadRequest('a.txt')).toBe(false)
    expect(isSyncFsReadRequest(undefined)).toBe(false)
  })
})

describe('handleSyncFsReadRequest -- origin derivation (never the payload)', () => {
  it('denies with no authenticated origin when senderFrame is null, and never reaches the policy', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsReadRequest(policy, NO_FRAME, { path: '/a.txt' })

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
      readFileSync: () => new Uint8Array()
    }

    handleSyncFsReadRequest(policy, frameFor(APP), { path: '/a.txt', origin: 'https://attacker.example' })

    expect(seenOrigins).toEqual([APP])
  })
})

describe('handleSyncFsReadRequest -- rate limiting shares CONTROL_CHANNEL\'s limiter', () => {
  it('returns \'limit\' and never reaches the policy when the limiter refuses', () => {
    const { policy, calls } = fakePolicy()
    const limiter = { tryConsume: () => false }

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: '/a.txt' }, limiter)

    expect(response).toEqual({ id: '', ok: false, code: 'limit', message: expect.any(String) })
    expect(calls).toEqual([])
  })

  it('proceeds when the limiter allows, or when none is supplied', () => {
    const { policy: p1, calls: c1 } = fakePolicy()
    handleSyncFsReadRequest(p1, frameFor(APP), { path: '/a.txt' }, { tryConsume: () => true })
    expect(c1.length).toBeGreaterThan(0)

    const { policy: p2, calls: c2 } = fakePolicy()
    handleSyncFsReadRequest(p2, frameFor(APP), { path: '/a.txt' })
    expect(c2.length).toBeGreaterThan(0)
  })
})

describe('handleSyncFsReadRequest -- payload validation', () => {
  it('returns \'invalid\' for a malformed payload, and never reaches the policy', () => {
    const { policy, calls } = fakePolicy()

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { notPath: 1 })

    expect(response).toEqual({ id: '', ok: false, code: 'invalid', message: expect.any(String) })
    expect(calls).toEqual([])
  })
})

describe('handleSyncFsReadRequest -- the granted path', () => {
  it('returns the bytes policy.readFileSync produces for the path policy.confine resolved', () => {
    const bytes = new Uint8Array([9, 8, 7])
    const { policy, calls } = fakePolicy({
      confine: (_origin, path) => `/apps/app-root/${path}`,
      readFileSync: (resolved) => { expect(resolved).toBe('/apps/app-root/a.txt'); return bytes }
    })

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: 'a.txt' })

    expect(response).toEqual({ id: '', ok: true, result: bytes })
    expect(calls).toEqual([{ kind: 'confine', arg: 'a.txt' }, { kind: 'readFileSync', arg: '/apps/app-root/a.txt' }])
  })
})

describe('handleSyncFsReadRequest -- confinement refuses a traversal attempt', () => {
  it('a path policy.confine rejects (no grant, or an escape attempt) comes back \'denied\' with no platformCode, and readFileSync is never called', () => {
    const { policy, calls } = fakePolicy({
      confine: () => { throw fail('denied', "the path is outside this app's files directory") }
    })

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: '../../../etc/passwd' })

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect((response as { platformCode?: unknown }).platformCode).toBeUndefined()
    expect(calls).toEqual([{ kind: 'confine', arg: '../../../etc/passwd' }])
  })

  it('an absent fs grant is refused the same way, before any disk access', () => {
    const { policy, calls } = fakePolicy({
      confine: () => { throw fail('denied', 'fs is not granted to this origin') }
    })

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: 'a.txt' })

    expect(response).toEqual({ id: '', ok: false, code: 'denied', message: expect.any(String) })
    expect(calls).toEqual([{ kind: 'confine', arg: 'a.txt' }])
  })
})

describe('handleSyncFsReadRequest -- disk errors are mapped through the same closed enum as fs.readFile', () => {
  it('an ENOENT-shaped raw error maps to \'notFound\', carrying the errno as platformCode', () => {
    const { policy } = fakePolicy({
      readFileSync: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) }
    })

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: 'missing.txt' })

    expect(response).toEqual({
      id: '', ok: false, code: 'notFound', message: expect.any(String), platformCode: 'ENOENT'
    })
  })

  it('an unrecognised raw error fails closed as \'internal\', never forwarding the raw message', () => {
    const { policy } = fakePolicy({
      readFileSync: () => { throw new Error('/apps/<sha256>/secret detail') }
    })

    const response = handleSyncFsReadRequest(policy, frameFor(APP), { path: 'a.txt' })

    expect(response.ok).toBe(false)
    expect((response as { code: string }).code).toBe('internal')
    expect((response as { message: string }).message).not.toContain('secret detail')
  })
})
