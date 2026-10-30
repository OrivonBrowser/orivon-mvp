// The verifier host's work, apart from the process it runs in: every
// protocol's providers behind the registry, the loopback server, and the
// answers the shell asks for. entry.ts gives it Electron's net and the parent port.

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { ProtocolRegistry } from '../registry.js'
import type { Eip1193Provider } from '../ens/resolver.js'
import { createRunCertificate } from './serve/certificate.js'
import type { WebFetch } from './egress.js'
import type { DirectFetch } from './direct-fetch.js'
import type { ChunkCheckPool } from './chunk-check-pool.js'
import { startProtocols } from './protocols.js'
import { startTunnelProtocols } from './tunnel-protocols.js'
import { NodeLinks } from './node-link.js'
import { GatewayConsent } from './gateway-consent.js'
import type { FromHost, NodeNotice, HostConfig, HostReplies, HostRequest, LightClientConfig, LightClientState, SiteProvenance, TunnelRoute } from './protocol.js'
import { createVerifierServer } from './serve/server.js'
import type { LightClientPace } from './light-client/light-client.js'
import { paceOn } from './pace.js'
import type { RoutePace } from '../route-pace.js'
import { RoutedSites, Sites } from './serve/sites.js'
import type { MountedSite } from '../resolution/providers.js'
import type { SiteRecord } from './serve/sites.js'

export interface LightClient {
  /** Throws a ResolutionError `not-synced` while the client cannot yet prove anything. */
  readonly provider: Eip1193Provider
  status: () => LightClientState
}

export interface HostDeps {
  readonly fetch: WebFetch
  readonly resolveHost: (host: string) => Promise<readonly string[]>
  readonly post: (message: FromHost) => void
  /** `route` a tunnel: the client that proves the names of the websites in that tunnel's profile, which reports nothing and has requests of its own. */
  readonly startLightClient: (config: LightClientConfig, fetch: WebFetch, report: (message: FromHost) => void, route?: TunnelRoute, pace?: LightClientPace) => LightClient
  /** True only in a test build; fixture names are refused otherwise, whatever the config says. */
  readonly fixturesAllowed: boolean
  /** The DNS-tamper fallback's own egress (dns-fallback.ts), reached only
   * for a gateway in `config.unproxiedGateways` once `fetch` has failed it
   * transport-wise and a DNS-over-HTTPS answer disagreed with the system
   * resolver's. GET/HEAD only, no redirect. */
  readonly directFetch: DirectFetch
  /** CCIP-Read's own egress (egress.ts's `guardedCcipRequest`): pinned to
   * the address `resolveHost` already checked, so a re-resolving fetch can
   * never dial somewhere else than what was checked. Unlike `directFetch`
   * above, allows the POST form and follows a redirect (the caller decides
   * whether to, per hop). */
  readonly ccipFetch: DirectFetch
  /** Everything a website in a tunnel's profile needs from the network goes through this and nothing else: that profile's front (`routed-fetch.ts`). */
  readonly routedFetch: (route: TunnelRoute) => WebFetch
  /**
   * What leaves outside the tunnel while the whole browser is on it (`outside-fetch.ts`), for the Ethereum light client when the person
   * asked the nodes to run outside the tunnel (`HostConfig.ethereumOutside`). Absent in a host with no such path: the light client then
   * follows the tunnel.
   */
  readonly outside?: { readonly send: WebFetch, readonly resolveHost: (host: string) => Promise<readonly string[]> }
  /**
   * How the Ethereum light client reaches a server the person runs on this computer or their home network, at an address literal
   * they typed in (`local-rpc-fetch.ts`): Node sockets to that address, never a proxy and never a tunnel, on every route. Absent in a
   * host with no such path: a light client whose config names a local server then does not start.
   */
  readonly localFetch?: WebFetch
  /**
   * Where a Swarm chunk is checked against its address: a few worker threads, so a site read back from disk does not hold the thread
   * every protocol is served on (`chunk-check-pool.ts`). Absent in a host with none: each chunk is then checked in the thread that asks.
   */
  readonly chunkChecks?: ChunkCheckPool
}

