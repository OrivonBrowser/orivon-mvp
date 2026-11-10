// A pinned endpoint's proxy challenge is answered by the route controller as an app's front's is, and only for the endpoint's own
// port: so a request made from main signs in, and the broker, which asks the controller which loopback ports Orivon holds, refuses
// an app's socket to it.

import { afterEach, describe, expect, it } from 'vitest'
import { ownLoopbackPortCheck } from '../../../broker/transport/own-loopback-ports.js'
import { createRouteController } from '../route-controller.js'
import type { RouteController } from '../route-controller.js'
import { createRouteHub } from '../route-hub.js'
import type { RouteHub } from '../route-hub.js'
import { RouteStore } from '../route-store.js'
import { pinnedEndpoint } from '../name-relay/pinned-endpoint.js'
import type { PinnedEndpoint } from '../name-relay/pinned-endpoint.js'
import type { NameRelayLink } from '../name-relay/relay-link.js'

const hubs: RouteHub[] = []
const endpoints: PinnedEndpoint[] = []
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.dispose()
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
})

function controllerWith (relay: NameRelayLink | undefined): RouteController {
  const store = new RouteStore(null)
  const hub = createRouteHub({ store, targetOf: () => ({ host: '127.0.0.1', port: 9050 }), defaultKind: () => 'socks5', everywhere: () => false, isApp: () => true, providerFor: () => ({ connect: async () => { throw new Error('unused') } }) })
  hubs.push(hub)
  return createRouteController({
    hub,
    broker: () => ({ dropOrigin: async () => {} }),
    sessionFor: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }),
    embedPartition: (origin) => `embed:${origin}`,
    allContents: () => [],
    onContentsCreated: () => {},
    onLogin: () => {},
    sharedBypass: () => '*.eth',
    setAppProxy: async () => {},
    ownProxy: () => false,
    ...(relay === undefined ? {} : { relay: () => relay })
  })
}

async function started (): Promise<{ endpoint: PinnedEndpoint, port: number }> {
  const endpoint = await pinnedEndpoint({ systemAnswer: async () => 'DIRECT' })
  endpoints.push(endpoint)
  return { endpoint, port: Number(/:(\d+)$/.exec(String(endpoint.config.proxyRules))?.[1]) }
}

const ask = (port: number): Parameters<RouteController['challengeCredentials']>[0] => ({ isProxy: true, host: '127.0.0.1', port })

describe('a proxy challenge from a pinned endpoint', () => {
  it('is answered with its credentials when the controller is given no relay at all, and for its own port only', async () => {
    const controller = controllerWith(undefined)
    const { endpoint, port } = await started()
    expect(controller.challengeCredentials(ask(port))).toEqual(endpoint.credentials(ask(port)))
    expect(controller.challengeCredentials(ask(port))?.password).toMatch(/^[0-9a-f]{20,}$/)
    expect(controller.challengeCredentials(ask(port + 1))).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: true, host: 'proxy.example', port })).toBeUndefined()
    expect(controller.challengeCredentials({ isProxy: false, host: '127.0.0.1', port })).toBeUndefined()
  })

  it('is answered beside the relay\'s own, which keeps answering for its listener', async () => {
    const relay: NameRelayLink = { config: () => undefined, credentials: (info) => info.port === 4545 ? { username: 'orivon', password: 'relay-secret' } : undefined }
    const controller = controllerWith(relay)
    const { port } = await started()
    expect(controller.challengeCredentials(ask(4545))).toEqual({ username: 'orivon', password: 'relay-secret' })
    expect(controller.challengeCredentials(ask(port))?.username).toBe('orivon')
  })

  it('is not answered once the endpoint is closed', async () => {
    const controller = controllerWith(undefined)
    const { endpoint, port } = await started()
    await endpoint.close()
    expect(controller.challengeCredentials(ask(port))).toBeUndefined()
  })

  it('makes the broker refuse an app\'s socket to the endpoint\'s port, and no other', async () => {
    const controller = controllerWith(undefined)
    const { port } = await started()
    const refuses = ownLoopbackPortCheck({ verifier: () => 0, nodes: () => new Set(), routeFront: (candidate) => controller.challengeCredentials(ask(candidate)) !== undefined })
    expect(refuses(port)).toBe(true)
    expect(refuses(port + 1)).toBe(false)
  })
})
