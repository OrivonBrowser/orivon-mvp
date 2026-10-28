import { afterEach, describe, expect, it } from 'vitest'
import { isTabTunnelChoice, profileForTab, setTabTunnelSource, tabChoiceOfContents, tabKindShowing, tunnelOfChoice } from '../tab-tunnel.js'
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
