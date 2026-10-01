import { describe, expect, it } from 'vitest'
import type { SiteRow } from '../../../main/privacy/site-data-domain.js'
import { cookieMeta, countText, expiryText, flagsOf, shownOf } from '../shared/cookie-text.js'
import { defaultSort, filterSites, siteLine, sortSites, totalText, visibleSites, SITES_SHOWN } from '../settings/site-data/site-data-model.js'

const site = (domain: string, extra: Partial<SiteRow> = {}): SiteRow => ({ domain, hosts: [domain], cookies: 1, kinds: [], bytes: null, ...extra })

const SITES = [
  site('zeta.example', { cookies: 9, bytes: 100 }),
  site('alpha.example', { cookies: 1, bytes: 5000, hosts: ['alpha.example', 'cdn.alpha.example'] }),
  site('mid.example', { cookies: 5 }),
  site('beta.example', { cookies: 2 })
]

describe('searching the sites', () => {
  it('matches a domain or any of its hosts, ignoring case and word order', () => {
    expect(filterSites(SITES, 'ALPHA').map((row) => row.domain)).toEqual(['alpha.example'])
    expect(filterSites(SITES, 'cdn alpha').map((row) => row.domain)).toEqual(['alpha.example'])
    expect(filterSites(SITES, 'cdn.al').map((row) => row.domain)).toEqual(['alpha.example'])
  })

  it('keeps every site for an empty search and none for a word nothing has', () => {
    expect(filterSites(SITES, '  ')).toHaveLength(4)
    expect(filterSites(SITES, 'nothing')).toEqual([])
  })
})

describe('the two orders', () => {
  it('by name, whatever the size', () => {
    expect(sortSites(SITES, 'name').map((row) => row.domain)).toEqual(['alpha.example', 'beta.example', 'mid.example', 'zeta.example'])
  })

  it('by size, biggest first, then the sites of unknown size by cookies', () => {
    expect(sortSites(SITES, 'size').map((row) => row.domain)).toEqual(['alpha.example', 'zeta.example', 'mid.example', 'beta.example'])
  })

  it('does not change what it was given', () => {
    const copy = [...SITES]
    sortSites(SITES, 'size')
    expect(SITES).toEqual(copy)
  })

  it('starts by size only once some size is known', () => {
    expect(defaultSort(SITES)).toBe('size')
    expect(defaultSort([site('a.example'), site('b.example')])).toBe('name')
    expect(defaultSort([])).toBe('name')
  })
})

describe('how many rows show', () => {
  const many = Array.from({ length: SITES_SHOWN + 20 }, (_, index) => index)

  it('shows 100 and counts the rest until asked for all', () => {
    expect(visibleSites(many, false)).toMatchObject({ hidden: 20 })
    expect(visibleSites(many, false).shown).toHaveLength(SITES_SHOWN)
    expect(visibleSites(many, true)).toMatchObject({ hidden: 0 })
    expect(visibleSites(many.slice(0, 5), false).hidden).toBe(0)
  })
})

describe('the words of a row and of the total', () => {
  it('says cookies, kinds and size where they are known', () => {
    expect(siteLine({ cookies: 3, kinds: ['IndexedDB'], bytes: 1.2 * 1024 * 1024 })).toBe('3 cookies · IndexedDB · 1.2 MB')
    expect(siteLine({ cookies: 1, kinds: [], bytes: null })).toBe('1 cookie')
    expect(siteLine({ cookies: 0, kinds: ['IndexedDB'], bytes: null })).toBe('IndexedDB')
  })

  it('says it is calculating until the total is known', () => {
    expect(totalText(null)).toBe('Calculating…')
    expect(totalText(214 * 1024 * 1024)).toBe('About 214 MB on this computer')
  })
})

describe('the words of a cookie row', () => {
  it('says when a dated cookie goes and that a session cookie goes with the browser', () => {
    expect(expiryText({ session: false, expires: Date.UTC(2027, 2, 12, 12) / 1000 }, 'en-GB')).toBe('expires 12 Mar 2027')
    expect(expiryText({ session: true, expires: null })).toBe('until you close Orivon')
    expect(cookieMeta({ domain: '.example.com', session: true, expires: null })).toBe('.example.com · until you close Orivon')
  })

  it('names the flags that are set, in a fixed order', () => {
    expect(flagsOf({ secure: true, httpOnly: true })).toEqual(['Secure', 'HttpOnly'])
    expect(flagsOf({ secure: false, httpOnly: true })).toEqual(['HttpOnly'])
    expect(flagsOf({ secure: false, httpOnly: false })).toEqual([])
  })

  it('cuts a long list at fifty and says how many more', () => {
    const list = Array.from({ length: 62 }, (_, index) => index)
    expect(shownOf(list).shown).toHaveLength(50)
    expect(shownOf(list).more).toBe('and 12 more')
    expect(shownOf(list.slice(0, 50)).more).toBeNull()
    expect(countText(1)).toBe('1 cookie')
    expect(countText(0)).toBe('0 cookies')
  })
})
