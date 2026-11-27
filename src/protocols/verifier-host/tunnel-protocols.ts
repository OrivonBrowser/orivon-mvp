// The protocols a website in a tunnel's profile is served from, one set for each tunnel. They share no network path with the
// ones every other website uses (`protocols.ts`), nor with the other tunnel's: each fetch they make is the routed fetch of
// their tunnel (`routed-fetch.ts`), and the name is proved by a light client of their own whose requests ride it too. A local node is asked only when `tunnelSitesReadNodes` says, for this tunnel, its
// traffic does not betray the site; otherwise the site's IPFS is read from gateways, through the tunnel, only after the
// person's yes. A tunnel that is down fails every fetch; nothing here has another way out to fall back to.

import { defineProtocol } from '../protocol.js'
import type { Protocol } from '../protocol.js'
import { ResolutionError } from '../resolution/records.js'
import type { DataGatherer } from '../resolution/providers.js'
import type { CcipRequest, Eip1193Provider } from '../ens/resolver.js'
import { ipfsProtocol } from '../ipfs/protocol.js'
import { swarmProtocol } from '../swarm/protocol.js'
import { createSwarmAddressResolvers } from '../swarm/address-resolver.js'
import { SWARM } from '../swarm/descriptor.js'
import { dohTxtResolver } from './doh.js'
import { allowlisted, DEFAULT_CCIP_LIMITS, guardedCcipRequest } from './egress.js'
import type { CcipDeps } from './egress.js'
import type { HostConfig, TunnelRoute } from './protocol.js'
import { ethereumNames, ipfsFromNode, LIGHT_CLIENT_NOT_RUNNING, nodeRouteOf } from './protocols.js'
import type { HostControls, SharedStores } from './protocols.js'
import type { NodeLink, NodeLinks } from './node-link.js'
import { IPFS_NODE_IDENTITY, IPFS_NODE_WORDS } from '../ipfs-node/protocol.js'
import { SWARM_NODE_IDENTITY, SWARM_NODE_WORDS } from '../swarm-node/protocol.js'
import type { HostDeps, LightClient } from './service.js'
import type { Fetch } from '../gateways/gateways.js'
import { lightClientFetch } from './light-client/lane-fetch.js'
import { lightClientPace, paceOn, routeFor } from './pace.js'
import type { RoutePace } from '../route-pace.js'
import { keptIn } from './swarm-chunk-memory.js'

/** What the person is told when a Swarm site is opened with the tunnel on for it, and "Use tunnel to run network nodes" is on. */
export const SWARM_NOT_TUNNELLED = 'Swarm content loads only from the Swarm node Orivon runs on this computer. "Use tunnel to run network nodes" is on in Settings under Tunnels, and the node cannot send its traffic through the tunnel for one site, so this site is not opened while the tunnel is on for it. Turn the tunnel off for it, or turn that setting off, to open it.'

/** Why the IPFS node does not serve a website that has its own tunnel, when "Use tunnel to run network nodes" is on. */
export const IPFS_NOT_TUNNELLED = 'the IPFS node runs outside the tunnel, and "Use tunnel to run network nodes" in Settings under Tunnels is on, so it does not serve a site that has the tunnel on by itself'

