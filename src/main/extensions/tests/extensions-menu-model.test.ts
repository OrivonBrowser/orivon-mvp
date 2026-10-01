import { describe, expect, it } from 'vitest'
import { anchorFrom, asRequest, buildRows, fallbackAnchor, isExtensionId, optionsPageUrl, siteHost } from '../extensions-menu-model.js'
import type { MenuEntry } from '../extensions-menu-model.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const entry = (id: string, name: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({ id, name, icon: null, optionsUrl: undefined, ...extra })

describe('isExtensionId', () => {
  it('accepts exactly thirty-two letters from a to p', () => {
    expect(isExtensionId(A)).toBe(true)
    expect(isExtensionId('a'.repeat(31))).toBe(false)
    expect(isExtensionId('q'.repeat(32))).toBe(false)
    expect(isExtensionId('A'.repeat(32))).toBe(false)
    expect(isExtensionId(`${A}x`)).toBe(false)
    expect(isExtensionId(7)).toBe(false)
    expect(isExtensionId(undefined)).toBe(false)
  })
})

describe('buildRows', () => {
  it('marks what each extension can do, from its action and its options page', () => {
    const actions = new Map([[A, { hasPopup: true, badge: '3' }]])
    const rows = buildRows([entry(A, 'Alpha', { optionsUrl: `chrome-extension://${A}/o.html` }), entry(B, 'Beta')], actions, () => true, () => ({}))
    expect(rows).toEqual([
      { id: A, name: 'Alpha', icon: null, pinned: true, hasAction: true, hasOptions: true, badge: '3', parts: {} },
      { id: B, name: 'Beta', icon: null, pinned: false, hasAction: false, hasOptions: false, badge: '', parts: {} }
    ])
  })

  it('lists the pinned first, then by name, and never calls an extension with no action pinned', () => {
    const actions = new Map([[A, { hasPopup: false, badge: '' }], [B, { hasPopup: false, badge: '' }]])
    const rows = buildRows([entry('c'.repeat(32), 'Aardvark'), entry(A, 'Zulu'), entry(B, 'Yankee')], actions, (id) => id === A, () => ({}))
    expect(rows.map((row) => row.name)).toEqual(['Zulu', 'Aardvark', 'Yankee'])
    expect(rows.map((row) => row.pinned)).toEqual([true, false, false])
  })

  it('carries what each feature added for a row', () => {
    const rows = buildRows([entry(A, 'Alpha')], new Map(), () => false, (id) => ({ site: id }))
    expect(rows[0]?.parts).toEqual({ site: A })
  })
})

describe('asRequest', () => {
  it('needs an object with a string type', () => {
    expect(asRequest({ type: 'pin', id: A })).toEqual({ type: 'pin', body: { type: 'pin', id: A } })
    for (const bad of [null, undefined, 'pin', 3, [], { type: 3 }, {}]) expect(asRequest(bad)).toBeUndefined()
  })
})

describe('anchorFrom', () => {
  it('reads four finite numbers', () => {
    expect(anchorFrom({ anchor: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('refuses anything else', () => {
    expect(anchorFrom(undefined)).toBeUndefined()
    expect(anchorFrom({ anchor: { x: 1, y: 2, width: 3 } })).toBeUndefined()
    expect(anchorFrom({ anchor: { x: 1, y: 2, width: 3, height: Number.NaN } })).toBeUndefined()
    expect(anchorFrom({ anchor: { x: '1', y: 2, width: 3, height: 4 } })).toBeUndefined()
    expect(anchorFrom({ anchor: 5 })).toBeUndefined()
  })
})

describe('fallbackAnchor', () => {
  it('hangs under the toolbar\'s right end and stays inside a narrow window', () => {
    expect(fallbackAnchor(1000)).toMatchObject({ x: 888, width: 32 })
    expect(fallbackAnchor(50).x).toBe(0)
  })
})

describe('siteHost', () => {
  it('names the host of a site and nothing else', () => {
    expect(siteHost('https://example.com:8443/a', true)).toBe('example.com:8443')
    expect(siteHost('http://127.0.0.1:3000/', true)).toBe('127.0.0.1:3000')
    expect(siteHost('https://example.com/', false)).toBeNull()
    expect(siteHost('file:///tmp/x', true)).toBeNull()
    expect(siteHost('orivon://settings/', true)).toBeNull()
    expect(siteHost('not a url', true)).toBeNull()
    expect(siteHost(undefined, true)).toBeNull()
  })
})

describe('optionsPageUrl', () => {
  it('resolves options_page, else options_ui.page, inside the extension', () => {
    expect(optionsPageUrl(A, { options_page: 'options.html' })).toBe(`chrome-extension://${A}/options.html`)
    expect(optionsPageUrl(A, { options_ui: { page: '/ui/o.html' } })).toBe(`chrome-extension://${A}/ui/o.html`)
    expect(optionsPageUrl(A, { options_page: 'a.html', options_ui: { page: 'b.html' } })).toBe(`chrome-extension://${A}/a.html`)
  })

  it('has none when the manifest names none, or names a place outside the extension', () => {
    expect(optionsPageUrl(A, {})).toBeUndefined()
    expect(optionsPageUrl(A, undefined)).toBeUndefined()
    expect(optionsPageUrl(A, { options_page: '' })).toBeUndefined()
    expect(optionsPageUrl(A, { options_page: 'https://evil.example/' })).toBeUndefined()
    expect(optionsPageUrl(A, { options_page: `chrome-extension://${B}/o.html` })).toBeUndefined()
  })
})
