import { afterEach, describe, expect, it } from 'vitest'
import { choiceForSwitch, choiceUnderHold, isTabTunnelChoice, profileForTab, setTabTunnelSource, tabChoiceOfContents, tabKindShowing, tabWebsitesTunnel, tunnelForTab, tunnelOfChoice, tunnelOfPage } from '../tab-tunnel.js'
import type { TabTunnelChoice } from '../tab-tunnel.js'
import type { Profile } from '../site-partition.js'

const SITE = 'https://news.example'
afterEach(() => { setTabTunnelSource(undefined) })

describe('the profile a tab with a tunnel choice puts a website in', () => {
  const owns: ReadonlyArray<Profile | undefined> = [undefined, 'direct', 'nym', 'socks5']

  it('is the website\'s own when the tab has no choice', () => {
    for (const own of owns) expect(profileForTab(undefined, SITE, own)).toBe(own)
  })

  it('is the tunnel\'s whatever the website\'s own entry says: a tunnel choice wins over off and over the other tunnel', () => {
    for (const choice of ['nym', 'socks5'] as const) {
      for (const own of owns) expect(profileForTab(choice, SITE, own), `${choice} over ${String(own)}`).toBe(choice)
    }
  })

  it('is the direct profile for a direct choice, unless the website has a tunnel of its own', () => {
    expect(profileForTab('direct', SITE, undefined)).toBe('direct')
    expect(profileForTab('direct', SITE, 'direct')).toBe('direct')
    expect(profileForTab('direct', SITE, 'nym')).toBe('nym')
    expect(profileForTab('direct', SITE, 'socks5')).toBe('socks5')
  })

  it('is none for this computer and for anything that is not a web origin, whatever the choice', () => {
    for (const choice of ['nym', 'socks5', 'direct'] as const) {
      expect(profileForTab(choice, 'http://localhost:3000', undefined)).toBeUndefined()
      expect(profileForTab(choice, 'http://127.0.0.1:8080', 'nym')).toBeUndefined()
      expect(profileForTab(choice, 'orivon-shell://renderer/newtab', undefined)).toBeUndefined()
    }
  })

  it('never lets a choice make a tab less tunnelled than a promise made for a website', () => {
    const lessTunnelled = (choice: TabTunnelChoice, own: Profile | undefined): boolean => {
      const got = profileForTab(choice, SITE, own)
      return own !== undefined && own !== 'direct' && got === 'direct'
    }
    for (const choice of ['nym', 'socks5', 'direct'] as const) for (const own of owns) expect(lessTunnelled(choice, own)).toBe(false)
  })
})

describe('the choice a window held to one tunnel allows a tab', () => {
  it('is any choice in a window held to nothing', () => {
    for (const choice of [undefined, 'nym', 'socks5', 'direct'] as const) expect(choiceUnderHold(choice, undefined)).toBe(choice)
  })

  it('is the held tunnel or none in a window held to it: direct and the other tunnel would leave it by a route it was promised not to use', () => {
    expect(choiceUnderHold('nym', 'nym')).toBe('nym')
    expect(choiceUnderHold(undefined, 'nym')).toBeUndefined()
    expect(choiceUnderHold('direct', 'nym')).toBeUndefined()
    expect(choiceUnderHold('socks5', 'nym')).toBeUndefined()
    expect(choiceUnderHold('nym', 'socks5')).toBeUndefined()
  })
})

describe('the tunnel a choice sends through', () => {
  it('names the tunnel, and none for direct', () => {
    expect(tunnelOfChoice('nym')).toBe('nym')
    expect(tunnelOfChoice('socks5')).toBe('socks5')
    expect(tunnelOfChoice('direct')).toBeUndefined()
    expect(tunnelOfChoice(undefined)).toBeUndefined()
  })

  it('reads a stored value as data: only the three choices count', () => {
    for (const good of ['nym', 'socks5', 'direct']) expect(isTabTunnelChoice(good)).toBe(true)
    for (const bad of ['off', '', 'NYM', 3, null, undefined, {}]) expect(isTabTunnelChoice(bad)).toBe(false)
  })
})

describe('what the shell tells the routes about its tabs', () => {
  it('answers nothing until the shell supplies it', () => {
    expect(tabChoiceOfContents(7)).toBeUndefined()
    expect(tabKindShowing(SITE)).toBeUndefined()
  })

  it('answers from what the shell supplied, and nothing once it is taken away', () => {
    setTabTunnelSource({ choiceOfContents: (id) => id === 7 ? 'nym' : undefined, kindShowing: (origin) => origin === SITE ? 'socks5' : undefined })
    expect(tabChoiceOfContents(7)).toBe('nym')
    expect(tabChoiceOfContents(8)).toBeUndefined()
    expect(tabKindShowing(SITE)).toBe('socks5')
    expect(tabKindShowing('https://other.example')).toBeUndefined()
    setTabTunnelSource(undefined)
    expect(tabChoiceOfContents(7)).toBeUndefined()
  })
})

