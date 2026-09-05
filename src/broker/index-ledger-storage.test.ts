import { describe, expect, it } from 'vitest'
import { createBroker } from './index.js'
import { APP, baseDeps, manifestWith, memoryLedgerStorage } from './index.test-helpers.js'
import type { LedgerStorage } from './ledger-storage.js'

/** A LedgerStorage whose write always fails, the way a full or read-only disk does. */
function throwingLedgerStorage (): LedgerStorage {
  return {
    readVersionFloor: () => undefined,
    writeVersionFloor: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) },
    deleteVersionFloor: () => {},
    readAcknowledgedRollbackVersion: () => undefined,
    writeAcknowledgedRollbackVersion: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) },
    deleteAcknowledgedRollbackVersion: () => {}
  }
}

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

// d-0017's counterpart to the suite above -- same wiring concern
// (`baseDeps`'s spread once silently dropped `ledgerStorage` entirely; see
// that suite's own header), proven again for the two new Broker methods
// rather than assumed to follow from GrantLedger's own coverage.
describe('createBroker -- rollback acknowledgement (d-0017) reaches the grant ledger', () => {
  it('is undefined through the Broker surface for an origin never acknowledged', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))

    await expect(broker.rollbackAcknowledgedVersionFor(APP)).resolves.toBeUndefined()
  })

  it('acknowledging a version through the Broker surface is written via the injected LedgerStorage', async () => {
    const storage = memoryLedgerStorage()
    const broker = createBroker(baseDeps({ ledgerStorage: storage }))

    await broker.acknowledgeRollback(APP, '1.1.9')

    expect(storage.rollbackAcks.get(APP)).toBe('1.1.9')
  })

  it('rollbackAcknowledgedVersionFor reads back what a previous broker instance persisted -- simulates surviving a restart', async () => {
    const storage = memoryLedgerStorage()
    const before = createBroker(baseDeps({ ledgerStorage: storage }))
    await before.acknowledgeRollback(APP, '1.1.9')

    const after = createBroker(baseDeps({ ledgerStorage: storage })) // the "restart"
    await expect(after.rollbackAcknowledgedVersionFor(APP)).resolves.toBe('1.1.9')
  })

  // The property the version-keyed redesign exists for, proven again
  // through the Broker surface rather than assumed to follow from
  // GrantLedger's own coverage: accepting 1.1.9 must not read back as an
  // acknowledgement of a different version, 1.1.8.
  it('acknowledging 1.1.9 is not indistinguishable from acknowledging 1.1.8', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))

    await broker.acknowledgeRollback(APP, '1.1.9')

    await expect(broker.rollbackAcknowledgedVersionFor(APP)).resolves.not.toBe('1.1.8')
    await expect(broker.rollbackAcknowledgedVersionFor(APP)).resolves.toBe('1.1.9')
  })
})

describe('createBroker -- an acknowledgeRollback persistence failure surfaces, it is not swallowed', () => {
  it('rejects, rather than resolving as if the acknowledgement had been recorded', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    await expect(broker.acknowledgeRollback(APP, '1.1.9')).rejects.toMatchObject({
      name: 'OrivonError',
      code: 'internal',
      platformCode: 'ENOSPC'
    })
  })

  it('carries no filesystem path -- the message is written fresh, like registerApp\'s own persistence-failure path', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    const error = await broker.acknowledgeRollback(APP, '1.1.9').catch((e: unknown) => e)

    expect((error as Error).message).not.toContain('no space left on device')
  })

  it('still raised the in-memory acknowledged version before the write was attempted', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    await expect(broker.acknowledgeRollback(APP, '1.1.9')).rejects.toThrow()

    await expect(broker.rollbackAcknowledgedVersionFor(APP)).resolves.toBe('1.1.9')
  })
})

// GrantLedger.registerApp throws when the floor cannot be written (see its
// own doc). `Broker.registerApp` is `async`, so that throw is already a
// rejected promise for its caller -- what this layer adds is the error SHAPE.
// `canonical()` in index.ts rejects a malformed origin with an OrivonError,
// so a raw Node error escaping from the persistence path would make one
// method reject with two unrelated shapes.
describe('createBroker -- a persistence failure surfaces, it is not swallowed', () => {
  it('rejects, rather than resolving as if the app had been registered', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    await expect(broker.registerApp(APP, manifestWith({}))).rejects.toMatchObject({
      name: 'OrivonError',
      code: 'internal',
      platformCode: 'ENOSPC'
    })
  })

  it('does not throw synchronously -- the rejection is the promise, matching every other Broker method', () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    let thrown: unknown
    let result: Promise<void> | undefined
    try {
      result = broker.registerApp(APP, manifestWith({}))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeUndefined()
    expect(result).toBeInstanceOf(Promise)
    return expect(result).rejects.toThrow()
  })

  it('carries no filesystem path -- the message is written fresh, like mapIoError does for the app-facing methods', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    const error = await broker.registerApp(APP, manifestWith({})).catch((e: unknown) => e)

    expect((error as Error).message).not.toContain('no space left on device')
  })

  // The property the whole item exists for, asserted through the public
  // surface rather than only on GrantLedger: the floor is raised regardless.
  it('still raised the version floor before the write was attempted', async () => {
    const broker = createBroker(baseDeps({ ledgerStorage: throwingLedgerStorage() }))

    await expect(broker.registerApp(APP, manifestWith({}))).rejects.toThrow()

    await expect(broker.versionFloorFor(APP)).resolves.toBe('1.0.0')
  })
})
