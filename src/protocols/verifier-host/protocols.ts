// The protocols the verifier host runs, each given the one way it may reach
// the network. Adding a built-in protocol is a descriptor in ../builtin.ts
// and its providers here; nothing else in the host changes.

import { defineProtocol } from '../protocol.js'
import type { Protocol } from '../protocol.js'
import { ResolutionError } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { ENS } from '../ens/descriptor.js'
import { createEnsResolver } from '../ens/resolver.js'
import type { SequenceStore } from '../ipfs/ipns.js'
import { createIpfsGatherer, LOCAL_NODE_BLOCK_RETRY } from '../ipfs/gatherer.js'
import type { IpfsGathererOptions } from '../ipfs/gatherer.js'
import { createNodeFirstGatherer } from '../ipfs/node-first.js'
import { ipfsProtocol, ipfsProtocolOf } from '../ipfs/protocol.js'
import type { FeedIndexStore } from '../swarm/feed.js'
import { swarmProtocol } from '../swarm/protocol.js'
import { dohAddressResolver, dohTxtResolver } from './doh.js'
import { allowlisted, DEFAULT_CCIP_LIMITS, guardedCcipRequest } from './egress.js'
import type { CcipDeps } from './egress.js'
import { withDnsFallback } from './dns-fallback.js'
import { createFixtureResolver } from './fixture-resolver.js'
import type { HostConfig } from './protocol.js'
import { NodeUnavailable } from './node-link.js'
import type { NodeLink, NodeLinks } from './node-link.js'
import { IPFS_NODE_IDENTITY, IPFS_NODE_WORDS, PARTITION_HEADER } from '../ipfs-node/protocol.js'
import { partitionStoreKey } from './partition-key.js'
import { SWARM_NODE_IDENTITY, SWARM_NODE_WORDS } from '../swarm-node/protocol.js'
import type { Fetch } from '../gateways/gateways.js'
import type { HostDeps, LightClient } from './service.js'
import { lightClientPace, paceOn, routeFor } from './pace.js'
import { DIRECT_ROUTE } from '../route-pace.js'
import type { RoutePace } from '../route-pace.js'
import { GatewayConsent } from './gateway-consent.js'
import { lightClientFetch } from './light-client/lane-fetch.js'
import { SwarmChunkDatabase } from './swarm-chunk-database.js'
import { keptIn } from './swarm-chunk-memory.js'

export interface RunningProtocols {
  /** In the order their providers are tried. */
  readonly protocols: readonly Protocol[]
  /** The `.eth` protocol among them, which a tunnel-profile website shares when the light client runs outside the tunnel. */
  readonly ens: Protocol
  readonly lightClient: LightClient | undefined
  readonly stores: SharedStores
  /** The route the host's own requests travel: slower than a direct connection when the whole browser is on a tunnel. */
  readonly route: RoutePace
}

/** What both routes keep across the host's life: the newest IPNS record and feed update seen, which must only ever move forward whichever route saw it. */
export interface SharedStores {
  readonly ipnsSequences: SequenceStore
  readonly swarmFeedIndexes: FeedIndexStore
  /** The verified Swarm chunks kept on disk, opened at the first mount in a partition; absent when the profile gave no place for them. */
  readonly swarmChunks?: SwarmChunkDatabase
}

export function sequenceStore (initial: Readonly<Record<string, string>>, post: HostDeps['post']): SequenceStore {
  const highest = new Map<string, bigint>()
  for (const [key, value] of Object.entries(initial)) {
    if (/^\d+$/.test(value)) highest.set(key, BigInt(value))
  }
  return {
    highest: (key) => highest.get(key),
    record: (key, sequence) => {
      const current = highest.get(key)
      if (current !== undefined && sequence <= current) return
      highest.set(key, sequence)
      post({ type: 'ipns-sequence', key, sequence: sequence.toString() })
    }
  }
}

export function feedIndexStore (initial: Readonly<Record<string, string>>, post: HostDeps['post']): FeedIndexStore {
  const highest = new Map<string, bigint>()
  for (const [feed, value] of Object.entries(initial)) {
    if (/^\d+$/.test(value)) highest.set(feed, BigInt(value))
  }
  return {
    highest: (owner, topic) => highest.get(`${owner}/${topic}`),
    record: (owner, topic, index) => {
      const feed = `${owner}/${topic}`
      const current = highest.get(feed)
      if (current !== undefined && index <= current) return
      highest.set(feed, index)
      post({ type: 'swarm-feed-index', feed, index: index.toString() })
    }
  }
}

export function offResolver (reason: string): NameResolver {
  return {
    id: 'ens',
    namespaces: ['.eth'],
    resolve: async () => { throw new ResolutionError('unavailable', reason) }
  }
}

/** What the shell can change while the host runs. */
export interface HostControls {
  /** Whether a name service may be asked for an IPNS record after the IPFS node. */
  lookupService: boolean
  /** The person's yes to a load through public gateways while their node could not serve it, one load each. */
  readonly consent: GatewayConsent
}

