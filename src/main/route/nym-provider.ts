// The route provider of an app on Nym: the SOCKS5 provider, pointed at the host's loopback port with the app's
// isolation user name and the host's secret as the password. The host may not be running yet, or may have restarted
// on another port, so each use asks for its address first; a Nym that cannot run is a refusal, never a direct dial.

import { createSocks5Provider } from '../../broker/route/socks5.js'
import { fail } from '../../broker/errors.js'
import type { RouteProvider } from '../../broker/route/provider.js'
import type { RouteTarget } from '../../broker/route/table.js'
import type { NymEndpoint } from './nym-subsystem.js'

/**
 * The route target that stands for Nym. It names no address, because the host's port is new at each start: the
 * provider of a route to it asks for the address at each use. The route table compares targets by host and port,
 * so a switch between Nym and an address builds the route again.
 */
export const NYM_TARGET: RouteTarget = { host: 'nym.invalid', port: 0 }

export function isNymTarget (target: RouteTarget): boolean {
  return target.host === NYM_TARGET.host && target.port === NYM_TARGET.port
}

/** A tunnel comes up in a few seconds and a first connection through it takes a few more; the host gives up on a tunnel that cannot come up after three attempts, 95 s at most. */
export const NYM_CONNECT_TIMEOUT_MS = 100_000

export function createNymProvider (nym: { ensure: () => Promise<NymEndpoint> }, userId: string): RouteProvider {
  const through = async (): Promise<RouteProvider> => {
    let where: NymEndpoint
    try {
      where = await nym.ensure()
    } catch (error) {
      throw fail('unreachable', error instanceof Error ? error.message : 'Nym is not available')
    }
    return createSocks5Provider({ host: '127.0.0.1', port: where.port, credentials: { userId, password: where.secret }, timeoutMs: NYM_CONNECT_TIMEOUT_MS })
  }
  return {
    connect: async (host, port, signal) => await (await through()).connect(host, port, signal),
    udp: async (signal) => {
      const provider = await through()
      if (provider.udp === undefined) throw fail('denied', 'Nym carries no datagrams')
      return await provider.udp(signal)
    }
  }
}
