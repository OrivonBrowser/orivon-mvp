import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { DIRECT_ROUTE } from '../../../route-pace.js'
import type { RoutePace } from '../../../route-pace.js'
import { paceOf, routeOf } from '../route-of.js'

const request = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage)

describe('the route a request travels', () => {
  it('is the tunnel the shell marked it with, and the direct route otherwise', () => {
    expect(routeOf(request({ 'x-orivon-route': 'nym' }))).toBe('nym')
    expect(routeOf(request({ 'x-orivon-route': 'socks5' }))).toBe('socks5')
    expect(routeOf(request({}))).toBe('direct')
  })

  it('is the direct route for a mark that is not exactly a tunnel, which a page could have forged', () => {
    for (const forged of ['Nym', 'tunnel', 'direct', 'nym,socks5', 'SOCKS5', '']) expect(routeOf(request({ 'x-orivon-route': forged })), forged).toBe('direct')
  })
})

describe('the pace of a route', () => {
  it('is the direct pace for the direct route, and the tunnel\'s own for each tunnel', () => {
    const nym = { id: 'nym' } as RoutePace
    const proxy = { id: 'socks5' } as RoutePace
    const routes = { direct: DIRECT_ROUTE, tunnel: (route: 'nym' | 'socks5') => route === 'nym' ? nym : proxy }
    expect(paceOf('direct', routes)).toBe(DIRECT_ROUTE)
    expect(paceOf('nym', routes)).toBe(nym)
    expect(paceOf('socks5', routes)).toBe(proxy)
  })
})
