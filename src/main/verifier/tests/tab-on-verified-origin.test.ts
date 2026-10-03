import { describe, expect, it } from 'vitest'
import { anyTabOnVerifiedOrigin } from '../tab-on-verified-origin.js'
import type { TabsOfWindow } from '../tab-on-verified-origin.js'

function windowOf (urls: Record<string, string | undefined>, destroyed = false): TabsOfWindow {
  return {
    tabs: { ids: () => Object.keys(urls), liveWebContents: (id) => { const url = urls[id]; return url === undefined ? undefined : { getURL: () => url } } },
    window: { isDestroyed: () => destroyed }
  }
}

describe('anyTabOnVerifiedOrigin', () => {
  it('is true when one tab of any window shows a .eth name or an address', () => {
    expect(anyTabOnVerifiedOrigin([windowOf({ a: 'https://example.com/' }), windowOf({ b: 'https://vitalik.eth/' })])).toBe(true)
    expect(anyTabOnVerifiedOrigin([windowOf({ a: 'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon/' })])).toBe(true)
  })

  it('is false for ordinary pages, a blank or sleeping tab, a destroyed window and no windows', () => {
    expect(anyTabOnVerifiedOrigin([windowOf({ a: 'https://example.com/', b: '', c: 'about:blank', d: undefined })])).toBe(false)
    expect(anyTabOnVerifiedOrigin([windowOf({ a: 'https://vitalik.eth/' }, true)])).toBe(false)
    expect(anyTabOnVerifiedOrigin([])).toBe(false)
  })

  it('does not take a page that merely mentions a name for one on it', () => {
    expect(anyTabOnVerifiedOrigin([windowOf({ a: 'https://example.com/vitalik.eth', b: 'http://vitalik.eth/' })])).toBe(false)
  })
})
