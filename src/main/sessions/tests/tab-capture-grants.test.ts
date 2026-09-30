import { describe, expect, it } from 'vitest'
import {
  extensionIdFromChromeExtensionOrigin,
  hasLiveTabCaptureGrant,
  isTabCaptureMediaRequestAllowed,
  markTabCaptureGrantConsumed,
  mintTabCaptureGrant,
  wasTabCaptureGrantConsumed
} from '../tab-capture-grants.js'

// The ledger is a real module-level singleton (matches its production
// shape), so every test mints its OWN extension id -- sharing one across
// tests would leak a still-live grant from an earlier case into a later
// one's "no grant yet" assertion.
let nextId = 0
function freshExtensionId (): string {
  nextId += 1
  return `ext-${String(nextId)}-padpadpadpadpadpadpadpadpadpad`
}

describe('extensionIdFromChromeExtensionOrigin', () => {
  it('reads the id out of a chrome-extension:// origin', () => {
    const id = freshExtensionId()
    expect(extensionIdFromChromeExtensionOrigin(`chrome-extension://${id}/`)).toBe(id)
    expect(extensionIdFromChromeExtensionOrigin(`chrome-extension://${id}`)).toBe(id)
    expect(extensionIdFromChromeExtensionOrigin(`chrome-extension://${id}/html/offscreen.html`)).toBe(id)
  })

  it('is undefined for every other origin shape', () => {
    expect(extensionIdFromChromeExtensionOrigin('https://example.com/')).toBeUndefined()
    expect(extensionIdFromChromeExtensionOrigin('')).toBeUndefined()
    expect(extensionIdFromChromeExtensionOrigin(undefined)).toBeUndefined()
  })
})

describe('mintTabCaptureGrant / hasLiveTabCaptureGrant -- keyed by (extension, target tab)', () => {
  it('has no live grant before one is minted', () => {
    expect(hasLiveTabCaptureGrant(freshExtensionId(), 1, 0)).toBe(false)
  })

  it('is live immediately after minting, within the 10s validity window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 1000)
    expect(hasLiveTabCaptureGrant(id, 1, 1000)).toBe(true)
    expect(hasLiveTabCaptureGrant(id, 1, 1000 + 9_999)).toBe(true)
  })

  it('expires at exactly its own 10s window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 2000)
    expect(hasLiveTabCaptureGrant(id, 1, 2000 + 10_000)).toBe(false)
  })

  it('never leaks to a different extension id', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 3000)
    expect(hasLiveTabCaptureGrant(freshExtensionId(), 1, 3000)).toBe(false)
  })

  it('never leaks to a different target tab id, even for the same extension', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 3500)
    expect(hasLiveTabCaptureGrant(id, 2, 3500)).toBe(false)
  })
})