describe('the tunnel a page leaves by in a tab with a choice', () => {
  it('is the choice\'s tunnel for a tunnel choice, whatever the website\'s own entry says', () => {
    for (const own of [undefined, 'direct', 'nym', 'socks5'] as const) expect(tunnelForTab('socks5', SITE, own)).toBe('socks5')
  })

  it('is none for a direct choice, unless the website has a tunnel of its own', () => {
    expect(tunnelForTab('direct', SITE, undefined)).toBeUndefined()
    expect(tunnelForTab('direct', SITE, 'direct')).toBeUndefined()
    expect(tunnelForTab('direct', SITE, 'nym')).toBe('nym')
  })

  it('is none for this computer, which no choice sends through a tunnel', () => {
    expect(tunnelForTab('nym', 'http://localhost:3000', undefined)).toBeUndefined()
  })
})

describe('the choice a tab takes when the tunnel switch is moved', () => {
  it('is the tunnel the switch was moved to', () => {
    for (const everywhere of [false, true]) {
      expect(choiceForSwitch('nym', everywhere)).toBe('nym')
      expect(choiceForSwitch('socks5', everywhere)).toBe('socks5')
    }
  })

  it('is none when the lit switch is turned off while the whole browser is not on a tunnel: the tab goes direct as it did before', () => {
    expect(choiceForSwitch(null, false)).toBeNull()
  })

  it('is direct when the lit switch is turned off while the whole browser is on a tunnel, because having no choice would follow it', () => {
    expect(choiceForSwitch(null, true)).toBe('direct')
  })
})

describe('the tunnel the websites of a tab go through when none has an entry of its own', () => {
  it('is the choice\'s tunnel for a tunnel choice, whatever the browser or an unreadable list says', () => {
    for (const browser of [undefined, 'socks5'] as const) {
      for (const unreadable of [undefined, 'socks5'] as const) expect(tabWebsitesTunnel('nym', browser, unreadable)).toBe('nym')
    }
  })

  it('is none for a direct choice, even under a browser on a tunnel', () => {
    expect(tabWebsitesTunnel('direct', 'nym', undefined)).toBeUndefined()
  })

  it('is the browser\'s tunnel for a tab with no choice, else none', () => {
    expect(tabWebsitesTunnel(undefined, 'socks5', undefined)).toBe('socks5')
    expect(tabWebsitesTunnel(undefined, undefined, undefined)).toBeUndefined()
  })

  it('is the tunnel every website takes while the list cannot be read, for a tab with no choice and for a direct one, which yields to it as to a website\'s own tunnel', () => {
    expect(tabWebsitesTunnel(undefined, undefined, 'nym')).toBe('nym')
    expect(tabWebsitesTunnel('direct', undefined, 'nym')).toBe('nym')
    expect(tabWebsitesTunnel('direct', 'socks5', 'nym')).toBe('nym')
  })

  it('is what a page leaves by in the tab while the list cannot be read: every website is then in the unreadable tunnel\'s profile', () => {
    for (const choice of [undefined, 'direct', 'nym', 'socks5'] as const) {
      for (const unreadable of ['nym', 'socks5'] as const) expect(tabWebsitesTunnel(choice, undefined, unreadable), `${String(choice)} over ${unreadable}`).toBe(tunnelForTab(choice, SITE, unreadable))
    }
  })
})

describe('the tunnel a page leaves by', () => {
  it('is the browser\'s for a tab with no choice and a website with no profile of its own, whatever that is', () => {
    expect(tunnelOfPage(undefined, SITE, undefined, 'nym')).toBe('nym')
    expect(tunnelOfPage(undefined, SITE, undefined, undefined)).toBeUndefined()
  })

  it('is the website\'s own for a tab with no choice: an off entry leaves the tunnel the browser is on', () => {
    expect(tunnelOfPage(undefined, SITE, 'socks5', 'nym')).toBe('socks5')
    expect(tunnelOfPage(undefined, SITE, 'direct', 'nym')).toBeUndefined()
  })

  it('is the tab\'s tunnel over both, and a direct tab never loosens a tunnel of the website\'s own', () => {
    expect(tunnelOfPage('nym', SITE, 'socks5', undefined)).toBe('nym')
    expect(tunnelOfPage('direct', SITE, undefined, 'nym'), 'a direct tab leaves the browser\'s tunnel').toBeUndefined()
    expect(tunnelOfPage('direct', SITE, 'socks5', 'nym')).toBe('socks5')
  })

  it('is none for this computer whatever the tab carries', () => {
    expect(tunnelOfPage('nym', 'http://localhost:3000', undefined, undefined)).toBeUndefined()
  })
})
