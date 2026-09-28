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
import { ipfsProtocol } from '../ipfs/protocol.js'
import { dohAddressResolver, dohTxtResolver } from './doh.js'
import { allowlisted, DEFAULT_CCIP_LIMITS, guardedCcipRequest } from './egress.js'
import { withDnsFallback } from './dns-fallback.js'
import { createFixtureResolver } from './fixture-resolver.js'
import type { HostConfig } from './protocol.js'
import type { HostDeps, LightClient } from './service.js'

export interface RunningProtocols {
  /** In the order their providers are tried. */
  readonly protocols: readonly Protocol[]
  readonly lightClient: LightClient | undefined
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

function offResolver (reason: string): NameResolver {
  return {
    id: 'ens',
    namespaces: ['.eth'],
    resolve: async () => { throw new ResolutionError('unavailable', reason) }
  }
}

function startIpfs (config: HostConfig, deps: HostDeps): Protocol {
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
  return ipfsProtocol({
    fetch: async (url, init) => await gatewayFetch(url, init),
    gateways: config.gateways,
    ipnsNameServices: config.ipnsNameServices,
    resolveTxt: dohTxtResolver(config.dnsOverHttps, dohFetch),
    ipnsSequences: sequenceStore(config.ipnsSequences, deps.post)
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
    ccipRequest: async (parameters, signal) => await guardedCcipRequest(parameters, { fetch: deps.fetch, resolveHost: deps.resolveHost }, DEFAULT_CCIP_LIMITS, signal)
  }))
  return { protocol: defineProtocol(ENS, { resolvers }), lightClient }
}

export function startProtocols (config: HostConfig, deps: HostDeps): RunningProtocols {
  const ens = startEns(config, deps)
  return { protocols: [ens.protocol, startIpfs(config, deps)], lightClient: ens.lightClient }
}
