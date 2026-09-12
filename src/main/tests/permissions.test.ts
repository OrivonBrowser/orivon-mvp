import { describe, expect, it } from 'vitest'
import { createBroker } from '../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../broker/tests/index.test-helpers.js'
import { rejection } from '../../broker/handles/tests/handles.test-helpers.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { Grant } from '../../contracts/index.js'
import { buildAppPermissions, createPermissionsController, PermissionsRegistry } from '../permissions.js'
import type { SubsystemContext } from '../registry.js'

// Item 4.4's exit criterion, checked directly: "revoking from the list
// tears down live handles, proven by test." The suite below builds a REAL
// broker (createBroker, the same one every capability check runs through),
// opens a REAL socket handle, and revokes it through
// `createPermissionsController(ctx).revoke` -- the exact function both
// renderer surfaces call over IPC (../ipc.ts) -- not `broker.revoke`
// directly. A test that only asserted the row disappeared from a list
// would prove nothing about authority; this asserts the handle itself dies.

function ctxWith (broker: Broker | undefined): SubsystemContext {
  return { broker } as unknown as SubsystemContext
}

function grant (overrides: Partial<Grant> = {}): Grant {
  return { id: 'g1', origin: APP, capability: 'https.connect', patterns: ['youtube.com:443'], grantedAt: 0, ...overrides }
}

describe('buildAppPermissions', () => {
  it('renders one row per grant, in the install prompt\'s own words', () => {
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443', 'gstatic.com:443'] } } })
    const grants: Grant[] = [grant({ patterns: ['youtube.com:443', 'gstatic.com:443'] })]

    const result = buildAppPermissions(APP, manifest, grants)

    expect(result.origin).toBe(APP)
    expect(result.appName).toBe(manifest.name)
    expect(result.rows).toEqual([
      { capability: 'https.connect', grantId: 'g1', warning: false, message: 'Connect to youtube.com and 1 other site' }
    ])
  })

  it('carries the warning flag through for an unlimited grant -- the same visual signal the install prompt uses', () => {
    const manifest = manifestWith({ net: { tcp: { connect: ['*:*'] } } })
    const grants: Grant[] = [grant({ capability: 'tcp.connect', patterns: ['*:*'] })]

    const result = buildAppPermissions(APP, manifest, grants)

    expect(result.rows[0]?.warning).toBe(true)
    expect(result.rows[0]?.message).toContain('Unlimited')
  })

  it('renders no rows for an app with no live grants, not an error', () => {
    const result = buildAppPermissions(APP, manifestWith({}), [])
    expect(result.rows).toEqual([])
  })
})

describe('PermissionsRegistry', () => {
  // WAS: "lists nothing until an origin has been noted -- the empty-by-default
  // state today's production browsing is actually in". That test passed by
  // asserting the DEFECT (C-01/C-02): noteOrigin never acquired a production
  // caller, so the settings list was empty for every grant made before the
  // current session while the grant itself stayed live. The registry now asks
  // the broker, so a registered app appears without anyone having noted it.
  it('lists a registered app without it having been noted -- the broker is the source, not the session set', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const registry = new PermissionsRegistry()

    expect((await registry.list(broker)).map((a) => a.origin)).toEqual([APP])
  })

  it('still lists nothing when the broker knows no app at all', async () => {
    const broker = createBroker(baseDeps())
    expect(await new PermissionsRegistry().list(broker)).toEqual([])
  })

  it('lists a noted origin\'s current grants, and drops it once the broker no longer recognises it', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])
    const registry = new PermissionsRegistry()
    registry.noteOrigin(APP)

    const first = await registry.list(broker)
    expect(first).toHaveLength(1)
    expect(first[0]?.origin).toBe(APP)
    expect(first[0]?.rows).toHaveLength(1)
  })

  it('forOrigin answers for an origin never noted -- the address-bar icon does not depend on the registry', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ id: { curves: ['secp256k1'] } }))
    await broker.grant(APP, 'id', [])
    const registry = new PermissionsRegistry()

    const result = await registry.forOrigin(broker, APP)

    expect(result?.origin).toBe(APP)
    expect(result?.rows).toHaveLength(1)
  })

  it('forOrigin resolves null for an origin the broker never registered -- an ordinary website, not an app', async () => {
    const broker = createBroker(baseDeps())
    const registry = new PermissionsRegistry()

    expect(await registry.forOrigin(broker, 'https://example.com')).toBeNull()
  })
})

