import { describe, expect, it } from 'vitest'
import { wrapBrokerForSyncFsGrants } from '../sync-fs-grants.js'
import type { Broker } from '../../broker-contracts.js'
import type { CapabilityKind, Grant, Pattern } from '../../../contracts/index.js'

// Proves the mirror this lane relies on for a live, race-free "does this
// origin hold an fs grant" check, without ../index.ts's own GrantLedger
// (out of this lane's reach -- see ../sync-fs-grants.ts's own header). Every
// assertion here is checkable purely from Broker.grant/revoke's own public
// contract: this suite never reaches into the mirror's internals.

const APP = 'https://app.example'
let nextGrantId = 0

/** A minimal Broker double: grant()/revoke() behave like the real ledger's (one live grant per capability, replace-on-regrant); every other member is unused by this suite and only needs to satisfy the type. */
function fakeGrantingBroker (): Broker {
  const live = new Map<string, Map<CapabilityKind, Grant>>()
  const notUsed = async (): Promise<never> => { throw new Error('not exercised by this suite') }

  return {
    app: { manifest: notUsed, grants: notUsed },
    net: { connect: notUsed, udpBind: notUsed, listen: notUsed },
    fs: { readFile: notUsed, writeFile: notUsed },
    id: { publicKey: notUsed, sign: notUsed },
    registerApp: notUsed,
    versionFloorFor: notUsed,
    rollbackAcknowledgedVersionFor: notUsed,
    acknowledgeRollback: notUsed,
    grant: async (origin, capability, patterns: readonly Pattern[]) => {
      const record: Grant = { id: `g${++nextGrantId}`, origin, capability, patterns, grantedAt: 0 }
      const forOrigin = live.get(origin) ?? new Map<CapabilityKind, Grant>()
      forOrigin.set(capability, record)
      live.set(origin, forOrigin)
      return record
    },
    revoke: async (origin, grantId) => {
      const forOrigin = live.get(origin)
      if (forOrigin === undefined) return
      for (const [capability, grant] of forOrigin) {
        if (grant.id === grantId) forOrigin.delete(capability)
      }
    }
  }
}

describe('wrapBrokerForSyncFsGrants', () => {
  it('reports no fs grant before any grant is issued', () => {
    const { hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())
    expect(hasFsGrant(APP)).toBe(false)
  })

  it('reports a live fs grant immediately after broker.grant(..., "fs", ...) resolves', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())

    await broker.grant(APP, 'fs', [])

    expect(hasFsGrant(APP)).toBe(true)
  })

  it('does not report an fs grant for a DIFFERENT capability', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())

    await broker.grant(APP, 'id', [])

    expect(hasFsGrant(APP)).toBe(false)
  })

  it('canonicalises the origin the same way ../policy/origin.ts\'s originFromUrl does, so a default-port variant matches', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())

    await broker.grant('https://app.example:443', 'fs', [])

    expect(hasFsGrant(APP)).toBe(true)
  })

  it('clears the mirror when the CURRENT fs grant is revoked', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())
    const record = await broker.grant(APP, 'fs', [])

    await broker.revoke(APP, record.id)

    expect(hasFsGrant(APP)).toBe(false)
  })

  it('does NOT clear the mirror when an unrelated grantId is revoked', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())
    await broker.grant(APP, 'fs', [])

    await broker.revoke(APP, 'some-other-grant-id')

    expect(hasFsGrant(APP)).toBe(true)
  })

  it('re-granting fs (replacing the prior grant) keeps the mirror true under the new id', async () => {
    const { broker, hasFsGrant } = wrapBrokerForSyncFsGrants(fakeGrantingBroker())
    const first = await broker.grant(APP, 'fs', [])
    const second = await broker.grant(APP, 'fs', [])

    expect(first.id).not.toBe(second.id)
    expect(hasFsGrant(APP)).toBe(true)

    // Revoking the now-superseded first id must not clear a grant it no
    // longer names -- the mirror tracks the CURRENT grant id, not merely
    // "fs was ever granted".
    await broker.revoke(APP, first.id)
    expect(hasFsGrant(APP)).toBe(true)

    await broker.revoke(APP, second.id)
    expect(hasFsGrant(APP)).toBe(false)
  })

  it('delegates every other Broker method unchanged', async () => {
    const inner = fakeGrantingBroker()
    const { broker } = wrapBrokerForSyncFsGrants(inner)

    // grant/revoke are wrapped; everything else must be the SAME reference,
    // proving the spread did not accidentally re-wrap or drop a member.
    expect(broker.app).toBe(inner.app)
    expect(broker.net).toBe(inner.net)
    expect(broker.fs).toBe(inner.fs)
    expect(broker.id).toBe(inner.id)
    expect(broker.registerApp).toBe(inner.registerApp)
  })
})
