import type { CreateBrokerOptions } from '../broker-contracts.js'
import { isolationKeyFromUrl } from '../policy/origin.js'
import { proxyProbeUrl } from '../policy/proxy-guard.js'

/** `Broker.app.reachBypassesProxy`: the question `orivon.net` asks before an unrouted dial, put to the loader's reach path. */
export function createReachProxyCheck (deps: Pick<CreateBrokerOptions, 'routeFor' | 'proxyConfigured'>): (origin: string, host: string, port: number) => Promise<boolean> {
  return async (origin, host, port) => {
    const key = isolationKeyFromUrl(origin) ?? origin
    if (deps.routeFor?.(key) !== undefined) return false
    return await deps.proxyConfigured(proxyProbeUrl(host, port))
  }
}
