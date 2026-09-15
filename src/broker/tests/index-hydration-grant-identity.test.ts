// A168 (docs/open-questions.md): a handle acquired under a grant that
// `hydrateFromPinnedManifest` (A158) restored must not survive the first
// REAL `registerApp` call for that origin this session -- whether that call
// leaves the restored authority unchanged (Half 1: the same GrantId must
// carry forward, so a later revoke still finds the handle) or narrows it
// (Half 2: the superseded grant's handles must be torn down even though
// nothing ever called `revoke`/`revokePersisted` on it directly). Both
// halves are proven here through the real `createBroker` surface, the same
// one `index-ledger-storage.test.ts`'s "revoke tears down the grant's
// handles" suite already exercises -- see that file for the `rejection`
// helper and the throwing-storage idiom this borrows.

import { describe, expect, it } from 'vitest'
import { createBroker } from '../index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from './index.test-helpers.js'
import { rejection } from '../handles/tests/handles.test-helpers.js'

describe('createBroker -- A168: hydration must not desynchronise a live handle from its grant\'s identity', () => {
  it('Half 1: revokePersisted still tears down a handle acquired under a pin-hydrated grant, once the first real registerApp re-declares the SAME manifest', async () => {
    const storage = memoryLedgerStorage()
    const manifest = manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } })

    // A previous session: registerApp + grant, persisted to disk.
    const before = createBroker(baseDeps({ ledgerStorage: storage }))
    before.registerApp(APP, manifest)
    await before.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    // "Restart": a fresh broker over the same storage. The app loader's
    // pin-hydration seam (A158) runs before the page's own registerApp call
    // reaches the broker -- reproduced directly, the way that seam does.
    const after = createBroker(baseDeps({ ledgerStorage: storage }))
    await after.app.hydrateFromPinnedManifest(APP, manifest)

    // A real handle, acquired under the pin-hydrated grant.
    const socket = await after.net.connect(APP, { host: '93.184.216.34', port: 443 })

    // The page's own manifest hint triggers the first REAL registerApp for
    // this origin this session, with the IDENTICAL manifest -- authority did
    // not change.
    after.registerApp(APP, manifest)

    const removed = await after.revokePersisted(APP, 'tcp.connect')
    expect(removed).toBe(true)

    // Unfixed: registerApp's hydration branch re-mints a fresh GrantId for
    // unchanged authority, so revokePersisted's cascade (keyed on the NEW
    // id) misses the handle filed under the pin-hydrated OLD id -- the
    // socket is never closed and this assertion times out.
    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('Half 2 (the mirror case): a REAL registerApp that narrows authority tears down a handle held under the wider pin-hydrated grant, with no explicit revoke at all', async () => {
    const storage = memoryLedgerStorage()
    const wideManifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const narrowManifest = manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } })

    const before = createBroker(baseDeps({ ledgerStorage: storage }))
    before.registerApp(APP, wideManifest)
    await before.grant(APP, 'tcp.connect', ['*:*'])

    const after = createBroker(baseDeps({ ledgerStorage: storage }))
    await after.app.hydrateFromPinnedManifest(APP, wideManifest)

    // A real handle, acquired under the wide pin-hydrated grant.
    const socket = await after.net.connect(APP, { host: '93.184.216.34', port: 443 })

    // The real, narrower manifest arrives -- authority DID change: the
    // persisted '*:*' no longer fits what narrowManifest declares, so
    // hydration drops tcp.connect entirely rather than reusing it.
    after.registerApp(APP, narrowManifest)

    // Unfixed: nothing ever calls handleTable.revoke for the wide grant's
    // id -- the ledger silently stopped tracking it, but the socket, still
    // authorised by that now-nonexistent grant, stays open forever.
    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })
})
