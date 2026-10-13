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
import { createIpfsGatherer } from '../ipfs/gatherer.js'
import { createNodeFirstGatherer } from '../ipfs/node-first.js'
import { ipfsProtocol, ipfsProtocolOf } from '../ipfs/protocol.js'
import type { FeedIndexStore } from '../swarm/feed.js'
import { swarmProtocol } from '../swarm/protocol.js'
import { dohAddressResolver, dohTxtResolver } from './doh.js'
import { allowlisted, DEFAULT_CCIP_LIMITS, guardedCcipRequest } from './egress.js'
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

export interface RunningProtocols {
  /** In the order their providers are tried. */
  readonly protocols: readonly Protocol[]
  readonly lightClient: LightClient | undefined
  readonly stores: SharedStores
}

/** What both routes keep across the host's life: the newest IPNS record and feed update seen, which must only ever move forward whichever route saw it. */
export interface SharedStores {
  readonly ipnsSequences: SequenceStore
  readonly swarmFeedIndexes: FeedIndexStore
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
}

function startIpfs (config: HostConfig, deps: HostDeps, node: NodeLink | undefined, controls: HostControls, stores: SharedStores): Protocol {
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
  const common = { resolveTxt: dohTxtResolver(config.dnsOverHttps, dohFetch), ipnsSequences: stores.ipnsSequences }
  const viaGateways = {
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    ...common
  }
  if (config.ipfsNode === undefined || node === undefined) return ipfsProtocol(viaGateways)

  // The node's own endpoint answers blocks and records; a name service is still asked for a record after it.
  const nodeOrigin = new URL(config.ipfsNode.endpoint).origin
  const nodeRead = node.reading(allowlisted([config.ipfsNode.endpoint], deps.fetch, 'the IPFS node'))
  const nameServiceFetch = allowlisted(config.ipnsNameServices, reach, 'the IPFS gatherer')
  const viaNode = {
    fetch: async (url: string, init: Parameters<Fetch>[1]) => await (new URL(url).origin === nodeOrigin ? nodeRead(url, init) : nameServiceFetch(url, init)),
    gateways: [config.ipfsNode.endpoint],
    // With the lookup service off, nothing third-party is asked for a record either, so "only the IPFS network is asked" is true.
    ipnsNameServices: () => controls.lookupService ? config.ipnsNameServices : [],
    localNode: true,
    storeKey: { header: PARTITION_HEADER, key: (partition: string) => partitionStoreKey(config.ipfsNode?.partitionSalt ?? '', partition) },
    ...common
  }
  return ipfsProtocolOf(createNodeFirstGatherer({
    node: createIpfsGatherer(viaNode),
    gateways: createIpfsGatherer(viaGateways),
    ready: async (signal) => {
      try {
        await node.ensure(signal)
      } catch (error) {
        throw error instanceof NodeUnavailable ? new Error(error.why) : error
      }
    }
  }))
}

function startSwarm (config: HostConfig, deps: HostDeps, node: NodeLink | undefined, stores: SharedStores): Protocol {
  const endpointFetch = allowlisted(config.swarmEndpoints, deps.fetch, 'the Swarm gatherer')
  const read: Fetch = async (url, init) => await endpointFetch(url, init)
  return swarmProtocol({
    fetch: config.swarmNode === true && node !== undefined ? node.reading(read) : read,
    endpoints: config.swarmEndpoints,
    feedIndexes: stores.swarmFeedIndexes,
    ...(config.swarmNode === true && node !== undefined && { beforeMount: node.ensure })
  })
}

function startEns (config: HostConfig, deps: HostDeps): { protocol: Protocol, lightClient: LightClient | undefined } {
  const resolvers: NameResolver[] = []
  if (config.fixtures !== undefined && deps.fixturesAllowed) resolvers.push(createFixtureResolver(config.fixtures))
  if (config.lightClient === undefined) {
    resolvers.push(offResolver(config.lightClientOff ?? 'the Ethereum light client is not running, so no .eth name can be verified'))
    return { protocol: defineProtocol(ENS, { resolvers }), lightClient: undefined }
  }
  const lightClient = deps.startLightClient(config.lightClient, allowlisted([...config.lightClient.executionRpcs, config.lightClient.consensusRpc], deps.fetch, 'the light client'), deps.post)
  resolvers.push(createEnsResolver({
    provider: lightClient.provider,
    ccipRequest: async (parameters, signal) => await guardedCcipRequest(parameters, { directFetch: deps.ccipFetch, fetch: deps.fetch, resolveHost: deps.resolveHost, direct: config.ccipDirect, farEnd: config.front !== undefined }, DEFAULT_CCIP_LIMITS, signal)
  }))
  return { protocol: defineProtocol(ENS, { resolvers }), lightClient }
}

export function startProtocols (config: HostConfig, deps: HostDeps, nodes?: NodeLinks, controls: HostControls = { lookupService: config.ipfsNode?.lookupService !== false }): RunningProtocols {
  const ens = startEns(config, deps)
  const ipfsNode = nodes?.to(IPFS_NODE_IDENTITY, IPFS_NODE_WORDS)
  const swarmNode = nodes?.to(SWARM_NODE_IDENTITY, SWARM_NODE_WORDS)
  const stores: SharedStores = { ipnsSequences: sequenceStore(config.ipnsSequences, deps.post), swarmFeedIndexes: feedIndexStore(config.swarmFeedIndexes, deps.post) }
  return {
    protocols: [ens.protocol, startIpfs(config, deps, ipfsNode, controls, stores), startSwarm(config, deps, swarmNode, stores)],
    lightClient: ens.lightClient,
    stores
  }
}
