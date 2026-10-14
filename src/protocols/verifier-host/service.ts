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
import { startProtocols } from './protocols.js'
import { startTunnelProtocols } from './tunnel-protocols.js'
import { NodeLinks } from './node-link.js'
import type { FromHost, NodeNotice, HostConfig, HostReplies, HostRequest, LightClientConfig, LightClientState, SiteProvenance } from './protocol.js'
import { createVerifierServer } from './serve/server.js'
import type { LightClientPace } from './light-client/light-client.js'
import { paceOf } from './pace.js'
import { RoutedSites, Sites } from './serve/sites.js'
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
  /** `route` tunnel: the client that proves the names of tunnel-profile websites, which reports nothing and has requests of its own. */
  readonly startLightClient: (config: LightClientConfig, fetch: WebFetch, report: (message: FromHost) => void, route?: 'tunnel', pace?: LightClientPace) => LightClient
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
  /** Everything a tunnel-profile website needs from the network goes through this and nothing else: the tunnel profile's front (`routed-fetch.ts`). */
  readonly routedFetch: WebFetch
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

export async function startHost (config: HostConfig, deps: HostDeps): Promise<RunningHost> {
  const nodes = new NodeLinks(deps.post)
  const controls = { lookupService: config.ipfsNode?.lookupService !== false }
  const { protocols, lightClient, stores } = startProtocols(config, deps, nodes, controls)
  const registry = new ProtocolRegistry(protocols)
  const tunnelRegistry = new ProtocolRegistry(startTunnelProtocols(config, deps, stores).protocols)
  // A top-level-domain name is shown by where its content lives, which is known once a gatherer is chosen for its records.
  const sitesOf = (of: ProtocolRegistry, tunnelled: boolean): Sites => new Sites(of, Date.now, paceOf(tunnelled).mountTimeoutMs, (host, gatherer) => {
    const served = of.addresses.servedName(host)
    const scheme = of.schemeOfGatherer(gatherer)
    if (served?.namespace.startsWith('.') === true && scheme !== undefined) deps.post({ type: 'name-scheme', host: served.name, scheme })
  })
  const sites = new RoutedSites(sitesOf(registry, config.front !== undefined), sitesOf(tunnelRegistry, true))
  const certificate = createRunCertificate()
  const server = createVerifierServer(registry, sites, certificate)
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
      case 'mount': return provenanceOf(request.host, await sites.get(request.host, request.partition, request.route))
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
