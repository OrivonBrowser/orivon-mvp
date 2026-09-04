import { describe, expect, it } from 'vitest'
import { createBroker } from './index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from './index.test-helpers.js'

// createBroker's `ledgerStorage` option threads straight into GrantLedger's
// constructor (./index.ts), so most of A57's behaviour is already covered at
// that unit's own level (grant-ledger.test.ts). What is specific to THIS
// layer -- and would not be caught there -- is the dependency-injection
// wiring itself: `baseDeps` used to enumerate `CreateBrokerOptions`' known
// keys by hand and had silently stopped forwarding `ledgerStorage` once it
// was added, so `createBroker(baseDeps({ ledgerStorage: someStorage }))`
// built a broker with no persistence at all, with nothing signalling the
// drop.
describe('createBroker -- ledgerStorage actually reaches the grant ledger', () => {
  it('a version floor raised through the Broker surface is written via the injected LedgerStorage', () => {
    const storage = memoryLedgerStorage()
    const broker = createBroker(baseDeps({ ledgerStorage: storage }))

    broker.registerApp(APP, manifestWith({}))

    expect(storage.floors.get(APP)).toBe('1.0.0') // manifestWith's fixed version
  })

  it('versionFloorFor reads back what a previous broker instance persisted -- simulates surviving a restart', async () => {
    const storage = memoryLedgerStorage()
    const before = createBroker(baseDeps({ ledgerStorage: storage }))
    before.registerApp(APP, manifestWith({}))

    const after = createBroker(baseDeps({ ledgerStorage: storage })) // the "restart"
    await expect(after.versionFloorFor(APP)).resolves.toBe('1.0.0')
  })
})
