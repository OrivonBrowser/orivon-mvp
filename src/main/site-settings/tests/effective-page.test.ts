import { describe, expect, it } from 'vitest'
import { openerUrlOf, ruleAddress } from '../effective-page.js'

describe('the address a document\'s site rules come from', () => {
  it('is the document itself for a website, and nothing for a page that has no setting', () => {
    expect(ruleAddress('https://a.example/x', undefined)).toBe('https://a.example/x')
    for (const url of ['orivon://settings/', 'file:///a.html', 'data:text/html,hi', 'chrome-extension://abc/p.html', undefined]) expect(ruleAddress(url, () => 'https://a.example/')).toBeUndefined()
  })

  it('is the opener for a blank document, and unknown when the opener tells nothing', () => {
    expect(ruleAddress('about:blank', () => 'https://a.example/x')).toBe('https://a.example/x')
    expect(ruleAddress('', () => 'blob:https://a.example/id')).toBe('https://a.example/id')
    expect(ruleAddress('about:blank', () => undefined)).toBe('unknown')
    expect(ruleAddress('about:blank', () => 'about:blank')).toBe('unknown')
    expect(ruleAddress('about:blank', () => 'orivon://settings/')).toBeUndefined()
    expect(ruleAddress('about:blank', undefined)).toBeUndefined()
  })

  it('is the address inside a blob: one, and unknown for an opaque one', () => {
    expect(ruleAddress('blob:https://a.example/id', undefined)).toBe('https://a.example/id')
    expect(ruleAddress('blob:null/id', undefined)).toBe('unknown')
  })
})

describe('the opener of a tab', () => {
  it('is its address, and undefined for no opener or one that cannot be read any more', () => {
    expect(openerUrlOf({ opener: { url: 'https://a.example/' } })).toBe('https://a.example/')
    expect(openerUrlOf({ opener: null })).toBeUndefined()
    expect(openerUrlOf({})).toBeUndefined()
    expect(openerUrlOf({ get opener (): never { throw new Error('destroyed') } })).toBeUndefined()
  })
})
