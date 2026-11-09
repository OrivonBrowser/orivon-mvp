import { describe, expect, it } from 'vitest'
import { headerValue, isOfOwnSite, requestPartition, withoutHttpCache, withPartition, withRoute } from '../partition.js'

describe('requestPartition', () => {
  it('gives a top-level navigation the partition of the page it opens', () => {
    expect(requestPartition({ url: 'https://secret.eth/', resourceType: 'mainFrame', topUrl: 'https://news.example/' })).toBe('https://secret.eth')
  })

  it("gives every other request its top-level page's partition, frames and images alike", () => {
    for (const resourceType of ['subFrame', 'image', 'script', 'xhr', 'other']) {
      expect(requestPartition({ url: 'https://secret.eth/x.png', resourceType, topUrl: 'https://tracker.example/page?q=1' })).toBe('https://tracker.example')
    }
  })

  it('gives none when there is no top-level page with an origin, so the request shares nothing', () => {
    expect(requestPartition({ url: 'https://a.eth/', resourceType: 'xhr', topUrl: undefined })).toBeUndefined()
    expect(requestPartition({ url: 'https://a.eth/', resourceType: 'image', topUrl: 'about:blank' })).toBeUndefined()
    expect(requestPartition({ url: 'https://a.eth/', resourceType: 'image', topUrl: 'file:///home/x/index.html' })).toBeUndefined()
  })
})

describe('requestPartition for a request with no frame', () => {
  it("gives a worker's request for its own origin that origin's partition, as the browser's Sec-Fetch-Site says it is", () => {
    expect(requestPartition({ url: 'https://app.ipfs.orivon/probe.js', resourceType: 'xhr', topUrl: undefined, fetchSite: 'same-origin' })).toBe('https://app.ipfs.orivon')
    expect(requestPartition({ url: 'https://app.ipfs.orivon/sw.js', resourceType: 'script', topUrl: undefined, fetchSite: 'same-origin' })).toBe('https://app.ipfs.orivon')
  })

  it('gives none to any other frameless request: another origin, a read of the shell\'s own, or one with no header', () => {
    for (const fetchSite of ['cross-site', 'same-site', 'none', undefined]) {
      expect(requestPartition({ url: 'https://app.ipfs.orivon/probe.js', resourceType: 'xhr', topUrl: undefined, fetchSite })).toBeUndefined()
    }
  })

  it('leaves a request with a frame to its top-level page whatever the header says', () => {
    expect(requestPartition({ url: 'https://app.ipfs.orivon/x.js', resourceType: 'script', topUrl: 'https://news.example/', fetchSite: 'same-origin' })).toBe('https://news.example')
  })
})

describe('isOfOwnSite', () => {
  it('holds for a partition that is the origin the URL is for, and for nothing else', () => {
    expect(isOfOwnSite('https://app.ipfs.orivon', 'https://app.ipfs.orivon/a/b.js?x=1')).toBe(true)
    expect(isOfOwnSite('https://news.example', 'https://app.ipfs.orivon/a.js')).toBe(false)
    expect(isOfOwnSite(undefined, 'https://app.ipfs.orivon/a.js')).toBe(false)
  })
})

describe('withoutHttpCache', () => {
  it('adds the condition the HTTP cache passes through, replacing one the page set in any case', () => {
    expect(withoutHttpCache({ Accept: '*/*' })).toEqual({ Accept: '*/*', 'If-Match': '*' })
    expect(withoutHttpCache({ 'if-match': '"abc"', Accept: '*/*' })).toEqual({ Accept: '*/*', 'If-Match': '*' })
  })
})

describe('headerValue', () => {
  it('finds a header whatever case it was sent in', () => {
    expect(headerValue({ 'Sec-Fetch-Site': 'same-origin' }, 'sec-fetch-site')).toBe('same-origin')
    expect(headerValue({ Accept: '*/*' }, 'sec-fetch-site')).toBeUndefined()
  })
})

describe('withPartition', () => {
  it('replaces whatever the page sent, in any case, with the partition', () => {
    expect(withPartition({ Accept: '*/*', 'X-Orivon-Partition': 'https://victim.example' }, 'x-orivon-partition', 'https://tracker.example'))
      .toEqual({ Accept: '*/*', 'x-orivon-partition': 'https://tracker.example' })
  })

  it('removes it when there is no partition', () => {
    expect(withPartition({ 'x-orivon-partition': 'https://victim.example' }, 'x-orivon-partition', undefined)).toEqual({})
  })
})

describe('withRoute', () => {
  it('marks the request of a website in a tunnel\'s profile with that tunnel, replacing whatever the page sent', () => {
    expect(withRoute({ Accept: '*/*', 'X-Orivon-Route': 'direct' }, 'x-orivon-route', 'nym')).toEqual({ Accept: '*/*', 'x-orivon-route': 'nym' })
    expect(withRoute({ Accept: '*/*', 'X-Orivon-Route': 'nym' }, 'x-orivon-route', 'socks5')).toEqual({ Accept: '*/*', 'x-orivon-route': 'socks5' })
  })

  it('strips the mark from every other request, so a page cannot name a route for itself', () => {
    expect(withRoute({ Accept: '*/*', 'x-orivon-route': 'nym' }, 'x-orivon-route', undefined)).toEqual({ Accept: '*/*' })
  })
})
