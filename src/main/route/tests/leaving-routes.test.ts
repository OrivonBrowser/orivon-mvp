import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRoutedPage, isTemporaryRoutePartitionLive, isTemporaryRouteSession, leaveFor, openTemporaryRoute, routeAppToo, setLeavingRoutes } from '../leaving-routes.js'

afterEach(() => { setLeavingRoutes(undefined) })

function running (blocked: 'no-proxy' | 'not-cached' | undefined = undefined) {
  const set = vi.fn(async () => {})
  const session = {}
  setLeavingRoutes({
    world: { isRouted: (origin) => origin === 'https://routed.example', isInstalledApp: (origin) => origin.endsWith('.example') },
    temporary: { open: async () => 'orivon-route-tab-1', owns: (one) => one === session, isLive: (partition) => partition === 'orivon-route-tab-1' },
    routeSwitch: { blockedFor: () => blocked, set }
  })
  return { set, session }
}

describe('what the shell asks of the routes', () => {
  it('asks nothing, and refuses to make a session, when no routes are running', async () => {
    expect(leaveFor('https://routed.example/', 'https://news.example/')).toBeUndefined()
    expect(isTemporaryRouteSession({})).toBe(false)
    expect(isRoutedPage('https://routed.example/')).toBe(false)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-1')).toBe(false)
    expect(await routeAppToo('https://other.example')).toBe(false)
    await expect(openTemporaryRoute()).rejects.toThrow('no routes are running')
  })

  it('decides over the world it was given, and hands out the temporary session', async () => {
    const { session } = running()
    expect(leaveFor('https://routed.example/a', 'https://news.org/')).toEqual({ kind: 'website', origin: 'https://news.org' })
    expect(await openTemporaryRoute()).toBe('orivon-route-tab-1')
    expect(isTemporaryRouteSession(session)).toBe(true)
    expect(isTemporaryRouteSession(undefined)).toBe(false)
    expect(isRoutedPage('https://routed.example/page')).toBe(true)
    expect(isRoutedPage('https://news.org/')).toBe(false)
    expect(isRoutedPage('about:blank')).toBe(false)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-1')).toBe(true)
    expect(isTemporaryRoutePartitionLive('orivon-route-tab-2')).toBe(false)
  })

  it('turns the other app\'s route on through the switch the app card uses, and not when it cannot be turned on', async () => {
    const open = running()
    expect(await routeAppToo('https://other.example')).toBe(true)
    expect(open.set).toHaveBeenCalledWith('https://other.example', true)

    const blocked = running('no-proxy')
    expect(await routeAppToo('https://other.example')).toBe(false)
    expect(blocked.set).not.toHaveBeenCalled()
  })
})
