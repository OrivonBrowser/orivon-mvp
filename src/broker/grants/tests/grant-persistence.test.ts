import { describe, expect, it, vi } from 'vitest'
import { grantsToPersist, hydrateGrants } from '../grant-persistence.js'
import { memoryLedgerStorage } from '../../tests/index.test-helpers.js'
import type { CapabilityKind, Grant, Manifest } from '../../../contracts/index.js'

const APP = 'https://app.example'

function manifestWith (capabilities: Manifest['capabilities']): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities }
}

// hydrateGrants is the read half of A23: turning whatever an origin
// persisted last session back into live Grant objects, re-validated against
// its CURRENT manifest -- README.md's "what a persisted grant may trust"
// design note, followed rather than reimplemented. A tampered or stale
// store must never mint more authority than a fresh requestGrant() call for
// the same (capability, patterns) would be allowed right now.
describe('hydrateGrants', () => {
  it('returns an empty map when nothing was ever persisted for this origin', () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })

    const restored = hydrateGrants(storage, APP, manifest, () => 'id-1')

    expect(restored.size).toBe(0)
  })

  it('restores a persisted grant whose patterns are still covered by the current manifest', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { 'tcp.connect': { patterns: ['api.example.com:443'], grantedAt: 1000 } })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } })

    const restored = hydrateGrants(storage, APP, manifest, () => 'fresh-id')

    expect(restored.get('tcp.connect')).toEqual({
      id: 'fresh-id',
      origin: APP,
      capability: 'tcp.connect',
      patterns: ['api.example.com:443'],
      grantedAt: 1000
    })
  })

  it('mints a FRESH id for every restored grant, never trusting one read off disk', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { fs: { patterns: [], grantedAt: 1 } })
    const manifest = manifestWith({ fs: { quotaBytes: 1024 } })
    const newId = vi.fn(() => 'minted-id')

    const restored = hydrateGrants(storage, APP, manifest, newId)

    expect(newId).toHaveBeenCalledTimes(1)
    expect(restored.get('fs')?.id).toBe('minted-id')
  })

  it('drops a persisted grant for a capability the current manifest no longer declares at all', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { 'tcp.connect': { patterns: ['api.example.com:443'], grantedAt: 1000 } })
    const manifest = manifestWith({}) // narrowed to nothing since the grant was made

    const restored = hydrateGrants(storage, APP, manifest, () => 'id')

    expect(restored.size).toBe(0)
  })

  // The exact tampering/staleness scenario A23 exists to close: a grant
  // covering more than the origin's manifest declares TODAY must never come
  // back to life just because it once existed on disk.
  it('drops a persisted grant whose patterns now exceed the current (narrowed) manifest', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { 'tcp.connect': { patterns: ['*:*'], grantedAt: 1000 } })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } } }) // narrowed

    const restored = hydrateGrants(storage, APP, manifest, () => 'id')

    expect(restored.size).toBe(0)
  })

  it('restores only the patterns actually granted, even when the manifest now declares MORE than that', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { 'tcp.connect': { patterns: ['api.example.com:443'], grantedAt: 1000 } })
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } }) // widened since the grant was made

    const restored = hydrateGrants(storage, APP, manifest, () => 'id')

    expect(restored.get('tcp.connect')?.patterns).toEqual(['api.example.com:443'])
  })

  // Untrusted disk content: a hand-edited or corrupted file could name any
  // JSON property, not only a real CapabilityKind.
  it('ignores a persisted entry whose key is not a real CapabilityKind', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { 'not.a.real.capability': { patterns: [], grantedAt: 1 } })
    const manifest = manifestWith({ fs: { quotaBytes: 1 } })

    const restored = hydrateGrants(storage, APP, manifest, () => 'id')

    expect(restored.size).toBe(0)
  })

  it('restores every capability that independently still passes, and drops only the ones that do not', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, {
      'tcp.connect': { patterns: ['*:*'], grantedAt: 1 }, // will be refused -- manifest narrowed
      fs: { patterns: [], grantedAt: 2 } // still declared, restored
    })
    const manifest = manifestWith({ net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1 } })

    const restored = hydrateGrants(storage, APP, manifest, () => 'id')

    expect(restored.has('tcp.connect')).toBe(false)
    expect(restored.has('fs')).toBe(true)
  })

  it('restores a capability that carries no patterns of its own (id) with an empty pattern array', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { id: { patterns: [], grantedAt: 5 } })
    const manifest = manifestWith({ id: { curves: ['secp256k1'] } })

    const restored = hydrateGrants(storage, APP, manifest, () => 'id-token')

    expect(restored.get('id')).toEqual({ id: 'id-token', origin: APP, capability: 'id', patterns: [], grantedAt: 5 })
  })
})

// grantsToPersist is the write half: `GrantLedger.grant`/`revoke`'s own
// record.grants map, reshaped for LedgerStorage.writeGrants. id and origin
// are dropped -- hydrateGrants never reads either back (a fresh id is always
// minted, and the origin is already the file's own key).
describe('grantsToPersist', () => {
  it('returns an empty object for an empty map', () => {
    expect(grantsToPersist(new Map())).toEqual({})
  })

  it('keeps only patterns and grantedAt, dropping id/origin/capability', () => {
    const grants = new Map<CapabilityKind, Grant>([
      ['tcp.connect', { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 42 }]
    ])

    expect(grantsToPersist(grants)).toEqual({
      'tcp.connect': { patterns: ['api.example.com:443'], grantedAt: 42 }
    })
  })

  it('serialises every capability present in the map', () => {
    const grants = new Map<CapabilityKind, Grant>([
      ['fs', { id: 'g1', origin: APP, capability: 'fs', patterns: [], grantedAt: 1 }],
      ['id', { id: 'g2', origin: APP, capability: 'id', patterns: [], grantedAt: 2 }]
    ])

    expect(grantsToPersist(grants)).toEqual({
      fs: { patterns: [], grantedAt: 1 },
      id: { patterns: [], grantedAt: 2 }
    })
  })
})
