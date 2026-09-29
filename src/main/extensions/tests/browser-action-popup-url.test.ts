import { describe, expect, it, vi } from 'vitest'

// Drives the REAL BrowserActionAPI.getPopupUrl (private, reached the same
// way other suites reach a vendored private method: `(api as any)`).
vi.mock('electron', () => ({
  Menu: class {},
  MenuItem: class {},
  nativeImage: {}
}))

const { BrowserActionAPI } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js'
)

function fakeCtx (): any {
  return {
    router: { apiHandler: () => vi.fn() },
    session: { extensions: { on: vi.fn() } },
    store: { on: vi.fn() }
  }
}

const OWN_ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)

describe('BrowserActionAPI.getPopupUrl: only the extension\'s own chrome-extension: origin', () => {
  it('resolves a relative popup path against the extension\'s own origin', () => {
    const api = new BrowserActionAPI(fakeCtx())
    ;(api as any).getAction(OWN_ID).popup = 'popup.html'

    expect((api as any).getPopupUrl(OWN_ID, 1)).toBe(`chrome-extension://${OWN_ID}/popup.html`)
  })

  it('refuses an absolute http(s) URL', () => {
    const api = new BrowserActionAPI(fakeCtx())
    ;(api as any).getAction(OWN_ID).popup = 'https://evil.example/phish.html'

    expect((api as any).getPopupUrl(OWN_ID, 1)).toBeUndefined()
  })

  it('refuses an absolute file: URL', () => {
    const api = new BrowserActionAPI(fakeCtx())
    ;(api as any).getAction(OWN_ID).popup = 'file:///etc/passwd'

    expect((api as any).getPopupUrl(OWN_ID, 1)).toBeUndefined()
  })

  it('refuses another extension\'s own chrome-extension: origin', () => {
    const api = new BrowserActionAPI(fakeCtx())
    ;(api as any).getAction(OWN_ID).popup = `chrome-extension://${OTHER_ID}/popup.html`

    expect((api as any).getPopupUrl(OWN_ID, 1)).toBeUndefined()
  })

  it('allows an absolute URL under the extension\'s own origin', () => {
    const api = new BrowserActionAPI(fakeCtx())
    ;(api as any).getAction(OWN_ID).popup = `chrome-extension://${OWN_ID}/sub/popup.html`

    expect((api as any).getPopupUrl(OWN_ID, 1)).toBe(`chrome-extension://${OWN_ID}/sub/popup.html`)
  })

  it('returns undefined when no popup is set', () => {
    const api = new BrowserActionAPI(fakeCtx())
    expect((api as any).getPopupUrl(OWN_ID, 1)).toBeUndefined()
  })
})
