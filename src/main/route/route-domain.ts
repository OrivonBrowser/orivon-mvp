// What the Settings page may ask about the tunnel: what Nym is doing, and whether the tunnel answers. The page sends
// no address; what is tested is the choice the settings hold (Nym, or the SOCKS5 address saved), so a page cannot
// make main connect anywhere it chooses.
import type { Socks5Probe } from '../../broker/route/socks5-probe.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import type { NymState, NymTestResult } from './nym-status.js'

export interface RouteDomainDeps {
  /** The `network.route.proxy` setting as saved. */
  readonly proxy: () => string
  /** The `network.route.kind` setting as saved. */
  readonly kind: () => 'nym' | 'socks5'
  readonly probe: (target: { readonly host: string, readonly port: number }) => Promise<Socks5Probe>
  readonly nym: { readonly state: () => NymState, readonly test: () => Promise<NymTestResult> }
}

export type ProxyTestReply = Socks5Probe | { readonly ok: false, readonly reason: 'no-proxy' } | ({ readonly nym: true } & NymTestResult)

/** What the page is sent about Nym, on request and whenever it changes. */
export interface NymView {
  readonly nym: NymState
}

export function routeDomain (deps: RouteDomainDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command): Promise<ProxyTestReply | NymView | undefined> => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type === 'status') return { nym: deps.nym.state() }
      if (type !== 'test') return undefined
      if (deps.kind() === 'nym') return { nym: true, ...await deps.nym.test() }
      const target = parseProxyAddress(deps.proxy())
      return target === undefined ? { ok: false, reason: 'no-proxy' } : await deps.probe(target)
    }
  }
}
