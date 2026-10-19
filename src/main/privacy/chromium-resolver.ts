// The broker's name resolution through Chromium's own resolver, so an app's direct connections see the same DNS
// answers as a page's: the "Secure DNS" setting (`secure-dns.ts`) is applied to Chromium's resolver alone, and the
// system resolver the broker's node adapters ask never hears of it. Only the answers are translated here; which of
// them an app may reach is still the broker's policy, applied to what these return. The caller passes the default
// session's `net.resolveHost`: the resolver's configuration (Secure DNS, host-resolver rules) is process-wide, and a
// direct dial has no session of its own. Tied to Electron only through the `resolveHost` it is given.
import { isIP } from 'node:net'
import { fail } from '../../broker/errors.js'
import type { Resolver } from '../../broker/policy/connect.js'
import type { LookupAddress } from '../../contracts/index.js'

/** Electron's `net.resolveHost`, in the one shape used here. */
export type ChromiumResolveHost = (host: string) => Promise<{ readonly endpoints: ReadonlyArray<{ readonly address: string, readonly family: 'ipv4' | 'ipv6' | 'unspec' }> }>

export interface ChromiumResolvers {
  /** `CreateBrokerOptions.resolve`: the addresses a connect will dial and the policy judges. */
  readonly resolveHost: Resolver
  /** `CreateBrokerOptions.resolveLookup`: `orivon.net.lookup`'s answers. */
  readonly resolveLookup: (hostname: string) => Promise<readonly LookupAddress[]>
}

/** Chromium's answers in its order, each with the family its address has; an entry that is not an address is dropped. */
function answersOf (endpoints: Awaited<ReturnType<ChromiumResolveHost>>['endpoints']): LookupAddress[] {
  const answers: LookupAddress[] = []
  for (const endpoint of endpoints) {
    // "unspec" carries no family, so the address says which it is.
    const version = endpoint.family === 'ipv4' ? 4 : endpoint.family === 'ipv6' ? 6 : isIP(endpoint.address)
    if (version === 4) answers.push({ address: endpoint.address, family: 'IPv4' })
    else if (version === 6) answers.push({ address: endpoint.address, family: 'IPv6' })
  }
  return answers
}

/** A failure to resolve is 'unreachable' (handle-contracts.md), never a broker fault, whether Chromium failed or found nothing. */
export function chromiumResolvers (resolveHost: ChromiumResolveHost): ChromiumResolvers {
  const resolve = async (host: string): Promise<LookupAddress[]> => {
    let answers: LookupAddress[]
    try {
      answers = answersOf((await resolveHost(host)).endpoints)
    } catch (error) {
      throw fail('unreachable', `could not resolve ${host}`, undefined, error instanceof Error ? error.message : undefined)
    }
    if (answers.length === 0) throw fail('unreachable', `could not resolve ${host}`)
    return answers
  }
  return {
    resolveHost: async (host) => (await resolve(host)).map((answer) => answer.address),
    resolveLookup: resolve
  }
}
