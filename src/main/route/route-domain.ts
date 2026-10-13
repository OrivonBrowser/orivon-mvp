// What the Settings page may ask about the tunnel: whether the proxy answers as a SOCKS5 proxy, which sites and apps have a
// setting or storage of their own, and clearing a website's own storage. The page sends no address to test; the proxy
// tested is the one the setting holds, so a page cannot make main connect anywhere it chooses. An origin it names is
// checked as the canonical origin of an address, and only a website that has storage of its own can be cleared.
import type { Socks5Probe } from '../../broker/route/socks5-probe.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import type { RouteSwitch } from './route-switch.js'

export interface RouteDomainDeps {
  /** The `network.route.proxy` setting as saved. */
  readonly proxy: () => string
  readonly probe: (target: { readonly host: string, readonly port: number }) => Promise<Socks5Probe>
  readonly routeSwitch: Pick<RouteSwitch, 'rows' | 'removeSiteStorage'>
}

export type ProxyTestReply = Socks5Probe | { readonly ok: false, readonly reason: 'no-proxy' }

export function routeDomain (deps: RouteDomainDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command): Promise<ProxyTestReply | { rows: ReturnType<RouteSwitch['rows']> } | { ok: boolean } | undefined> => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, origin?: unknown }
      switch (request.type) {
        case 'test': {
          const target = parseProxyAddress(deps.proxy())
          return target === undefined ? { ok: false, reason: 'no-proxy' } : await deps.probe(target)
        }
        case 'list':
          return { rows: deps.routeSwitch.rows() }
        case 'removeStorage': {
          if (typeof request.origin !== 'string' || originFromUrl(request.origin) !== request.origin) return { ok: false }
          try {
            return { ok: await deps.routeSwitch.removeSiteStorage(request.origin) }
          } catch (error) {
            console.error('[route] could not remove a website\'s own storage:', error)
            return { ok: false }
          }
        }
        default:
          return undefined
      }
    }
  }
}
