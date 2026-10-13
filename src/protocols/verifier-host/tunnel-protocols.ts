// The protocols a tunnel-profile website is served from. They share no network path with the ones every other website
// uses (`protocols.ts`): each fetch they make is the routed fetch (`routed-fetch.ts`), the name is proved by a light
// client of their own whose requests ride it too, and no local node is asked. A tunnel that is down fails every one of
// them; nothing here has another way out to fall back to.

import { defineProtocol } from '../protocol.js'
import type { Protocol } from '../protocol.js'
import { ResolutionError } from '../resolution/records.js'
import type { DataGatherer } from '../resolution/providers.js'
import { ENS } from '../ens/descriptor.js'
import { createEnsResolver } from '../ens/resolver.js'
import type { Eip1193Provider } from '../ens/resolver.js'
import { ipfsProtocol } from '../ipfs/protocol.js'
import { createSwarmAddressResolvers } from '../swarm/address-resolver.js'
import { SWARM } from '../swarm/descriptor.js'
import { dohTxtResolver } from './doh.js'
import { allowlisted, DEFAULT_CCIP_LIMITS, guardedCcipRequest } from './egress.js'
import type { CcipDeps } from './egress.js'
import { createFixtureResolver } from './fixture-resolver.js'
import type { HostConfig } from './protocol.js'
import { offResolver } from './protocols.js'
import type { SharedStores } from './protocols.js'
import type { HostDeps, LightClient } from './service.js'
import type { Fetch } from '../gateways/gateways.js'

/** What the person is told when a Swarm site is opened with the tunnel on for it. */
export const SWARM_NOT_TUNNELLED = 'Swarm content loads only from the Swarm node Orivon runs on this computer, and that node cannot send its traffic through your tunnel for one site. This site is not opened while the tunnel is on for it; turn the tunnel off for it to open it.'

export interface TunnelProtocols {
  readonly protocols: readonly Protocol[]
}

/** The Swarm gatherer of a tunnel-profile website: it claims Swarm content in order to say why it is not loaded, and reads nothing. */
function refusedSwarm (): Protocol {
  const gatherer: DataGatherer = {
    id: 'swarm',
    supports: (records) => records.some((record) => record.pointer.kind === 'swarm'),
    mount: async () => { throw new ResolutionError('unavailable', SWARM_NOT_TUNNELLED) }
  }
  return defineProtocol(SWARM, { resolvers: createSwarmAddressResolvers(), gatherers: [gatherer] })
}

/** The provider of a light client that starts at its first request, so a host that serves no tunnel-profile `.eth` name never syncs a second one. */
function lazyProvider (start: () => LightClient): Eip1193Provider {
  let client: LightClient | undefined
  return { request: async (args) => await (client ??= start()).provider.request(args) }
}

/** A CCIP-Read request of a tunnel-profile website: the same fence as any other, sent through `fetch`, with no name resolved here and no pinned dial. */
export function tunnelCcipDeps (fetch: HostDeps['fetch']): CcipDeps {
  return {
    directFetch: async () => { throw new Error('a tunnelled request is never dialled directly') },
    fetch,
    resolveHost: async () => { throw new Error('a name is resolved at the far end of the tunnel, not on this computer') },
    direct: false,
    farEnd: true
  }
}

function startEns (config: HostConfig, deps: HostDeps, fetch: HostDeps['fetch']): Protocol {
  const resolvers = []
  if (config.fixtures !== undefined && deps.fixturesAllowed) resolvers.push(createFixtureResolver(config.fixtures))
  const { lightClient } = config
  if (lightClient === undefined) {
    resolvers.push(offResolver(config.lightClientOff ?? 'the Ethereum light client is not running, so no .eth name can be verified'))
    return defineProtocol(ENS, { resolvers })
  }
  const provider = lazyProvider(() => deps.startLightClient(lightClient, allowlisted([...lightClient.executionRpcs, lightClient.consensusRpc], fetch, 'the light client'), () => {}, 'tunnel'))
  const ccip = tunnelCcipDeps(fetch)
  resolvers.push(createEnsResolver({ provider, ccipRequest: async (parameters, signal) => await guardedCcipRequest(parameters, ccip, DEFAULT_CCIP_LIMITS, signal) }))
  return defineProtocol(ENS, { resolvers })
}

function startIpfs (config: HostConfig, fetch: HostDeps['fetch'], stores: SharedStores): Protocol {
  const dohFetch = allowlisted(config.dnsOverHttps, fetch, 'DNS-over-HTTPS')
  const gatewayFetch = allowlisted([...config.gateways, ...config.ipnsNameServices], fetch, 'the IPFS gatherer')
  return ipfsProtocol({
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    resolveTxt: dohTxtResolver(config.dnsOverHttps, dohFetch),
    ipnsSequences: stores.ipnsSequences
  })
}

export function startTunnelProtocols (config: HostConfig, deps: HostDeps, stores: SharedStores): TunnelProtocols {
  const fetch = deps.routedFetch
  return { protocols: [startEns(config, deps, fetch), startIpfs(config, fetch, stores), refusedSwarm()] }
}
