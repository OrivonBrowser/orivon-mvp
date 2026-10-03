import { describe, expect, it } from 'vitest'
import { createContentRules, isPdf, requestPage, SCRIPT_BLOCK_POLICY, withScriptBlock } from '../content-rules.js'
import type { ContentKind } from '../content-rules.js'
import { SiteSettingsStore } from '../site-settings-store.js'

const SITE = 'https://shop.example'

function rules (options: { defaults?: Partial<Record<ContentKind, 'allow' | 'block'>>, apps?: string[] } = {}) {
  const store = new SiteSettingsStore(null)
  return {
    store,
    rules: createContentRules({
      store,
      defaultFor: (kind) => options.defaults?.[kind] ?? (kind === 'popups' ? 'block' : 'allow'),
      isApp: (origin) => options.apps?.includes(origin) === true
    })
  }
}

describe('content rules', () => {
  it('blocks what the site was told to block, and nothing else', () => {
    const { store, rules: r } = rules()
    store.set(SITE, 'javascript', 'block')
    expect(r.scriptsBlocked(`${SITE}/a`)).toBe(true)
    expect(r.imagesBlocked(`${SITE}/a`)).toBe(false)
    expect(r.soundBlocked(`${SITE}/a`)).toBe(false)
    expect(r.scriptsBlocked('https://other.example/')).toBe(false)
  })

  it('follows the default for a site with no answer, and a stored answer wins over it', () => {
    const { store, rules: r } = rules({ defaults: { images: 'block' } })
    expect(r.imagesBlocked(`${SITE}/`)).toBe(true)
    store.set(SITE, 'images', 'allow')
    expect(r.imagesBlocked(`${SITE}/`)).toBe(false)
  })

  it('keeps ports apart: the answer is per origin', () => {
    const { store, rules: r } = rules()
    store.set('http://localhost:8000', 'sound', 'block')
    expect(r.soundBlocked('http://localhost:8000/x')).toBe(true)
    expect(r.soundBlocked('http://localhost:8001/x')).toBe(false)
  })

  it('has no answer for a page that is not a website or is a registered app', () => {
    const { store, rules: r } = rules({ apps: [SITE] })
    store.set(SITE, 'javascript', 'block')
    expect(r.valueFor('javascript', `${SITE}/`)).toBeUndefined()
    expect(r.scriptsBlocked(`${SITE}/`)).toBe(false)
    for (const url of ['orivon://settings/', 'file:///tmp/a.html', 'chrome-extension://abc/page.html', 'about:blank', '', undefined]) {
      expect(r.valueFor('javascript', url)).toBeUndefined()
    }
  })

  it('gives pop-ups their own default', () => {
    const { rules: r } = rules()
    expect(r.valueFor('popups', `${SITE}/`)).toBe('block')
  })
})

describe('withScriptBlock', () => {
  it('adds a policy header when the page sent none', () => {
    expect(withScriptBlock({ 'Content-Type': ['text/html'] })).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': [SCRIPT_BLOCK_POLICY] })
  })

  it.each(['Content-Security-Policy', 'content-security-policy', 'CONTENT-SECURITY-POLICY'])('appends to the page\'s own %s instead of replacing it', (name) => {
    const sent = { [name]: ["default-src 'self'"] }
    const result = withScriptBlock(sent)
    expect(result[name]).toEqual(["default-src 'self'", SCRIPT_BLOCK_POLICY])
    expect(Object.keys(result)).toEqual([name])
  })

  it('never changes what it was given', () => {
    const sent = { 'content-security-policy': ['a'] }
    withScriptBlock(sent)
    expect(sent).toEqual({ 'content-security-policy': ['a'] })
  })

  it('blocks inline handlers and script files alike with one directive', () => {
    expect(SCRIPT_BLOCK_POLICY).toBe("script-src 'none'")
  })
})

describe('isPdf', () => {
  it('spots a PDF whatever the header\'s case or parameters', () => {
    expect(isPdf({ 'Content-Type': ['application/pdf'] })).toBe(true)
    expect(isPdf({ 'content-type': ['Application/PDF; charset=binary'] })).toBe(true)
    expect(isPdf({ 'content-type': ['text/html'] })).toBe(false)
    expect(isPdf({})).toBe(false)
  })
})

describe('requestPage', () => {
  const tab = (url: string) => ({ getURL: () => url })

  it('takes the top frame\'s address first', () => {
    expect(requestPage({ frame: { top: { url: 'https://a.example/top' } }, referrer: 'https://b.example/', webContents: tab('https://c.example/') })).toBe('https://a.example/top')
  })

  it('takes the address that sent a request from the top document, since the frame can still hold the page it is leaving', () => {
    expect(requestPage({ frame: { parent: null, top: { url: 'https://leaving.example/' } }, referrer: 'https://arriving.example/', webContents: tab('https://leaving.example/') })).toBe('https://arriving.example/')
    // No referrer (a no-referrer policy): the frame's address, as before.
    expect(requestPage({ frame: { parent: null, top: { url: 'https://a.example/' } }, referrer: '', webContents: tab('https://c.example/') })).toBe('https://a.example/')
  })

  it('takes the referrer only when it is the page the tab is navigating to: a stylesheet on another site sent the rest', () => {
    const top = { parent: null, top: { url: 'https://news.example/story' } }
    // A request the arriving document sent, while the frame still holds the page it is leaving.
    expect(requestPage({ frame: { parent: null, top: { url: 'https://leaving.example/' } }, referrer: 'https://arriving.example/a', navigating: 'https://arriving.example/a', webContents: tab('https://leaving.example/') })).toBe('https://arriving.example/a')
    // An image a stylesheet on a CDN draws: its referrer is the stylesheet, the page is the top frame.
    expect(requestPage({ frame: top, referrer: 'https://cdn.example/site.css', navigating: 'https://news.example/story', webContents: tab('https://news.example/story') })).toBe('https://news.example/story')
  })

  it('keeps the top frame\'s address for a request from a frame inside the page, whose referrer is that frame', () => {
    expect(requestPage({ frame: { parent: {}, top: { url: 'https://a.example/' } }, referrer: 'https://embedded.example/', webContents: tab('https://a.example/') })).toBe('https://a.example/')
  })

  it('falls back to the address that sent the request, then to the tab', () => {
    expect(requestPage({ frame: null, referrer: 'https://b.example/', webContents: tab('https://c.example/') })).toBe('https://b.example/')
    expect(requestPage({ referrer: '', webContents: tab('https://c.example/') })).toBe('https://c.example/')
  })

  it('skips an answer that is not a website: a tab still showing the page it is leaving', () => {
    expect(requestPage({ frame: { top: { url: '' } }, referrer: 'https://b.example/', webContents: tab('file:///app/newtab/index.html') })).toBe('https://b.example/')
    expect(requestPage({ webContents: tab('orivon://settings/') })).toBeUndefined()
  })

  it('treats a read that throws as unknown and tries the next', () => {
    const frame = { get top (): never { throw new Error('frame gone') } }
    expect(requestPage({ frame, webContents: tab('https://c.example/') })).toBe('https://c.example/')
    expect(requestPage({ frame, webContents: { getURL: () => { throw new Error('destroyed') } } })).toBeUndefined()
  })

  it('answers nothing when it has nothing', () => {
    expect(requestPage({})).toBeUndefined()
  })
})
