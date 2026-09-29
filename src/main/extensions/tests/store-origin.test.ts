import { describe, expect, it } from 'vitest'
import { isWebStoreFrame } from '../../../../vendor/electron-chrome-web-store/src/browser/api.js'

// isWebStoreFrame is the gate that decides whether a webContents frame may
// call the Chrome Web Store's IPC channels (UPSTREAM.md patch 5): exact
// origin, and only the page's own top frame. A plain object shaped like
// Electron.WebFrameMain is enough to test it -- no real Electron needed.
type FakeFrame = Electron.WebFrameMain

function frame (overrides: { origin?: string, top?: unknown, destroyed?: boolean } = {}): FakeFrame {
  const self = {
    origin: overrides.origin ?? 'https://chromewebstore.google.com',
    top: undefined as unknown,
    isDestroyed: () => overrides.destroyed ?? false
  }
  self.top = overrides.top ?? self
  return self as unknown as FakeFrame
}

describe('isWebStoreFrame', () => {
  it('accepts the store\'s own top frame', () => {
    expect(isWebStoreFrame(frame())).toBe(true)
  })

  it('refuses null or undefined', () => {
    expect(isWebStoreFrame(null)).toBe(false)
    expect(isWebStoreFrame(undefined)).toBe(false)
  })

  it('refuses a destroyed frame', () => {
    expect(isWebStoreFrame(frame({ destroyed: true }))).toBe(false)
  })

  it('refuses an origin that only starts with the store\'s own', () => {
    expect(isWebStoreFrame(frame({ origin: 'https://chromewebstore.google.com.evil.com' }))).toBe(false)
  })

  it('refuses a plain mismatched origin', () => {
    expect(isWebStoreFrame(frame({ origin: 'https://evil.example' }))).toBe(false)
  })

  it('refuses a frame embedded inside another frame, even on the store\'s own origin', () => {
    // A distinct object stands in for "some other frame" -- the exact
    // identity does not matter, only that a frame's `.top` is not itself.
    const embedded = frame({ top: frame({ origin: 'https://chromewebstore.google.com' }) })
    expect(isWebStoreFrame(embedded)).toBe(false)
  })
})
