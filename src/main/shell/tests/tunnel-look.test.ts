import { describe, expect, it } from 'vitest'
import { newTabTunnelLook, pageTunnelLook } from '../tunnel-look.js'
import type { LookRoutes } from '../tunnel-look.js'
import type { RouteState } from '../../route/route-hub.js'
import type { Profile } from '../../route/site-partition.js'
import type { TunnelKind } from '../../route/route-state.js'

const SITE = 'https://news.example'
const SESSION = {}

interface World {
  kindOf?: (origin: string) => TunnelKind | undefined
  profileFor?: (origin: string) => Profile | undefined
  states?: Record<string, RouteState>
  app?: boolean
  unreadable?: boolean
  sessionTunnel?: TunnelKind | 'held' | undefined
}

function routes (world: World = {}): LookRoutes & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    hub: {
      kindOf: world.kindOf ?? (() => undefined),
      profileFor: world.profileFor ?? (() => undefined),
      isApp: () => world.app === true,
      unreadable: () => world.unreadable === true,
      // As the real hub: an origin that is not routed is off, and a profile's identity is always routed.
      state: (origin: string) => { asked.push(origin); return world.states?.[origin] ?? (origin.startsWith('orivon-') || (world.kindOf ?? (() => undefined))(origin) !== undefined ? 'ok' : 'off') }
    },
    controller: { tunnelOf: () => world.sessionTunnel }
  }
}

const page = (over: Partial<Parameters<typeof pageTunnelLook>[1]> = {}): Parameters<typeof pageTunnelLook>[1] => ({ origin: SITE, holder: SESSION, temporary: false, choice: undefined, ...over })

describe('the look of the page in a tab', () => {
  it('is the look of its own origin while the tab has no choice', () => {
    const r = routes({ kindOf: () => 'socks5', sessionTunnel: 'socks5' })
    expect(pageTunnelLook(r, page())).toEqual({ mark: 'on', via: 'socks5' })
    expect(r.asked).toEqual([SITE])
    expect(pageTunnelLook(routes({ sessionTunnel: undefined }), page())).toEqual({ mark: null, via: null })
  })

  it('is on the tab\'s tunnel, whatever the website would have gone through by itself, and is that profile\'s health', () => {
    const r = routes({ kindOf: () => undefined, sessionTunnel: 'nym', states: { 'orivon-tunnel-profile': 'down' } })
    expect(pageTunnelLook(r, page({ choice: 'nym' }))).toEqual({ mark: 'down', via: 'nym' })
    expect(r.asked).toEqual(['orivon-tunnel-profile'])
    expect(pageTunnelLook(routes({ kindOf: () => 'nym', sessionTunnel: 'socks5' }), page({ choice: 'socks5' }))).toEqual({ mark: 'on', via: 'socks5' })
  })

  it('is stopped while the page is not yet in the session of the tab\'s tunnel', () => {
    expect(pageTunnelLook(routes({ sessionTunnel: undefined }), page({ choice: 'nym' }))).toEqual({ mark: 'down', via: 'nym' })
  })

  it('is plain for a direct tab even while the whole browser is on a tunnel, which the website would otherwise have gone through', () => {
    expect(pageTunnelLook(routes({ kindOf: () => 'nym', sessionTunnel: undefined }), page({ choice: 'direct' }))).toEqual({ mark: null, via: null })
  })

  it('keeps the tunnel a website has of its own in a direct tab', () => {
    const r = routes({ kindOf: () => 'socks5', profileFor: () => 'socks5', sessionTunnel: 'socks5' })
    expect(pageTunnelLook(r, page({ choice: 'direct' }))).toEqual({ mark: 'on', via: 'socks5' })
  })

  it('is its own origin\'s for an installed app, a temporary session and this computer, which a tab\'s choice does not decide', () => {
    expect(pageTunnelLook(routes({ app: true, kindOf: () => 'socks5', sessionTunnel: 'socks5' }), page({ choice: 'nym' }))).toEqual({ mark: 'on', via: 'socks5' })
    expect(pageTunnelLook(routes({ kindOf: () => undefined, sessionTunnel: 'socks5' }), page({ choice: 'nym', temporary: true }))).toEqual({ mark: 'on', via: 'socks5' })
    expect(pageTunnelLook(routes({ kindOf: () => undefined, sessionTunnel: undefined }), page({ choice: 'nym', origin: 'http://localhost:3000' }))).toEqual({ mark: null, via: null })
  })
})

describe('the look of a new tab', () => {
  it('is the tab\'s own choice: a tunnel is on, direct is plain', () => {
    expect(newTabTunnelLook(routes(), 'nym')).toEqual({ mark: 'on', via: 'nym' })
    expect(newTabTunnelLook(routes(), 'socks5')).toEqual({ mark: 'on', via: 'socks5' })
    expect(newTabTunnelLook(routes({ kindOf: () => 'nym' }), 'direct')).toEqual({ mark: null, via: null })
  })

  it('reads the health of the tunnel profile the choice calls for, and says it is stopped when that tunnel does not answer', () => {
    const r = routes({ states: { 'orivon-proxy-profile': 'no-proxy' } })
    expect(newTabTunnelLook(r, 'socks5')).toEqual({ mark: 'down', via: 'socks5' })
    expect(r.asked).toEqual(['orivon-proxy-profile'])
  })

  it('follows the browser with no choice: the default tunnel while the whole browser is on one, else plain', () => {
    const on = routes({ kindOf: (origin) => origin === 'orivon-shared-tunnel' ? 'socks5' : undefined })
    expect(newTabTunnelLook(on, undefined)).toEqual({ mark: 'on', via: 'socks5' })
    expect(on.asked).toEqual(['orivon-shared-tunnel'])
    expect(newTabTunnelLook(routes(), undefined)).toEqual({ mark: null, via: null })
  })

  it('goes through the tunnel every website takes while the tunnel settings cannot be read', () => {
    const r = routes({ unreadable: true, profileFor: () => 'nym' })
    expect(newTabTunnelLook(r, undefined)).toEqual({ mark: 'on', via: 'nym' })
    expect(r.asked).toEqual(['orivon-tunnel-profile'])
    expect(newTabTunnelLook(routes({ unreadable: true }), undefined)).toEqual({ mark: null, via: null })
  })
})