describe('isTabCaptureMediaRequestAllowed -- the permission-gate policy function', () => {
  it('denies a non-extension origin outright, even with a live grant for that id/tab', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 4000)
    expect(isTabCaptureMediaRequestAllowed('https://example.com/', 1, [], true, 4000)).toBe(false)
  })

  it('denies a chrome-extension:// origin with no live grant', () => {
    const id = freshExtensionId()
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, [], true, 5000)).toBe(false)
  })

  it('allows a chrome-extension:// origin with a live grant for the SAME captured tab, tab-capture shape', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 6000)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/html/offscreen.html`, 1, [], true, 6000)).toBe(true)
  })

  it('denies once the grant expires', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 7000)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, [], true, 7000 + 10_000)).toBe(false)
  })

  it('denies an undefined origin', () => {
    expect(isTabCaptureMediaRequestAllowed(undefined, 1, [], true, 8000)).toBe(false)
  })

  it('denies a live grant if the captured webContents is NOT the minted target tab -- a device request opens on the extension\'s OWN page, never the target tab', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 8500)
    // details.securityOrigin still names the extension, but `contents` the
    // caller passes is the extension's OWN page (tab id 99), not the
    // captured tab (1) -- measured: a real getUserMedia({audio,video})
    // device request's `contents` is the requester itself.
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 99, [], true, 8500)).toBe(false)
  })

  it('denies a device-shaped request (non-empty mediaTypes) even against the right tab', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 9000)
    // Measured: a real device getUserMedia({audio:true,video:true}) request
    // carries mediaTypes: ['audio','video']; tab capture carries [].
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, ['audio', 'video'], true, 9000)).toBe(false)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, ['audio'], true, 9000)).toBe(false)
  })

  it('denies a request from a SUBFRAME, even with matching origin, tab id and empty mediaTypes', () => {
    // MEASURED: getUserMedia({mandatory:{chromeMediaSource:'desktop'}}) --
    // no less than the real tab-capture shape -- also reports
    // mediaTypes: [] (docs/planning's tabCapture/offscreen probe). A
    // web-accessible chrome-extension:// iframe the extension injects into
    // the SAME tab it minted a grant for would report `contents` as that
    // tab too (a WebContents is the whole page; an iframe is a
    // WebFrameMain within it, not a separate WebContents) -- matching the
    // grant on both signals this ledger already checks. `isMainFrame`
    // (PermissionRequest's own documented field: "whether the frame making
    // the request is the main frame") is the one signal left standing: the
    // legitimate flow's own request is always its own main frame (measured:
    // true for every real tab-capture and offscreen-document request), an
    // iframe's own request is not.
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 9500)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, [], false, 9500)).toBe(false)
  })

  it('still allows the legitimate main-frame request once a subframe request for the same tab was refused', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 9600)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, [], false, 9600)).toBe(false)
    expect(isTabCaptureMediaRequestAllowed(`chrome-extension://${id}/`, 1, [], true, 9600)).toBe(true)
  })
})

describe('markTabCaptureGrantConsumed / wasTabCaptureGrantConsumed -- keyed by (extension, target tab)', () => {
  it('is never consumed before a grant exists at all', () => {
    expect(wasTabCaptureGrantConsumed(freshExtensionId(), 1)).toBe(false)
  })

  it('is not consumed immediately after minting, before anything redeems it', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 9500)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(false)
  })

  it('becomes consumed once marked, within the live window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 10_000)
    markTabCaptureGrantConsumed(id, 1, 10_000)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(true)
  })

  it('stays consumed long after the 10s minting window elapses -- the whole point', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 11_000)
    markTabCaptureGrantConsumed(id, 1, 11_000)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(true)
  })

  it('marking consumed after the grant already expired is a no-op', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 12_000)
    markTabCaptureGrantConsumed(id, 1, 12_000 + 10_000)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(false)
  })

  it('never leaks consumption to a different extension id', () => {
    const a = freshExtensionId()
    const b = freshExtensionId()
    mintTabCaptureGrant(a, 1, 13_000)
    mintTabCaptureGrant(b, 1, 13_000)
    markTabCaptureGrantConsumed(a, 1, 13_000)
    expect(wasTabCaptureGrantConsumed(a, 1)).toBe(true)
    expect(wasTabCaptureGrantConsumed(b, 1)).toBe(false)
  })

  it('never leaks consumption to a different target tab of the SAME extension: mint A + mint B + A\'s request must not mark B', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 13_500)
    mintTabCaptureGrant(id, 2, 13_500)
    markTabCaptureGrantConsumed(id, 1, 13_500)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(true)
    expect(wasTabCaptureGrantConsumed(id, 2)).toBe(false)
  })

  it('the reverse direction: consuming tab B never marks tab A', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 13_600)
    mintTabCaptureGrant(id, 2, 13_600)
    markTabCaptureGrantConsumed(id, 2, 13_600)
    expect(wasTabCaptureGrantConsumed(id, 2)).toBe(true)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(false)
  })

  it('a fresh mint after an earlier consumed grant starts unconsumed again', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1, 14_000)
    markTabCaptureGrantConsumed(id, 1, 14_000)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(true)
    mintTabCaptureGrant(id, 1, 14_500)
    expect(wasTabCaptureGrantConsumed(id, 1)).toBe(false)
  })
})
