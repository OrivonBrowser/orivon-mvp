import { afterEach, describe, expect, it } from 'vitest'
import { profilePartitionFor } from '../../route/site-partition.js'
import type { Profile } from '../../route/site-partition.js'
import { setSiteRoutes } from '../../route/site-routes.js'
import { partitionChanged, partitionChangedByPage, partitionForTab, partitionForTarget } from '../tab-partition.js'

const SITE = 'https://news.example'
const OTHER = 'https://other.example'
const NYM = profilePartitionFor('nym', SITE)
const PROXY = profilePartitionFor('socks5', SITE)
const DIRECT = profilePartitionFor('direct', SITE)
afterEach(() => { setSiteRoutes(undefined) })

function entries (own: Readonly<Record<string, Profile>> = {}): void {
  setSiteRoutes({ profileFor: (origin) => own[origin] })
}

describe('the session a tab with a tunnel choice shows a website in', () => {
  it('is the tunnel\'s profile for every website the tab opens, entry or none', () => {
    entries({ [OTHER]: 'direct' })
    expect(partitionForTab(`${SITE}/a?b=1#c`, 'nym')).toBe(NYM)
    expect(partitionForTab(`${OTHER}/`, 'nym')).toBe(profilePartitionFor('nym', OTHER))
    expect(partitionForTab(`${SITE}/`, 'socks5')).toBe(PROXY)
  })

  it('is the direct profile for a direct choice, unless the website has a tunnel of its own', () => {
    entries({ [OTHER]: 'nym' })
    expect(partitionForTab(`${SITE}/`, 'direct')).toBe(DIRECT)
    expect(partitionForTab(`${OTHER}/`, 'direct')).toBe(profilePartitionFor('nym', OTHER))
  })

  it('is the website\'s own with no choice, and partitionForTarget is exactly that', () => {
    entries({ [SITE]: 'socks5' })
    expect(partitionForTab(`${SITE}/`, undefined)).toBe(PROXY)
    expect(partitionForTarget(`${SITE}/`)).toBe(partitionForTab(`${SITE}/`, undefined))
    expect(partitionForTab(`${OTHER}/`, undefined)).toBeUndefined()
  })

  it('is the shared session for this computer and for an address with no origin, whatever the choice', () => {
    entries()
    for (const choice of ['nym', 'socks5', 'direct'] as const) {
      expect(partitionForTab('http://localhost:3000/', choice)).toBeUndefined()
      expect(partitionForTab('http://127.0.0.1:8080/', choice)).toBeUndefined()
      expect(partitionForTab('about:blank', choice)).toBeUndefined()
      expect(partitionForTab('orivon://settings/', choice)).toBeUndefined()
    }
  })

  it('is the web\'s memory twin of the profile for an origin that may not be written to disk', () => {
    entries()
    expect(partitionForTab('http://news.example/', 'nym')).toBe(profilePartitionFor('nym', 'http://news.example'))
    expect(partitionForTab('http://news.example/', 'nym')).not.toBe(partitionForTab(`${SITE}/`, 'nym'))
  })
})

describe('a tab with a tunnel choice moving between sessions', () => {
  it('moves from the shared session into the profile of its choice on the first address, and stays between websites', () => {
    entries()
    expect(partitionChanged(`${SITE}/`, undefined, 'nym')).toEqual({ to: NYM })
    expect(partitionChanged(`${OTHER}/`, NYM, 'nym')).toEqual({ to: profilePartitionFor('nym', OTHER) })
    expect(partitionChanged(`${SITE}/b`, NYM, 'nym')).toBeUndefined()
  })

  it('moves a website whose own entry is another tunnel into the tab\'s tunnel, and a website whose entry is off', () => {
    entries({ [SITE]: 'socks5', [OTHER]: 'direct' })
    expect(partitionChanged(`${SITE}/`, PROXY, 'nym')).toEqual({ to: NYM })
    expect(partitionChanged(`${OTHER}/`, profilePartitionFor('direct', OTHER), 'nym')).toEqual({ to: profilePartitionFor('nym', OTHER) })
  })

  it('moves back to the shared session only for this computer: a tab with a choice leaves its profile for nothing else', () => {
    entries()
    expect(partitionChanged('http://127.0.0.1:8080/', NYM, 'nym')).toEqual({ to: undefined })
    expect(partitionChanged(`${OTHER}/`, NYM, 'nym')).not.toEqual({ to: undefined })
  })

  it('does not move a direct tab off a website\'s own tunnel', () => {
    entries({ [SITE]: 'nym' })
    expect(partitionChanged(`${SITE}/`, NYM, 'direct')).toBeUndefined()
    expect(partitionChanged(`${OTHER}/`, NYM, 'direct')).toEqual({ to: profilePartitionFor('direct', OTHER) })
  })

  it('moves for a navigation the page started the same way', () => {
    entries()
    expect(partitionChangedByPage(`${SITE}/`, undefined, 'socks5')).toEqual({ to: PROXY })
    expect(partitionChangedByPage(`${SITE}/b`, PROXY, 'socks5')).toBeUndefined()
  })

  it('moves a tab with no choice as it always did', () => {
    entries({ [SITE]: 'nym' })
    expect(partitionChanged(`${SITE}/`, undefined, undefined)).toEqual({ to: NYM })
    expect(partitionChanged(`${OTHER}/`, NYM, undefined)).toEqual({ to: undefined })
  })
})
