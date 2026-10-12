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
import { createSwarmNodeLink } from './swarm-node-link.js'
import type { SwarmNodeNotice } from '../swarm-node/protocol.js'
import type { FromHost, HostConfig, HostReplies, HostRequest, LightClientConfig, LightClientState, SiteProvenance } from './protocol.js'
import { createVerifierServer } from './serve/server.js'
import { MOUNT_TIMEOUT_MS, Sites } from './serve/sites.js'
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
  readonly startLightClient: (config: LightClientConfig, fetch: WebFetch, report: (message: FromHost) => void) => LightClient
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
}

export interface RunningHost {
  readonly server: Server
  readonly port: number
  readonly fingerprint: string
  answer: (request: HostRequest) => Promise<HostReplies[HostRequest['kind']]>
  /** What main says the Swarm node is doing. */
  swarmNode: (notice: SwarmNodeNotice) => void
}

export async function startHost (config: HostConfig, deps: HostDeps): Promise<RunningHost> {
  const swarmNode = createSwarmNodeLink(deps.post)
  const { protocols, lightClient } = startProtocols(config, deps, swarmNode)
  const registry = new ProtocolRegistry(protocols)
  // A top-level-domain name is shown by where its content lives, which is known once a gatherer is chosen for its records.
  const sites = new Sites(registry, Date.now, MOUNT_TIMEOUT_MS, (host, gatherer) => {
    const served = registry.addresses.servedName(host)
    const scheme = registry.schemeOfGatherer(gatherer)
    if (served?.namespace.startsWith('.') === true && scheme !== undefined) deps.post({ type: 'name-scheme', host: served.name, scheme })
  })
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
    ({ host, resolver, root: site.root, pointers: site.pointers, ddoc: site.ddoc(), mountedAt })

  const answer = async (request: HostRequest): Promise<HostReplies[HostRequest['kind']]> => {
    switch (request.kind) {
      case 'status': return lightClient?.status() ?? { state: 'off' }
      case 'mount': return provenanceOf(request.host, await sites.get(request.host, request.partition))
      case 'provenance': {
        const current = await sites.current(request.host, request.partition)
        return current === undefined ? null : provenanceOf(request.host, current)
      }
    }
  }

  return {
    server,
    port: (server.address() as AddressInfo).port,
    fingerprint: certificate.fingerprint,
    answer,
    swarmNode: swarmNode.notice
  }
}
