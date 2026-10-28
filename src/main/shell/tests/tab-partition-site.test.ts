import { afterEach, describe, expect, it } from 'vitest'
import { profilePartitionFor } from '../../route/site-partition.js'
import type { Profile } from '../../route/site-partition.js'
import { setSiteRoutes } from '../../route/site-routes.js'
import { partitionChanged, partitionChangedByPage, partitionForTarget } from '../tab-partition.js'

const SITE = 'https://news.example'
const OTHER = 'https://other.example'
const TUNNEL = profilePartitionFor('nym', SITE)
const DIRECT = profilePartitionFor('direct', SITE)
afterEach(() => { setSiteRoutes(undefined) })

describe('the session a tab shows a website in', () => {
  it('is the shared one with no tunnel setting', () => {
    setSiteRoutes({ profileFor: () => undefined })
    expect(partitionForTarget(`${SITE}/a`)).toBeUndefined()
  })

  it('is the profile of a website\'s entry, for every address of that origin, and the same profile for every website with that entry', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'nym' : undefined })
    expect(partitionForTarget(`${SITE}/a?b=1#c`)).toBe(TUNNEL)
    expect(partitionForTarget(`${SITE}/other`)).toBe(TUNNEL)
    expect(partitionForTarget(`${OTHER}/`)).toBeUndefined()
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(partitionForTarget(`${OTHER}/`)).toBe(TUNNEL)
  })

  it('is the profile of the tunnel the website\'s entry names: Nym\'s and the proxy\'s are two sessions', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'nym' : 'socks5' })
    expect(partitionForTarget(`${SITE}/`)).toBe(TUNNEL)
    expect(partitionForTarget(`${OTHER}/`)).toBe(profilePartitionFor('socks5', OTHER))
    expect(profilePartitionFor('socks5', OTHER)).not.toBe(TUNNEL)
  })

  it('is the shared one for an address with no origin', () => {
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(partitionForTarget('about:blank')).toBeUndefined()
    expect(partitionForTarget('orivon://settings/')).toBeUndefined()
  })
})

describe('a tab moving between the shared session and a profile', () => {
  it('moves from one tunnel\'s profile to the other\'s when the website\'s entry changes tunnel', () => {
    const PROXY = profilePartitionFor('socks5', SITE)
    setSiteRoutes({ profileFor: () => 'socks5' })
    expect(partitionChanged(`${SITE}/`, TUNNEL, undefined)).toEqual({ to: PROXY })
    expect(partitionChanged(`${SITE}/`, PROXY, undefined)).toBeUndefined()
  })

  it('moves into the profile from the shared session, and back to the shared one from it', () => {
    setSiteRoutes({ profileFor: (origin) => origin === SITE ? 'nym' : undefined })
    expect(partitionChanged(`${SITE}/`, undefined, undefined)).toEqual({ to: TUNNEL })
    expect(partitionChanged(`${OTHER}/`, TUNNEL, undefined)).toEqual({ to: undefined })
    expect(partitionChangedByPage(`${OTHER}/`, TUNNEL, undefined)).toEqual({ to: undefined })
  })

  it('stays put between two websites of the same profile, so no tab reloads for a link between them', () => {
    setSiteRoutes({ profileFor: () => 'nym' })
    expect(partitionChanged(`${SITE}/b`, TUNNEL, undefined)).toBeUndefined()
    expect(partitionChanged(`${OTHER}/`, TUNNEL, undefined)).toBeUndefined()
  })

  it('moves from one profile straight to the other', () => {
    const profiles: Record<string, Profile> = { [SITE]: 'nym', [OTHER]: 'direct' }
    setSiteRoutes({ profileFor: (origin) => profiles[origin] })
    expect(partitionChanged(`${OTHER}/`, TUNNEL, undefined)).toEqual({ to: DIRECT })
    expect(partitionChanged(`${SITE}/`, DIRECT, undefined)).toEqual({ to: TUNNEL })
  })

  it('moves back to the shared session once the website has no entry', () => {
    let profile: Profile | undefined = 'nym'
    setSiteRoutes({ profileFor: () => profile })
    expect(partitionChanged(`${SITE}/`, TUNNEL, undefined)).toBeUndefined()
    profile = undefined
    expect(partitionChanged(`${SITE}/`, TUNNEL, undefined)).toEqual({ to: undefined })
  })
})
