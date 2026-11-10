import { describe, expect, it } from 'vitest'
import { isOwnSiteRequest, namedPartition, requestHeader } from '../own-site-request.js'

const HOST = 'kept.example'

describe('requestHeader', () => {
  it('finds a header whatever case it was sent in, and the first of a list', () => {
    expect(requestHeader({ 'Sec-Fetch-Site': 'none' }, 'sec-fetch-site')).toBe('none')
    expect(requestHeader({ 'sec-fetch-site': ['same-origin', 'none'] }, 'sec-fetch-site')).toBe('same-origin')
    expect(requestHeader({}, 'sec-fetch-site')).toBeUndefined()
  })
})

describe('namedPartition', () => {
  it('reads the origin the shell stamped, and nothing that is not one', () => {
    expect(namedPartition({ 'x-orivon-partition': 'https://kept.example' })).toBe('https://kept.example')
    expect(namedPartition({ 'X-Orivon-Partition': 'https://kept.example' })).toBe('https://kept.example')
    expect(namedPartition({ 'x-orivon-partition': '' })).toBeUndefined()
    expect(namedPartition({ 'x-orivon-partition': 'kept.example' })).toBeUndefined()
    expect(namedPartition({ 'x-orivon-partition': 'https://has space' })).toBeUndefined()
    expect(namedPartition({})).toBeUndefined()
  })
})

describe('isOwnSiteRequest', () => {
  it('is true for a request of the site\'s own page, whatever the browser marks it, even from a sandboxed frame', () => {
    expect(isOwnSiteRequest({ 'x-orivon-partition': `https://${HOST}`, 'sec-fetch-site': 'same-origin' }, HOST)).toBe(true)
    expect(isOwnSiteRequest({ 'x-orivon-partition': `https://${HOST}`, 'sec-fetch-site': 'cross-site' }, HOST)).toBe(true)
  })

  it('is false for another site\'s page, however its request is marked, so the answer tells it nothing', () => {
    expect(isOwnSiteRequest({ 'x-orivon-partition': 'https://evil.example', 'sec-fetch-site': 'same-origin' }, HOST)).toBe(false)
    expect(isOwnSiteRequest({ 'x-orivon-partition': 'https://evil.example', 'sec-fetch-site': 'none' }, HOST)).toBe(false)
    expect(isOwnSiteRequest({ 'x-orivon-partition': 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, HOST)).toBe(false)
  })

  it('is true for a request no page started when the browser marks it none or same-origin, and false for the rest', () => {
    expect(isOwnSiteRequest({ 'sec-fetch-site': 'none' }, HOST)).toBe(true)
    expect(isOwnSiteRequest({ 'sec-fetch-site': 'same-origin' }, HOST)).toBe(true)
    expect(isOwnSiteRequest({ 'sec-fetch-site': 'cross-site' }, HOST)).toBe(false)
    expect(isOwnSiteRequest({ 'sec-fetch-site': 'same-site' }, HOST)).toBe(false)
    expect(isOwnSiteRequest({}, HOST)).toBe(false)
  })

  it('is true for the navigation of a top-level document from any site, and false for a frame\'s', () => {
    const link = { 'x-orivon-partition': 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }
    expect(isOwnSiteRequest({ ...link, 'sec-fetch-dest': 'document' }, HOST)).toBe(true)
    expect(isOwnSiteRequest({ ...link, 'sec-fetch-dest': 'iframe' }, HOST)).toBe(false)
    expect(isOwnSiteRequest({ ...link, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'document' }, HOST)).toBe(false)
  })
})
