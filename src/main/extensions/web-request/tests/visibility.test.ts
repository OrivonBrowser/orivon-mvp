import { describe, expect, it } from 'vitest'
import { requestVisibleTo, type VisibleRequest } from '../visibility.js'

const ME = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const all = (): boolean => true
const none = (): boolean => false

const page = (overrides: Partial<VisibleRequest> = {}): VisibleRequest => ({
  url: 'https://site.example/a.js', fromPage: true, type: 'script', initiator: 'https://site.example', ...overrides
})

describe('requestVisibleTo', () => {
  it('shows an ordinary page request to an extension with host access', () => {
    expect(requestVisibleTo(ME, page(), all)).toBe(true)
  })

  it('hides Orivon\'s own main-process requests', () => {
    expect(requestVisibleTo(ME, page({ fromPage: false }), all)).toBe(false)
  })

  it('needs host access to the URL', () => {
    expect(requestVisibleTo(ME, page(), none)).toBe(false)
    expect(requestVisibleTo(ME, page(), (url) => url.startsWith('https://other.example/'))).toBe(false)
  })

  it('needs host access to the initiator of a subresource, not of a navigation', () => {
    const onlyTarget = (url: string): boolean => url.startsWith('https://target.example/')
    const subresource = page({ url: 'https://target.example/x.js', initiator: 'https://embedder.example' })
    expect(requestVisibleTo(ME, subresource, onlyTarget)).toBe(false)
    expect(requestVisibleTo(ME, { ...subresource, type: 'sub_frame' }, onlyTarget)).toBe(true)
    expect(requestVisibleTo(ME, { ...subresource, type: 'main_frame', initiator: undefined }, onlyTarget)).toBe(true)
  })

  it('asks host access about the http origin of a ws request and the https origin of a wss one', () => {
    const asked: string[] = []
    requestVisibleTo(ME, page({ url: 'ws://sock.example/s', type: 'websocket', initiator: undefined }), (url) => { asked.push(url); return true })
    requestVisibleTo(ME, page({ url: 'wss://sock.example/s', type: 'websocket', initiator: undefined }), (url) => { asked.push(url); return true })
    expect(asked).toEqual(['http://sock.example/s', 'https://sock.example/s'])
  })

  it('hides a scheme that is not http, https, ws or wss', () => {
    for (const url of ['data:text/plain,x', 'blob:https://site.example/1', 'file:///tmp/x', 'ftp://site.example/x', 'orivon://newtab/', 'chrome://gpu']) {
      expect(requestVisibleTo(ME, page({ url, initiator: undefined }), all)).toBe(false)
    }
  })

  it('shows an extension its own pages and no other extension\'s', () => {
    const own = page({ url: `chrome-extension://${ME}/web_accessible_resources/x.js` })
    const foreign = page({ url: `chrome-extension://${OTHER}/web_accessible_resources/x.js` })
    expect(requestVisibleTo(ME, own, (url) => !url.startsWith('chrome-extension:'))).toBe(true)
    expect(requestVisibleTo(ME, foreign, all)).toBe(false)
  })

  it('hides a request made by an Orivon, chrome or devtools document or by another extension\'s page', () => {
    for (const initiator of ['orivon://newtab', 'chrome://settings', 'devtools://devtools', `chrome-extension://${OTHER}`]) {
      expect(requestVisibleTo(ME, page({ initiator }), all)).toBe(false)
    }
  })

  it('shows a request made by the extension\'s own page, without asking host access to the initiator', () => {
    const onlyTarget = (url: string): boolean => url.startsWith('https://site.example/')
    expect(requestVisibleTo(ME, page({ initiator: `chrome-extension://${ME}` }), onlyTarget)).toBe(true)
  })

  it('hides the web store from every extension', () => {
    expect(requestVisibleTo(ME, page({ url: 'https://chromewebstore.google.com/detail/x' }), all)).toBe(false)
    expect(requestVisibleTo(ME, page({ url: 'https://chrome.google.com/webstore/detail/x' }), all)).toBe(false)
    expect(requestVisibleTo(ME, page({ url: 'https://chrome.google.com/other' }), all)).toBe(true)
  })

  it('treats a malformed URL as hidden and a malformed initiator as absent', () => {
    expect(requestVisibleTo(ME, page({ url: '::' }), all)).toBe(false)
    expect(requestVisibleTo(ME, page({ initiator: 'null' }), all)).toBe(true)
  })
})
