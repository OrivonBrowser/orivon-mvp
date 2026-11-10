// Which lookup the check of a CCIP-Read gateway judges a name by, for each way the host reaches the network.

import { describe, expect, it } from 'vitest'
import { DIRECT_ROUTE } from '../../route-pace.js'
import type { HostConfig } from '../protocol.js'
import { ethereumRoute } from '../protocols.js'
import type { HostDeps } from '../service.js'

const own = async (): Promise<readonly string[]> => ['10.0.0.1']
const relayed = async (): Promise<readonly string[]> => ['93.184.216.34']
const outside = async (): Promise<readonly string[]> => ['93.184.216.99']

function deps (extra: Partial<HostDeps> = {}): HostDeps {
  return { resolveHost: own, fetch: async () => new Response(), ccipFetch: async () => new Response(), ...extra } as unknown as HostDeps
}

describe('the lookup the check of a CCIP-Read gateway uses', () => {
  it('is the one the host was given for the check, when it was given one', () => {
    const route = ethereumRoute({ ccipDirect: false } as HostConfig, deps({ resolveForCheck: relayed }), DIRECT_ROUTE)
    expect(route.ccip.resolveHost).toBe(relayed)
  })

  it('is the host\'s own when it was given none', () => {
    expect(ethereumRoute({ ccipDirect: false } as HostConfig, deps(), DIRECT_ROUTE).ccip.resolveHost).toBe(own)
  })

  it('is left to the far end of a tunnel, which looks the name up, however the check was given', () => {
    const route = ethereumRoute({ ccipDirect: false, front: { port: 1, username: 'u', password: 'p' } } as unknown as HostConfig, deps({ resolveForCheck: relayed }), DIRECT_ROUTE)
    expect(route.ccip.farEnd).toBe(true)
  })

  it('is the outside route\'s own, for a lane the person asked to run outside the tunnel', () => {
    const config = { ccipDirect: false, ethereumOutside: true, front: { port: 1, username: 'u', password: 'p' } } as unknown as HostConfig
    const route = ethereumRoute(config, deps({ resolveForCheck: relayed, outside: { send: async () => new Response(), resolveHost: outside } }), DIRECT_ROUTE)
    expect(route.ccip.resolveHost).toBe(outside)
  })
})
