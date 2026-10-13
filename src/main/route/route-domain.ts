// What the Settings page may ask about the proxy: whether it answers as a SOCKS5 proxy. The page sends no address; the
// proxy tested is the one the setting holds, so a page cannot make main connect anywhere it chooses.
import type { Socks5Probe } from '../../broker/route/socks5-probe.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'

export interface RouteDomainDeps {
  /** The `network.route.proxy` setting as saved. */
  readonly proxy: () => string
  readonly probe: (target: { readonly host: string, readonly port: number }) => Promise<Socks5Probe>
}

export type ProxyTestReply = Socks5Probe | { readonly ok: false, readonly reason: 'no-proxy' }

export function routeDomain (deps: RouteDomainDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command): Promise<ProxyTestReply | undefined> => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'test') return undefined
      const target = parseProxyAddress(deps.proxy())
      return target === undefined ? { ok: false, reason: 'no-proxy' } : await deps.probe(target)
    }
  }
}
