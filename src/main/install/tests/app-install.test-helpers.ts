// Shared fixtures for app-install.test.ts and update-outcomes.test.ts --
// both exercise the same installFromHint/driveLoadResult pipeline against
// the same Broker/Loader shapes (code-guidelines.md Rule 3: the reason for
// reuse is that both suites test the same seam, not a stylistic
// preference). Not *.test.ts, so vitest does not collect it as its own
// suite (matches broker/tests/index.test-helpers.ts's own naming).

import { vi } from 'vitest'
import { APP, stubBroker } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { LoadResult, Loader } from '../../../loader/index.js'
import type { CapabilityKind, Grant, Manifest } from '../../../contracts/index.js'

export function manifestWith (version = '1.0.0'): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

export function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0, ...overrides }
}

/**
 * `stubBroker` (ipc.test-helpers.ts) extended with `registerApp`/
 * `versionFloorFor`/`rollbackAcknowledgedVersionFor`/`acknowledgeRollback`
 * overrides -- see that file's own doc on why this reuses it rather than a
 * second full fake Broker. `calls` defaults to a throwaway array; pass one
 * in to assert which origin each method was actually called with.
 * `acknowledgedRollback` defaults to `undefined` (never acknowledged) --
 * the natural default for every test that isn't specifically about
 * rollback acknowledgement. `declinedCapabilities` defaults to `undefined`
 * (never declined) for the same reason (A145); `recordDeclinedConsent`/
 * `clearDeclinedConsent` default to a no-op, matching `acknowledgeRollback`'s
 * own default, since most tests here have no reason to care about either.
 */
export function fakeBroker (
  overrides: Partial<{
    grants: readonly Grant[]
    versionFloor: string
    acknowledgedRollback: string | undefined
    declinedCapabilities: readonly CapabilityKind[] | undefined
    registerApp: Broker['registerApp']
    grant: Broker['grant']
    acknowledgeRollback: Broker['acknowledgeRollback']
    recordDeclinedConsent: Broker['recordDeclinedConsent']
    clearDeclinedConsent: Broker['clearDeclinedConsent']
  }> = {},
  calls: BrokerCall[] = []
): Broker {
  return stubBroker(calls, {
    grants: async () => overrides.grants ?? [],
    versionFloorFor: async () => overrides.versionFloor ?? '0.0.0',
    rollbackAcknowledgedVersionFor: async () => overrides.acknowledgedRollback,
    declinedCapabilitiesFor: async () => overrides.declinedCapabilities,
    registerApp: overrides.registerApp ?? (async () => {}),
    grant: overrides.grant ?? (async (origin, capability, patterns) => ({ id: 'g1', origin, capability, patterns, grantedAt: 0 })),
    acknowledgeRollback: overrides.acknowledgeRollback ?? (async () => {}),
    recordDeclinedConsent: overrides.recordDeclinedConsent ?? (async () => {}),
    clearDeclinedConsent: overrides.clearDeclinedConsent ?? (async () => {})
  })
}

/** `manifestWith`, but declaring a real capability -- consent/capability-
 * widening tests need a manifest that is actually something to ask about;
 * most other tests rely on `manifestWith`'s empty default. */
export function manifestWithCapabilities (version = '1.0.0'): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: { net: { tcp: { connect: ['api.example.com:443'] } } } }
}

export function installedResult (manifest: Manifest): LoadResult {
  return { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: manifest.version, pinnedAt: 0 } }
}

/**
 * `installFetched`/`reconsider` default to throwing "not stubbed" --
 * `stubBroker`'s own convention -- so a test that does not expect S4-5's
 * outcome-driving to reach either one fails loudly rather than silently
 * resolving to `undefined` if it does.
 */
export function fakeLoader (
  result: LoadResult,
  overrides: Partial<{ installFetched: Loader['installFetched'], reconsider: Loader['reconsider'] }> = {}
): Loader & { load: ReturnType<typeof vi.fn>, installFetched: ReturnType<typeof vi.fn>, reconsider: ReturnType<typeof vi.fn> } {
  const notStubbed = (name: string) => async (): Promise<never> => { throw new Error(`loader.${name} was not stubbed for this test`) }
  return {
    load: vi.fn(async () => result),
    installFetched: vi.fn(overrides.installFetched ?? notStubbed('installFetched')),
    reconsider: vi.fn(overrides.reconsider ?? notStubbed('reconsider'))
  }
}

export const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }
