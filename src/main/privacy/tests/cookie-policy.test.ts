import { describe, expect, it } from 'vitest'
import { createThirdPartyMemory, isThirdParty, requestIsThirdParty, THIRD_PARTY_MEMORY_LIMIT, topUrlOf } from '../cookie-policy.js'

const facts = (resourceType: string, url: string, topUrl: string | undefined): { resourceType: string, url: string, topUrl: string | undefined } => ({ resourceType, url, topUrl })

describe('isThirdParty', () => {
  it('leaves a first-party subresource alone, however many subdomains apart', () => {
    expect(isThirdParty(facts('image', 'https://cdn.shop.example/a.png', 'https://www.shop.example/'))).toBe(false)
    expect(isThirdParty(facts('xhr', 'https://shop.example/api', 'https://shop.example/'))).toBe(false)
  })

  it('treats a request to another site as third-party', () => {
    expect(isThirdParty(facts('image', 'https://tracker.example/pixel.gif', 'https://shop.example/'))).toBe(true)
    expect(isThirdParty(facts('subFrame', 'https://ads.example/frame', 'https://shop.example/'))).toBe(true)
  })

  it('treats a WebSocket handshake like any other request: third-party to another site, first-party to its own', () => {
    expect(isThirdParty(facts('webSocket', 'wss://tracker.example/socket', 'https://shop.example/'))).toBe(true)
    expect(isThirdParty(facts('webSocket', 'ws://tracker.example/socket', 'http://shop.example/'))).toBe(true)
    expect(isThirdParty(facts('webSocket', 'wss://live.shop.example/socket', 'https://shop.example/'))).toBe(false)
  })

  it('never treats the page\'s own navigation as third-party', () => {
    expect(isThirdParty(facts('mainFrame', 'https://other.example/', 'https://shop.example/'))).toBe(false)
  })

  it('reads 127.0.0.1 and localhost as different sites', () => {
    expect(isThirdParty(facts('image', 'http://localhost:8000/a.png', 'http://127.0.0.1:9000/'))).toBe(true)
  })

  it('answers first party when the top document is unknown or not a web page', () => {
    expect(isThirdParty(facts('image', 'https://tracker.example/p', undefined))).toBe(false)
    expect(isThirdParty(facts('image', 'https://tracker.example/p', 'chrome-extension://abc/page.html'))).toBe(false)
    expect(isThirdParty(facts('image', 'https://tracker.example/p', 'orivon://settings/'))).toBe(false)
  })
})

describe('topUrlOf', () => {
  it('prefers the top frame', () => {
    expect(topUrlOf({ url: 'https://a/', resourceType: 'image', frame: { top: { url: 'https://top.example/' } }, webContents: { getURL: () => 'https://tab.example/' } })).toBe('https://top.example/')
  })

  it('falls back to the tab when the frame has no top', () => {
    expect(topUrlOf({ url: 'https://a/', resourceType: 'image', frame: null, webContents: { getURL: () => 'https://tab.example/' } })).toBe('https://tab.example/')
    expect(topUrlOf({ url: 'https://a/', resourceType: 'image', frame: { top: null }, webContents: { getURL: () => 'https://tab.example/' } })).toBe('https://tab.example/')
  })

  it('is undefined when neither can be read', () => {
    const throwing = { get top (): never { throw new Error('detached') } }
    expect(topUrlOf({ url: 'https://a/', resourceType: 'image', frame: throwing, webContents: { getURL: () => { throw new Error('destroyed') } } })).toBeUndefined()
    expect(topUrlOf({ url: 'https://a/', resourceType: 'image' })).toBeUndefined()
  })
})

describe('requestIsThirdParty', () => {
  it('reads the details the way Electron gives them', () => {
    expect(requestIsThirdParty({ url: 'https://tracker.example/p', resourceType: 'image', frame: { top: { url: 'https://shop.example/' } } })).toBe(true)
    expect(requestIsThirdParty({ url: 'https://shop.example/p', resourceType: 'image', frame: { top: { url: 'https://shop.example/' } } })).toBe(false)
  })
})

describe('createThirdPartyMemory', () => {
  it('remembers ids and forgets the oldest past its bound', () => {
    const memory = createThirdPartyMemory(3)
    for (const id of [1, 2, 3, 4]) memory.note(id)
    expect(memory.size()).toBe(3)
    expect(memory.has(1)).toBe(false)
    expect([2, 3, 4].every((id) => memory.has(id))).toBe(true)
  })

  it('counts an id noted again as the newest, not as a second entry', () => {
    const memory = createThirdPartyMemory(3)
    for (const id of [1, 2, 3, 1, 4]) memory.note(id)
    expect(memory.has(1)).toBe(true)
    expect(memory.has(2)).toBe(false)
    expect(memory.size()).toBe(3)
  })

  it('is bounded at 2,000 by default', () => {
    const memory = createThirdPartyMemory()
    for (let id = 0; id < THIRD_PARTY_MEMORY_LIMIT + 50; id++) memory.note(id)
    expect(memory.size()).toBe(THIRD_PARTY_MEMORY_LIMIT)
  })
})