export interface TunnelProtocols {
  readonly protocols: readonly Protocol[]
  /** The tunnel route these protocols' requests travel, with what it has measured. */
  readonly route: RoutePace
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

/** The proven provider and the server reads of a light client that starts at its first request, so a host that serves no tunnel-profile `.eth` or `.og` name never syncs a second one. */
function lazyClient (start: () => LightClient): { provider: Eip1193Provider, servers: Eip1193Provider } {
  let client: LightClient | undefined
  const started = (): LightClient => (client ??= start())
  return {
    provider: { request: async (args) => await started().provider.request(args) },
    servers: { request: async (args) => await started().serverReads.request(args) }
  }
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

function startNames (config: HostConfig, deps: HostDeps, fetch: HostDeps['fetch'], route: RoutePace, tunnel: TunnelRoute): readonly Protocol[] {
  const { lightClient } = config
  if (lightClient === undefined) return ethereumNames(config, deps, { off: config.lightClientOff ?? LIGHT_CLIENT_NOT_RUNNING })
  const reach = lightClientFetch(lightClient, fetch, deps.localFetch, 'the light client')
  // The refusal depends on the config alone, so the shared client has already reported it to the shell (protocols.ts).
  if ('off' in reach) return ethereumNames(config, deps, { off: `the Ethereum servers set in Settings cannot be used: ${reach.off}` })
  const { provider, servers } = lazyClient(() => deps.startLightClient(lightClient, reach.send, () => {}, tunnel, { ...lightClientPace(paceOn(route)), startAfterMs: 0 }))
  const ccip = tunnelCcipDeps(fetch)
  const ccipRequest: CcipRequest = async (parameters, signal) => await guardedCcipRequest(parameters, ccip, DEFAULT_CCIP_LIMITS, signal)
  return ethereumNames(config, deps, { provider, ccipRequest, servers })
}

function startIpfs (config: HostConfig, deps: HostDeps, fetch: HostDeps['fetch'], stores: SharedStores, node: NodeLink | undefined, controls: HostControls, route: RoutePace, readsNodes: boolean): Protocol {
  const dohFetch = allowlisted(config.dnsOverHttps, fetch, 'DNS-over-HTTPS')
  const gatewayFetch = allowlisted([...config.gateways, ...config.ipnsNameServices], fetch, 'the IPFS gatherer')
  const common = { resolveTxt: dohTxtResolver(config.dnsOverHttps, dohFetch, route), ipnsSequences: stores.ipnsSequences, route }
  const viaGateways = {
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    ...common
  }
  // The person reads IPFS from gateways (no node chosen), or there is no node to ask: gateways, through the tunnel.
  if (config.ipfsNode === undefined || node === undefined) return ipfsProtocol(viaGateways)
  return ipfsFromNode({
    config,
    ipfsNode: config.ipfsNode,
    node,
    // The node is on loopback: the tunnel never carries a read from it.
    nodeFetch: allowlisted([config.ipfsNode.endpoint], deps.fetch, 'the IPFS node'),
    nameServiceFetch: allowlisted(config.ipnsNameServices, fetch, 'the IPFS gatherer'),
    viaGateways,
    common,
    controls,
    nodeRoute: nodeRouteOf(config, route),
    refusal: () => readsNodes ? undefined : IPFS_NOT_TUNNELLED
  })
}

function startSwarm (config: HostConfig, deps: HostDeps, node: NodeLink | undefined, stores: SharedStores, route: RoutePace, readsNodes: boolean, tunnel: TunnelRoute): Protocol {
  if (config.swarmNode !== true || node === undefined || !readsNodes) return refusedSwarm()
  const endpointFetch = allowlisted(config.swarmEndpoints, deps.fetch, 'the Swarm gatherer')
  return swarmProtocol({
    fetch: node.reading(async (url, init) => await endpointFetch(url, init)),
    endpoints: config.swarmEndpoints,
    route: nodeRouteOf(config, route),
    feedIndexes: stores.swarmFeedIndexes,
    log: (line) => { console.error(`[verifier] ${line}`) },
    ...(stores.swarmChunks !== undefined && keptIn(stores.swarmChunks, tunnel, deps.chunkChecks)),
    ...(deps.chunkChecks !== undefined && { checker: deps.chunkChecks }),
    beforeMount: node.ensure,
    ...(config.swarmSwitchedOff === true && { holdMounts: true })
  })
}

/** `names` are the shared `.eth` and `.og` protocols, which a website in a tunnel's profile uses when the light client runs outside the tunnel: its name is then proved by the same client every other website's is. `tunnel` is the tunnel these protocols are for. */
export function startTunnelProtocols (config: HostConfig, deps: HostDeps, stores: SharedStores, nodes: NodeLinks, controls: HostControls, names: readonly Protocol[], tunnel: TunnelRoute): TunnelProtocols {
  const fetch = deps.routedFetch(tunnel)
  const route = routeFor(true)
  const ipfsNode = nodes.to(IPFS_NODE_IDENTITY, IPFS_NODE_WORDS)
  const swarmNode = nodes.to(SWARM_NODE_IDENTITY, SWARM_NODE_WORDS)
  const readsNodes = config.tunnelSitesReadNodes?.[tunnel] === true
  return { protocols: [...(config.ethereumOutside === true ? names : startNames(config, deps, fetch, route, tunnel)), startIpfs(config, deps, fetch, stores, ipfsNode, controls, route, readsNodes), startSwarm(config, deps, swarmNode, stores, route, readsNodes, tunnel)], route }
}
