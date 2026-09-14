// A158 (docs/open-questions.md) -- GrantLedger's early-hydration seam, split
// out from grant-ledger-persistence.test.ts (code-guidelines.md Rule 2) as
// its own concern: hydrating from a PINNED manifest, before any real
// `registerApp` call, rather than through registerApp's own hydration path.
// See `hydrateFromPinnedManifest`'s own doc (grant-ledger.ts) for why this
// is safe under A137's "never trust disk as authority" rule -- callers MUST
// pass a manifest already proven to be a leaf of a hash-pinned bundle
// (`src/loader/serve.ts`'s `verifiedManifestFor`), never a bare disk read.
// This suite only proves GrantLedger's own contract; it does not re-verify
// anything -- that is `serve-verify.test.ts`'s job.

import { describe, expect, it } from 'vitest'
import { GrantLedger } from '../grant-ledger.js'
import { memoryLedgerStorage } from '../../tests/index.test-helpers.js'
import type { Manifest } from '../../../contracts/index.js'

const APP = 'https://app.example'

/** A minimal, valid Manifest -- only `capabilities` varies per call. */
function manifestFor (capabilities: Manifest['capabilities']): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities }
}

describe('GrantLedger.hydrateFromPinnedManifest (A158)', () => {
  it('makes a persisted grant live immediately, with no registerApp call at all', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    before.grant(APP, 'tcp.connect', ['api.example.com:443'], 999)

    // "Restart": a fresh ledger over the same storage -- registerApp never called yet.
    const after = new GrantLedger(storage)
    expect(after.currentGrant(APP, 'tcp.connect')).toBeUndefined() // sanity: nothing live yet

    after.hydrateFromPinnedManifest(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    const live = after.currentGrant(APP, 'tcp.connect')
    expect(live?.patterns).toEqual(['api.example.com:443'])
  })

  it('re-validates against the pinned manifest exactly like registerApp\'s own hydration -- a narrower pinned manifest drops what no longer fits', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ net: { tcp: { connect: ['*:*'] } } }))
    before.grant(APP, 'tcp.connect', ['*:*'], 1)

    const after = new GrantLedger(storage)
    after.hydrateFromPinnedManifest(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(after.currentGrant(APP, 'tcp.connect')).toBeUndefined()
  })

  it('is a no-op with no LedgerStorage injected', () => {
    const ledger = new GrantLedger()
    ledger.hydrateFromPinnedManifest(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    expect(ledger.grantsFor(APP)).toEqual([])
  })

  it('is a no-op for a non-persistable origin (A23/T13c) -- a loopback origin is session-scoped only', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.hydrateFromPinnedManifest('http://127.0.0.1:9', manifestFor({ fs: { quotaBytes: 1 } }))
    expect(ledger.grantsFor('http://127.0.0.1:9')).toEqual([])
  })

  it('is a no-op once the REAL registerApp has already hydrated this origin this session -- the real manifest already spoke, never re-derived from a second, older source', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    before.grant(APP, 'fs', [], 1)

    const after = new GrantLedger(storage)
    after.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } })) // the REAL hydration already ran
    expect(after.currentGrant(APP, 'fs')).toBeDefined()

    // A manifest that would otherwise drop fs entirely -- must be ignored,
    // since registerApp already ran and is what "authoritative" means here.
    after.hydrateFromPinnedManifest(APP, manifestFor({}))
    expect(after.currentGrant(APP, 'fs')).toBeDefined()
  })

  it('THE OWNER\'S POINT: a later, real registerApp with a DIFFERENT (narrower) manifest is fully authoritative, dropping a capability the pinned manifest still declared', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({
      net: { tcp: { connect: ['api.example.com:443'] }, https: { connect: ['cdn.example.com:443'] } }
    }))
    before.grant(APP, 'tcp.connect', ['api.example.com:443'], 1)
    before.grant(APP, 'https.connect', ['cdn.example.com:443'], 2)

    const after = new GrantLedger(storage)
    // Early hydration from the (still-pinned) OLD manifest -- both grants go live.
    after.hydrateFromPinnedManifest(APP, manifestFor({
      net: { tcp: { connect: ['api.example.com:443'] }, https: { connect: ['cdn.example.com:443'] } }
    }))
    expect(after.currentGrant(APP, 'tcp.connect')).toBeDefined()
    expect(after.currentGrant(APP, 'https.connect')).toBeDefined()

    // The real manifest arrives (a fresh fetch) and has dropped https.connect
    // entirely. Owner's own reasoning: changing the manifest changes the
    // bundle hash, which is itself enough to restart the status of
    // permissions -- so the fresh fetch is authoritative, exactly like any
    // other registerApp call.
    after.registerApp(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    expect(after.currentGrant(APP, 'tcp.connect')).toBeDefined() // still allowed
    expect(after.currentGrant(APP, 'https.connect')).toBeUndefined() // dropped
  })

  it('mints a fresh GrantId, never reusing the persisted one -- same rule hydrateGrants already applies inside registerApp', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    const { record } = before.grant(APP, 'fs', [], 1)

    const after = new GrantLedger(storage)
    after.hydrateFromPinnedManifest(APP, manifestFor({ fs: { quotaBytes: 1 } }))

    expect(after.currentGrant(APP, 'fs')?.id).not.toBe(record.id)
  })

  it('calling it twice before registerApp is idempotent, not additive', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    before.grant(APP, 'fs', [], 1)

    const after = new GrantLedger(storage)
    after.hydrateFromPinnedManifest(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    after.hydrateFromPinnedManifest(APP, manifestFor({ fs: { quotaBytes: 1 } }))

    expect(after.grantsFor(APP)).toHaveLength(1)
  })
})
