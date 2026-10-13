import { afterEach, describe, expect, it } from 'vitest'
import { sitePartitionFor } from '../../route/site-partition.js'
import { setSiteRoutes } from '../../route/site-routes.js'
import { partitionChanged, partitionChangedByPage, partitionForTarget } from '../tab-partition.js'

const SITE = 'https://news.example'
const OTHER = 'https://other.example'
afterEach(() => { setSiteRoutes(undefined) })

describe('the session a tab shows a website in', () => {
  it('is the shared one with no tunnel setting', () => {
    setSiteRoutes({ usesOwnSession: () => false })
    expect(partitionForTarget(`${SITE}/a`)).toBeUndefined()
  })

  it('is the website\'s own for a website whose state differs from the default, for every address of that origin', () => {
    setSiteRoutes({ usesOwnSession: (origin) => origin === SITE })
    expect(partitionForTarget(`${SITE}/a?b=1#c`)).toBe(sitePartitionFor(SITE))
    expect(partitionForTarget(`${SITE}/other`)).toBe(sitePartitionFor(SITE))
    expect(partitionForTarget(`${OTHER}/`)).toBeUndefined()
  })

  it('is the shared one for an address with no origin', () => {
    setSiteRoutes({ usesOwnSession: () => true })
    expect(partitionForTarget('about:blank')).toBeUndefined()
    expect(partitionForTarget('orivon://settings/')).toBeUndefined()
  })
})

describe('a tab moving between the shared session and a website\'s own', () => {
  it('moves into the website\'s session from the shared one, and back to the shared one from it', () => {
    setSiteRoutes({ usesOwnSession: (origin) => origin === SITE })
    expect(partitionChanged(`${SITE}/`, undefined)).toEqual({ to: sitePartitionFor(SITE) })
    expect(partitionChanged(`${OTHER}/`, sitePartitionFor(SITE))).toEqual({ to: undefined })
    expect(partitionChangedByPage(`${OTHER}/`, sitePartitionFor(SITE))).toEqual({ to: undefined })
  })

  it('stays put inside the website', () => {
    setSiteRoutes({ usesOwnSession: (origin) => origin === SITE })
    expect(partitionChanged(`${SITE}/b`, sitePartitionFor(SITE))).toBeUndefined()
  })

  it('moves from one website\'s session straight to another\'s', () => {
    setSiteRoutes({ usesOwnSession: () => true })
    expect(partitionChanged(`${OTHER}/`, sitePartitionFor(SITE))).toEqual({ to: sitePartitionFor(OTHER) })
  })

  it('moves back to the shared session once the website\'s tunnel is off', () => {
    let own = true
    setSiteRoutes({ usesOwnSession: () => own })
    const inSite = sitePartitionFor(SITE)
    expect(partitionChanged(`${SITE}/`, inSite)).toBeUndefined()
    own = false
    expect(partitionChanged(`${SITE}/`, inSite)).toEqual({ to: undefined })
  })
})