function startIpfs (config: HostConfig, deps: HostDeps, node: NodeLink | undefined, controls: HostControls, stores: SharedStores, route: RoutePace): Protocol {
  const dohFetch = allowlisted(config.dnsOverHttps, deps.fetch, 'DNS-over-HTTPS')
  // A251 (docs/open-questions.md): only for a gateway main found to have no
  // proxy in front of it, and only once net.fetch has already failed it
  // transport-wise, this reaches it directly instead -- everything else
  // (name services, a proxied gateway, an ordinary HTTP failure) is
  // unaffected and still goes through `deps.fetch` alone.
  const reach = withDnsFallback(config.unproxiedGateways, {
    fetch: deps.fetch,
    direct: deps.directFetch,
    systemAddresses: deps.resolveHost,
    dohAddresses: dohAddressResolver(config.dnsOverHttps, dohFetch),
    log: (line) => { console.error(`[verifier] ${line}`) }
  })
  const gatewayFetch = allowlisted([...config.gateways, ...config.ipnsNameServices], reach, 'the IPFS gatherer')
  const common = { resolveTxt: dohTxtResolver(config.dnsOverHttps, dohFetch, route), ipnsSequences: stores.ipnsSequences, route }
  const viaGateways = {
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    ...common
  }
  if (config.ipfsNode === undefined || node === undefined) return ipfsProtocol(viaGateways)
  const nameServiceFetch = allowlisted(config.ipnsNameServices, reach, 'the IPFS gatherer')
  return ipfsFromNode({ config, ipfsNode: config.ipfsNode, node, nodeFetch: allowlisted([config.ipfsNode.endpoint], deps.fetch, 'the IPFS node'), nameServiceFetch, viaGateways, common, controls, nodeRoute: nodeRouteOf(config, route) })
}

/** The route a local node's reads wait for: the host's route when the node runs through the tunnel, a direct connection's otherwise. */
export function nodeRouteOf (config: HostConfig, route: RoutePace): RoutePace {
  return config.nodesRouted === true ? route : DIRECT_ROUTE
}

/** What reading IPFS from the node needs, for the websites that share the direct route and for those in the tunnel profile alike. */
export interface IpfsFromNode {
  readonly config: HostConfig
  readonly ipfsNode: NonNullable<HostConfig['ipfsNode']>
  readonly node: NodeLink
  /** Reads the node's own endpoint on loopback; never carried by a tunnel. */
  readonly nodeFetch: Fetch
  /** Asked for an IPNS record after the node, when the lookup service is allowed. */
  readonly nameServiceFetch: Fetch
  /** The gateways, reached only after the person's yes for the site (`controls.consent`). */
  readonly viaGateways: IpfsGathererOptions
  readonly common: Pick<IpfsGathererOptions, 'resolveTxt' | 'ipnsSequences' | 'route'>
  /** The route the node's reads wait for: the node's own network, which is direct unless the node runs through the tunnel. */
  readonly nodeRoute: RoutePace
  readonly controls: HostControls
  /** Why the node must not serve, in words, when something other than the node's own state says so. */
  readonly refusal?: () => string | undefined
}

/** The node's own endpoint answers blocks and records; a name service is still asked for a record after it. */
export function ipfsFromNode (parts: IpfsFromNode): Protocol {
  const { config, ipfsNode, node, controls } = parts
  const nodeOrigin = new URL(ipfsNode.endpoint).origin
  const nodeRead = node.reading(parts.nodeFetch)
  const viaNode = {
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await (new URL(url).origin === nodeOrigin ? nodeRead(url, init) : parts.nameServiceFetch(url, init)),
    gateways: [ipfsNode.endpoint],
    // With the lookup service off, nothing third-party is asked for a record either, so "only the IPFS network is asked" is true.
    ipnsNameServices: () => controls.lookupService ? config.ipnsNameServices : [],
    localNode: true,
    ...(ipfsNode.retryWaitMs !== undefined && { limits: { blockRetry: { ...LOCAL_NODE_BLOCK_RETRY, waitMs: ipfsNode.retryWaitMs } } }),
    storeKey: { header: PARTITION_HEADER, key: (partition: string) => partitionStoreKey(ipfsNode.partitionSalt, partition) },
    ...parts.common,
    route: parts.nodeRoute
  }
  return ipfsProtocolOf(createNodeFirstGatherer({
    node: createIpfsGatherer(viaNode),
    gateways: createIpfsGatherer(parts.viaGateways),
    takeConsent: (partition) => controls.consent.take(partition),
    ready: async (signal) => {
      const refused = parts.refusal?.()
      if (refused !== undefined) throw new Error(refused)
      try {
        await node.ensure(signal)
      } catch (error) {
        throw error instanceof NodeUnavailable ? new Error(error.why) : error
      }
    }
  }))
}

