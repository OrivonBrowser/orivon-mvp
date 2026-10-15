import { describe, expect, it } from 'vitest'
import { GatewayPool } from '../../gateways/gateways.js'
import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE } from '../../route-pace.js'
import { retryOn } from '../block-fetch.js'
import { LOCAL_NODE_BLOCK_RETRY } from '../gatherer.js'

describe('what a route does to a block fetch\'s patience', () => {
  it('leaves a direct connection\'s retries as they were written', () => {
    expect(retryOn(LOCAL_NODE_BLOCK_RETRY, DIRECT_ROUTE)).toEqual(LOCAL_NODE_BLOCK_RETRY)
  })

  it('gives a slow route more tries, for longer, but keeps the pause the node\'s own memory needs', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    const retry = retryOn(LOCAL_NODE_BLOCK_RETRY, route)
    expect(retry.maxRetries).toBe(LOCAL_NODE_BLOCK_RETRY.maxRetries * 3)
    expect(retry.startByMs).toBe(route.wait(LOCAL_NODE_BLOCK_RETRY.startByMs))
    expect(retry.waitMs).toBe(LOCAL_NODE_BLOCK_RETRY.waitMs)
  })

  it('waits longer before it asks a second gateway as well, while no gateway has answered yet', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    const pool = new GatewayPool(['https://a.gateway', 'https://b.gateway'], 4, Date.now, { route })
    expect(pool.hedgeDelay('https://a.gateway', 2_000)).toBe(route.wait(2_000))
    expect(new GatewayPool(['https://a.gateway'], 4).hedgeDelay('https://a.gateway', 2_000)).toBe(2_000)
  })
})
