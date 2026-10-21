import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRoutedPage, isTemporaryRoutePartitionLive, isTemporaryRouteSession, leaveFor, openTemporaryRoute, routeAppToo, setLeavingRoutes } from '../leaving-routes.js'

afterEach(() => { setLeavingRoutes(undefined) })

function running (blocked: 'no-proxy' | 'not-cached' | undefined = undefined) {
  const choose = vi.fn(async () => {})
  const open = vi.fn(async (_kind: string) => 'orivon-route-tab-1')
  const session = {}
  setLeavingRoutes({
    world: { isRouted: (origin) => origin === 'https://routed.example', isInstalledApp: (origin) => origin.endsWith('.example'), routedOriginOf: (partition) => partition === 'persist:app-routed' ? 'https://routed.example' : undefined, servedOrigin: () => undefined },
    temporary: { open, owns: (one) => one === session, isLive: (partition) => partition === 'orivon-route-tab-1' },
    routeSwitch: { blockedFor: () => blocked, choose },
    kindOf: (origin) => origin === 'https://routed.example' ? 'socks5' : undefined,
    defaultKind: () => 'nym'
  })
  return { choose, open, session }
}

describe('what the shell asks of the routes', () => {
  it('asks nothing, and refuses to make a session, when no routes are running', async () => {
    expect(leaveFor('https://routed.example/', 'https://news.example/')).toBeUndefined()
    expect(isTemporaryRouteSession({})).toBe(false)
    expect(isRoutedPage('https://routed.example/', undefined)).toBe(false)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-1')).toBe(false)
    expect(await routeAppToo('https://other.example', 'https://routed.example')).toBe(false)
    await expect(openTemporaryRoute('https://routed.example')).rejects.toThrow('no routes are running')
  })

  it('decides over the world it was given, and hands out the temporary session', async () => {
    const { session, open } = running()
    expect(leaveFor('https://routed.example/a', 'https://news.org/')).toEqual({ kind: 'website', origin: 'https://news.org', app: 'https://routed.example' })
    expect(await openTemporaryRoute('https://routed.example')).toBe('orivon-route-tab-1')
    expect(open).toHaveBeenCalledWith('socks5')
    expect(isTemporaryRouteSession(session)).toBe(true)
    expect(isTemporaryRouteSession(undefined)).toBe(false)
    expect(isRoutedPage('https://routed.example/page', undefined)).toBe(true)
    expect(isRoutedPage('https://news.org/', undefined)).toBe(false)
    expect(isRoutedPage('about:blank', undefined)).toBe(false)
    expect(isRoutedPage('about:blank', 'persist:app-routed')).toBe(true)
    expect(isRoutedPage('blob:https://routed.example/1', undefined)).toBe(true)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-1')).toBe(true)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-2')).toBe(false)
  })

  it('opens the page through the tunnel of the page that opens it, and the default one for an origin with none', async () => {
    const { open } = running()
    await openTemporaryRoute('https://routed.example')
    await openTemporaryRoute('https://unrouted.example')
    expect(open.mock.calls).toEqual([['socks5'], ['nym']])
  })

  it('sends the other app through the opening page\'s tunnel by the switch the menu uses, and not when it cannot be', async () => {
    const open = running()
    expect(await routeAppToo('https://other.example', 'https://routed.example')).toBe(true)
    expect(open.choose).toHaveBeenCalledWith('https://other.example', 'socks5')

    const blocked = running('no-proxy')
    expect(await routeAppToo('https://other.example', 'https://routed.example')).toBe(false)
    expect(blocked.choose).not.toHaveBeenCalled()
  })
})
