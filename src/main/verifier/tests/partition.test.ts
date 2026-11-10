import { describe, expect, it } from 'vitest'
import { originOf, requestPartition, withoutHttpCache, withPartition, withRoute } from '../partition.js'

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

describe('originOf', () => {
  it('is the origin of an address, and undefined for one with none', () => {
    expect(originOf('https://app.ipfs.orivon/a/b.js?x=1')).toBe('https://app.ipfs.orivon')
    expect(originOf('data:text/plain,hello')).toBeUndefined()
    expect(originOf('not a url')).toBeUndefined()
  })
})

describe('withoutHttpCache', () => {
  it('adds the condition the HTTP cache passes through, replacing one the page set in any case', () => {
    expect(withoutHttpCache({ Accept: '*/*' })).toEqual({ Accept: '*/*', 'If-Match': '*' })
    expect(withoutHttpCache({ 'if-match': '"abc"', Accept: '*/*' })).toEqual({ Accept: '*/*', 'If-Match': '*' })
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