function startSwarm (config: HostConfig, deps: HostDeps, node: NodeLink | undefined, stores: SharedStores, route: RoutePace): Protocol {
  const endpointFetch = allowlisted(config.swarmEndpoints, deps.fetch, 'the Swarm gatherer')
  const read: Fetch = async (url, init) => await endpointFetch(url, init)
  return swarmProtocol({
    fetch: config.swarmNode === true && node !== undefined ? node.reading(read) : read,
    endpoints: config.swarmEndpoints,
    route: config.swarmNode === true && node !== undefined ? nodeRouteOf(config, route) : route,
    feedIndexes: stores.swarmFeedIndexes,
    log: (line) => { console.error(`[verifier] ${line}`) },
    ...(stores.swarmChunks !== undefined && keptIn(stores.swarmChunks)),
    ...(config.swarmNode === true && node !== undefined && { beforeMount: node.ensure, ...(config.swarmSwitchedOff === true && { holdMounts: true }) })
  })
}

/**
 * Where the light client and CCIP-Read leave: through the tunnel's front while the whole browser is on it, unless the person asked them to run
 * outside the tunnel and this host has the path for it. `pace` is the route their waits are stretched for.
 */
function ethereumRoute (config: HostConfig, deps: HostDeps, tunnel: RoutePace): { readonly web: HostDeps['fetch'], readonly ccip: CcipDeps, readonly pace: RoutePace } {
  const outside = config.ethereumOutside === true && config.front !== undefined ? deps.outside : undefined
  if (outside !== undefined) return { web: outside.send, ccip: { directFetch: deps.ccipFetch, fetch: outside.send, resolveHost: outside.resolveHost, direct: true }, pace: DIRECT_ROUTE }
  return { web: deps.fetch, ccip: { directFetch: deps.ccipFetch, fetch: deps.fetch, resolveHost: deps.resolveHost, direct: config.ccipDirect, farEnd: config.front !== undefined }, pace: tunnel }
}

function startEns (config: HostConfig, deps: HostDeps, tunnel: RoutePace): { protocol: Protocol, lightClient: LightClient | undefined } {
  const resolvers: NameResolver[] = []
  if (config.fixtures !== undefined && deps.fixturesAllowed) resolvers.push(createFixtureResolver(config.fixtures))
  if (config.lightClient === undefined) {
    resolvers.push(offResolver(config.lightClientOff ?? 'the Ethereum light client is not running, so no .eth name can be verified'))
    return { protocol: defineProtocol(ENS, { resolvers }), lightClient: undefined }
  }
  const route = ethereumRoute(config, deps, tunnel)
  const reach = lightClientFetch(config.lightClient, route.web, deps.localFetch, 'the light client')
  if ('off' in reach) {
    // The main process logs a failed status and shows it on the status page and in a report; this host's own output reaches neither.
    const reason = `the Ethereum servers set in Settings cannot be used: ${reach.off}`
    deps.post({ type: 'status', status: { state: 'failed', reason, retryAt: undefined } })
    resolvers.push(offResolver(reason))
    return { protocol: defineProtocol(ENS, { resolvers }), lightClient: undefined }
  }
  const lightClient = deps.startLightClient(config.lightClient, reach.send, deps.post, undefined, lightClientPace(paceOn(route.pace)))
  resolvers.push(createEnsResolver({
    provider: lightClient.provider,
    ccipRequest: async (parameters, signal) => await guardedCcipRequest(parameters, route.ccip, DEFAULT_CCIP_LIMITS, signal)
  }))
  return { protocol: defineProtocol(ENS, { resolvers }), lightClient }
}

export function startProtocols (config: HostConfig, deps: HostDeps, nodes?: NodeLinks, controls: HostControls = { lookupService: config.ipfsNode?.lookupService !== false, consent: new GatewayConsent() }): RunningProtocols {
  const route = routeFor(config.front !== undefined)
  const ens = startEns(config, deps, route)
  const ipfsNode = nodes?.to(IPFS_NODE_IDENTITY, IPFS_NODE_WORDS)
  const swarmNode = nodes?.to(SWARM_NODE_IDENTITY, SWARM_NODE_WORDS)
  const stores: SharedStores = {
    ipnsSequences: sequenceStore(config.ipnsSequences, deps.post),
    swarmFeedIndexes: feedIndexStore(config.swarmFeedIndexes, deps.post),
    ...(config.swarmChunks !== undefined && { swarmChunks: new SwarmChunkDatabase({ ...config.swarmChunks, log: (line) => { console.error(`[verifier] ${line}`) } }) })
  }
  return {
    protocols: [ens.protocol, startIpfs(config, deps, ipfsNode, controls, stores, route), startSwarm(config, deps, swarmNode, stores, route)],
    ens: ens.protocol,
    lightClient: ens.lightClient,
    stores,
    route
  }
}