export interface RunningHost {
  readonly server: Server
  readonly port: number
  readonly fingerprint: string
  answer: (request: HostRequest) => Promise<HostReplies[HostRequest['kind']]>
  /** What main says a local node is doing. */
  node: (notice: NodeNotice) => void
  /** Whether a name service may be asked for an IPNS record after the IPFS node, from the next lookup. */
  ipfsLookup: (allowed: boolean) => void
}

/** A site mounted from gateways with a reason was mounted because the person's node could not serve it and they said yes for that load (`ServedFrom`): no other mount gives a reason. */
const usedGatewaysByYes = (site: MountedSite): boolean => site.servedFrom?.kind === 'gateways' && site.servedFrom.reason !== undefined

export async function startHost (config: HostConfig, deps: HostDeps): Promise<RunningHost> {
  const nodes = new NodeLinks(deps.post)
  const consent = new GatewayConsent()
  const controls = { lookupService: config.ipfsNode?.lookupService !== false, consent }
  const { protocols, lightClient, stores, route, ens } = startProtocols(config, deps, nodes, controls)
  const registry = new ProtocolRegistry(protocols)
  // The protocols of a tunnel are started at the first request of a website in its profile: a person who uses one tunnel never pays for the other's.
  const tunnelSets = new Map<TunnelRoute, { readonly sites: Sites, readonly route: RoutePace }>()
  // A top-level-domain name is shown by where its content lives, which is known once a gatherer is chosen for its records.
  const sitesOf = (of: ProtocolRegistry, via: RoutePace): Sites => new Sites(of, Date.now, () => paceOn(via).mountTimeoutMs, (host, gatherer) => {
    const served = of.addresses.servedName(host)
    const scheme = of.schemeOfGatherer(gatherer)
    if (served?.namespace.startsWith('.') === true && scheme !== undefined) deps.post({ type: 'name-scheme', host: served.name, scheme })
  }, (site, partition) => usedGatewaysByYes(site) || (site.servedFrom?.kind === 'node' && consent.pending(partition)))
  const tunnelSet = (tunnel: TunnelRoute): { readonly sites: Sites, readonly route: RoutePace } => {
    let set = tunnelSets.get(tunnel)
    if (set === undefined) {
      const protocolsOf = startTunnelProtocols(config, deps, stores, nodes, controls, ens, tunnel)
      set = { sites: sitesOf(new ProtocolRegistry(protocolsOf.protocols), protocolsOf.route), route: protocolsOf.route }
      tunnelSets.set(tunnel, set)
    }
    return set
  }
  const sites = new RoutedSites(sitesOf(registry, route), (tunnel) => tunnelSet(tunnel).sites)
  const certificate = createRunCertificate()
  const server = createVerifierServer(registry, sites, certificate, undefined, { direct: route, tunnel: (tunnel) => tunnelSet(tunnel).route }, consent)
  server.once('close', () => { deps.chunkChecks?.close() })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const provenanceOf = (host: string, { site, resolver, mountedAt }: SiteRecord): SiteProvenance =>
    ({ host, resolver, root: site.root, pointers: site.pointers, ddoc: site.ddoc(), mountedAt, ...(site.servedFrom !== undefined && { servedFrom: site.servedFrom }) })

  const answer = async (request: HostRequest): Promise<HostReplies[HostRequest['kind']]> => {
    switch (request.kind) {
      case 'status': return lightClient?.status() ?? { state: 'off' }
      case 'mount': return provenanceOf(request.host, await (request.latest === true ? sites.latest(request.host, request.partition, request.route) : sites.get(request.host, request.partition, request.route)))
      case 'provenance': {
        const current = await sites.current(request.host, request.partition, request.route)
        return current === undefined ? null : provenanceOf(request.host, current)
      }
    }
  }

  return {
    server,
    port: (server.address() as AddressInfo).port,
    fingerprint: certificate.fingerprint,
    answer,
    node: (notice) => { nodes.notice(notice) },
    ipfsLookup: (allowed) => { controls.lookupService = allowed }
  }
}
