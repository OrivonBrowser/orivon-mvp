import { describe, expect, it } from 'vitest'
import { extensionIdFromChromeExtensionOrigin, hasLiveTabCaptureGrant, isTabCaptureMediaAllowed, mintTabCaptureGrant } from '../tab-capture-grants.js'

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
