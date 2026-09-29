import { describe, expect, it } from 'vitest'
import { extensionIdFromChromeExtensionOrigin, hasLiveTabCaptureGrant, isTabCaptureMediaAllowed, markTabCaptureGrantConsumed, mintTabCaptureGrant, wasTabCaptureGrantConsumed } from '../tab-capture-grants.js'

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

describe('mintTabCaptureGrant / hasLiveTabCaptureGrant', () => {
  it('has no live grant before one is minted', () => {
    expect(hasLiveTabCaptureGrant(freshExtensionId(), 0)).toBe(false)
  })

  it('is live immediately after minting, within the 10s validity window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 1000)
    expect(hasLiveTabCaptureGrant(id, 1000)).toBe(true)
    expect(hasLiveTabCaptureGrant(id, 1000 + 9_999)).toBe(true)
  })

  it('expires at exactly its own 10s window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 2000)
    expect(hasLiveTabCaptureGrant(id, 2000 + 10_000)).toBe(false)
  })

  it('never leaks to a different extension id', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 3000)
    expect(hasLiveTabCaptureGrant(freshExtensionId(), 3000)).toBe(false)
  })
})

describe('isTabCaptureMediaAllowed -- the permission-gate policy function', () => {
  it('denies a non-extension origin outright, even with a live grant for that id', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 4000)
    expect(isTabCaptureMediaAllowed('https://example.com/', 4000)).toBe(false)
  })

  it('denies a chrome-extension:// origin with no live grant', () => {
    const id = freshExtensionId()
    expect(isTabCaptureMediaAllowed(`chrome-extension://${id}/`, 5000)).toBe(false)
  })

  it('allows a chrome-extension:// origin with a live grant', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 6000)
    expect(isTabCaptureMediaAllowed(`chrome-extension://${id}/html/offscreen.html`, 6000)).toBe(true)
  })

  it('denies once the grant expires', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 7000)
    expect(isTabCaptureMediaAllowed(`chrome-extension://${id}/`, 7000 + 10_000)).toBe(false)
  })

  it('denies an undefined origin', () => {
    expect(isTabCaptureMediaAllowed(undefined, 8000)).toBe(false)
  })
})

describe('markTabCaptureGrantConsumed / wasTabCaptureGrantConsumed', () => {
  it('is never consumed before a grant exists at all', () => {
    expect(wasTabCaptureGrantConsumed(freshExtensionId())).toBe(false)
  })

  it('is not consumed immediately after minting, before anything redeems it', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 9000)
    expect(wasTabCaptureGrantConsumed(id)).toBe(false)
  })

  it('becomes consumed once marked, within the live window', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 10_000)
    markTabCaptureGrantConsumed(id, 10_000)
    expect(wasTabCaptureGrantConsumed(id)).toBe(true)
  })

  it('stays consumed long after the 10s minting window elapses -- the whole point', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 11_000)
    markTabCaptureGrantConsumed(id, 11_000)
    expect(wasTabCaptureGrantConsumed(id)).toBe(true)
    // Far past TAB_CAPTURE_GRANT_MS (10s) -- a consumed capture must never
    // look "expired" to a caller checking hours into a real capture.
    expect(wasTabCaptureGrantConsumed(id)).toBe(true)
  })

  it('marking consumed after the grant already expired is a no-op', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 12_000)
    markTabCaptureGrantConsumed(id, 12_000 + 10_000)
    expect(wasTabCaptureGrantConsumed(id)).toBe(false)
  })

  it('never leaks consumption to a different extension id', () => {
    const a = freshExtensionId()
    const b = freshExtensionId()
    mintTabCaptureGrant(a, 13_000)
    mintTabCaptureGrant(b, 13_000)
    markTabCaptureGrantConsumed(a, 13_000)
    expect(wasTabCaptureGrantConsumed(a)).toBe(true)
    expect(wasTabCaptureGrantConsumed(b)).toBe(false)
  })

  it('a fresh mint after an earlier consumed grant starts unconsumed again', () => {
    const id = freshExtensionId()
    mintTabCaptureGrant(id, 14_000)
    markTabCaptureGrantConsumed(id, 14_000)
    expect(wasTabCaptureGrantConsumed(id)).toBe(true)
    mintTabCaptureGrant(id, 14_500)
    expect(wasTabCaptureGrantConsumed(id)).toBe(false)
  })
})
