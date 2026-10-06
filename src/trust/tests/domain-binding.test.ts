import { describe, expect, it } from 'vitest'
import { domainBinding, homeLine, judgedElsewhereNote, judgedLevelCounts, originHost } from '../domain-binding.js'

describe('domainBinding', () => {
  it('is bound when the manifest names the host the app is at', () => {
    expect(domainBinding('thelounge.orivonstack.eth', { kind: 'app', domain: 'thelounge.orivonstack.eth' })).toBe('bound')
  })

  it('is other-home when the manifest names a different host, a content-address host included', () => {
    expect(domainBinding('evil.eth', { kind: 'app', domain: 'app.eth' })).toBe('other-home')
    expect(domainBinding('bafyexample.ipfs.orivon', { kind: 'app', domain: 'app.eth' })).toBe('other-home')
  })

  it('is no-home for a manifest that names none', () => {
    expect(domainBinding('app.eth', { kind: 'app', domain: undefined })).toBe('no-home')
  })

  it('is no-home for a manifest that could not be read, so nothing is borrowed', () => {
    expect(domainBinding('app.eth', { kind: 'unread' })).toBe('no-home')
  })

  it('is not-applicable for content with no manifest, a website', () => {
    expect(domainBinding('site.eth', { kind: 'website' })).toBe('not-applicable')
  })
})

describe('judgedLevelCounts', () => {
  it('counts a judged level only where it is bound or no app is claimed', () => {
    expect(judgedLevelCounts('bound')).toBe(true)
    expect(judgedLevelCounts('not-applicable')).toBe(true)
    expect(judgedLevelCounts('other-home')).toBe(false)
    expect(judgedLevelCounts('no-home')).toBe(false)
  })
})

describe('originHost', () => {
  it('is the host of an origin, lower case, with no port', () => {
    expect(originHost('https://thelounge.orivonstack.eth')).toBe('thelounge.orivonstack.eth')
    expect(originHost('http://localhost:8080')).toBe('localhost')
  })

  it('is empty for text that is no origin', () => {
    expect(originHost('not an origin')).toBe('')
  })
})

describe('homeLine', () => {
  it('names the home an app gives when it is not this address', () => {
    expect(homeLine('bafy.ipfs.orivon', 'app.eth')).toBe('This app names app.eth as its home.')
  })

  it('says nothing at the home itself or for an app that names none', () => {
    expect(homeLine('app.eth', 'app.eth')).toBeUndefined()
    expect(homeLine('app.eth', undefined)).toBeUndefined()
  })
})

describe('judgedElsewhereNote', () => {
  it('names the other home when there is one', () => {
    expect(judgedElsewhereNote('Attila', 'other-home', 'app.eth')).toMatch(/Attila judged these files, but its manifest names app\.eth as its home, not this address/)
  })

  it('says the manifest names none, or could not be read, otherwise', () => {
    expect(judgedElsewhereNote('Attila', 'no-home', undefined)).toMatch(/names no home, or could not be read/)
  })
})