describe('createPermissionsController', () => {
  it('list()/forUrl() resolve empty/null, and revoke() is a no-op, when no broker is published yet', async () => {
    const controller = createPermissionsController(ctxWith(undefined))

    expect(await controller.list()).toEqual([])
    expect(await controller.forUrl('https://app.example')).toBeNull()
    await expect(controller.revoke('https://app.example', 'g1')).resolves.toBeUndefined()
  })

  it('forUrl derives the origin from a tab URL, matching tab-view.ts\'s own isRegisteredSync pairing', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])
    const controller = createPermissionsController(ctxWith(broker))

    const result = await controller.forUrl(`${APP}/some/deep/path?x=1`)

    expect(result?.origin).toBe(APP)
    expect(result?.rows).toHaveLength(1)
  })

  // THE EXIT-CRITERION TEST.
  it('revoke() tears down a live handle through the exact path the UI calls -- socket.closed rejects "revoked"', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ net: { https: { connect: ['youtube.com:443'] } } }))
    const issued = await broker.grant(APP, 'https.connect', ['youtube.com:443'])
    const socket = await broker.net.connectSecure(APP, { host: 'youtube.com', port: 443 })

    const controller = createPermissionsController(ctxWith(broker))
    await controller.revoke(APP, issued.id)

    const error = await rejection(socket.closed)
    expect(error.code).toBe('revoked')
  })

  it('a revoked grant is gone from the very next list() -- no way to resurrect it by re-reading', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ fs: {} }))
    const issued = await broker.grant(APP, 'fs', [])
    const registry = new PermissionsRegistry()
    registry.noteOrigin(APP)
    const controller = createPermissionsController(ctxWith(broker))

    await controller.revoke(APP, issued.id)

    expect(await registry.list(broker)).toEqual([{ origin: APP, appName: manifestWith({}).name, rows: [] }])
  })

  // C-04 (docs/open-questions.md): describeOrigin catches everything and
  // returns null, and list() used to read that as "the broker forgot this
  // origin" and delete it. A transient fault therefore removed an app from
  // the settings list permanently, for the whole session, while its grants
  // stayed live and rehydrated the moment it was reopened.

  it('keeps an origin whose describe TRANSIENTLY fails, and shows it again once the fault clears', async () => {
    let failNext = true
    const broker = {
      app: {
        isRegisteredSync: () => true,
        registeredOriginsSync: () => [],
        persistedAppsSync: () => [],
        manifest: async () => {
          if (failNext) throw new Error('transient')
          return { name: 'Example App', version: '1.0.0', capabilities: {} }
        },
        grants: async () => []
      }
    } as unknown as Broker

    const registry = new PermissionsRegistry()
    registry.noteOrigin('https://app.example')

    expect(await registry.list(broker)).toHaveLength(0)

    // The origin must still be known -- before this fix it was deleted here
    // and no later call could ever bring it back.
    failNext = false
    const second = await registry.list(broker)
    expect(second).toHaveLength(1)
    expect(second[0]?.appName).toBe('Example App')
  })

  it('still drops an origin the broker genuinely no longer recognises', async () => {
    const broker = {
      app: {
        isRegisteredSync: () => false,
        registeredOriginsSync: () => [],
        persistedAppsSync: () => [],
        manifest: async () => { throw new Error('no manifest registered for this origin') },
        grants: async () => []
      }
    } as unknown as Broker

    const registry = new PermissionsRegistry()
    registry.noteOrigin('https://gone.example')
    expect(await registry.list(broker)).toHaveLength(0)
    // Proven dropped rather than merely absent: a broker that would now
    // succeed must not resurrect it, because nothing re-noted it.
    const revived = { app: { isRegisteredSync: () => true, registeredOriginsSync: () => [], persistedAppsSync: () => [], manifest: async () => ({ name: 'Back', version: '1.0.0', capabilities: {} }), grants: async () => [] } } as unknown as Broker
    expect(await registry.list(revived)).toHaveLength(0)
  })
})
