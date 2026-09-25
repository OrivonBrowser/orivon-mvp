import { describe, expect, it } from 'vitest'
import { requestPartition, withPartition } from '../partition.js'

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

describe('withPartition', () => {
  it('replaces whatever the page sent, in any case, with the partition', () => {
    expect(withPartition({ Accept: '*/*', 'X-Orivon-Partition': 'https://victim.example' }, 'x-orivon-partition', 'https://tracker.example'))
      .toEqual({ Accept: '*/*', 'x-orivon-partition': 'https://tracker.example' })
  })

  it('removes it when there is no partition', () => {
    expect(withPartition({ 'x-orivon-partition': 'https://victim.example' }, 'x-orivon-partition', undefined)).toEqual({})
  })
})
