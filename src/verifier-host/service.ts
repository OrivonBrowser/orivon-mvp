// The verifier host's work, apart from the process it runs in: resolvers and
// gatherers behind the registry, the loopback server, and the answers the
// shell asks for. entry.ts gives it Electron's net and the parent port.

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { ResolutionError } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { ResolutionRegistry } from '../resolution/registry.js'
import { createEnsResolver } from '../ens/resolver.js'
import type { Eip1193Provider } from '../ens/resolver.js'
import { createIpfsGatherer } from '../ipfs/gatherer.js'
import type { SequenceStore } from '../ipfs/ipns.js'
import { createRunCertificate } from './certificate.js'
import { dohTxtResolver } from './doh.js'
import { allowlisted, guardedCcipRequest } from './egress.js'
import type { WebFetch } from './egress.js'
import { createFixtureResolver } from './fixture-resolver.js'
import type { FromHost, HostConfig, HostReplies, HostRequest, LightClientConfig, LightClientState, SiteProvenance } from './protocol.js'
import { createEthServer } from './server.js'
import { Sites } from './sites.js'
import type { SiteRecord } from './sites.js'

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
}

export interface RunningHost {
  readonly server: Server
  readonly port: number
  readonly fingerprint: string
  answer: (request: HostRequest) => Promise<HostReplies[HostRequest['kind']]>
}

function sequenceStore (initial: Readonly<Record<string, string>>, post: HostDeps['post']): SequenceStore {
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

const offResolver: NameResolver = {
  id: 'ens',
  topLevelDomains: ['eth'],
  resolve: async () => { throw new ResolutionError('unavailable', 'the Ethereum light client is switched off, so no .eth name can be verified') }
}

export async function startHost (config: HostConfig, deps: HostDeps): Promise<RunningHost> {
  const gatewayFetch = allowlisted([...config.gateways, ...config.ipnsNameServices], deps.fetch, 'the IPFS gatherer')
  const gatherer = createIpfsGatherer({
    fetch: async (url, init) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    resolveTxt: dohTxtResolver(config.dnsOverHttps, allowlisted(config.dnsOverHttps, deps.fetch, 'DNSLink')),
    ipnsSequences: sequenceStore(config.ipnsSequences, deps.post)
  })

  let lightClient: LightClient | undefined
  const resolvers: NameResolver[] = []
  if (config.fixtures !== undefined && deps.fixturesAllowed) resolvers.push(createFixtureResolver(config.fixtures))
  if (config.lightClient === undefined) {
    resolvers.push(offResolver)
  } else {
    lightClient = deps.startLightClient(config.lightClient, allowlisted([...config.lightClient.executionRpcs, config.lightClient.consensusRpc], deps.fetch, 'the light client'), deps.post)
    resolvers.push(createEnsResolver({
      provider: lightClient.provider,
      ccipRequest: async (parameters) => await guardedCcipRequest(parameters, { fetch: deps.fetch, resolveHost: deps.resolveHost })
    }))
  }

  const sites = new Sites(new ResolutionRegistry(resolvers, [gatherer]))
  const certificate = createRunCertificate()
  const server = createEthServer(sites, certificate)
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
      case 'mount': return provenanceOf(request.host, await sites.get(request.host))
      case 'provenance': {
        const current = await sites.current(request.host)
        return current === undefined ? null : provenanceOf(request.host, current)
      }
    }
  }

  return {
    server,
    port: (server.address() as AddressInfo).port,
    fingerprint: certificate.fingerprint,
    answer
  }
}
