// What the Settings page may ask about the tunnel: what Nym is doing, whether the tunnel answers, which sites and apps have a
// setting or storage of their own, and clearing a website's own storage. The page sends no address to test; what is
// tested is the choice the settings hold (Nym, or the SOCKS5 address saved), so a page cannot make main connect anywhere
// it chooses. An origin it names is checked as the canonical origin of an address, and only a website that has storage
// of its own can be cleared.
import type { Socks5Probe } from '../../broker/route/socks5-probe.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { parseProxyAddress } from '../settings/proxy-checks.js'
import type { NymState, NymTestResult } from './nym-status.js'
import type { RouteSwitch } from './route-switch.js'

export interface RouteDomainDeps {
  /** The `network.route.proxy` setting as saved. */
  readonly proxy: () => string
  /** The `network.route.kind` setting as saved. */
  readonly kind: () => 'nym' | 'socks5'
  readonly probe: (target: { readonly host: string, readonly port: number }) => Promise<Socks5Probe>
  readonly nym: { readonly state: () => NymState, readonly test: () => Promise<NymTestResult> }
  readonly routeSwitch: Pick<RouteSwitch, 'rows' | 'removeSiteStorage'>
}

export type ProxyTestReply = Socks5Probe | { readonly ok: false, readonly reason: 'no-proxy' } | ({ readonly nym: true } & NymTestResult)

/** What the page is sent about Nym, on request and whenever it changes. */
export interface NymView {
  readonly nym: NymState
}

export function routeDomain (deps: RouteDomainDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command): Promise<ProxyTestReply | NymView | { rows: ReturnType<RouteSwitch['rows']> } | { ok: boolean } | undefined> => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, origin?: unknown }
      switch (request.type) {
        case 'status':
          return { nym: deps.nym.state() }
        case 'test': {
          if (deps.kind() === 'nym') return { nym: true, ...await deps.nym.test() }
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
