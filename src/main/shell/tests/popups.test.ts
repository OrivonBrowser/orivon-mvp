import { describe, expect, it, vi } from 'vitest'

// popups.ts constructs WebContentsView when it adopts a popup; routePopup
// itself is pure, but the module cannot load without the mock.
vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { routePopup } = await import('../popups.js')

const APP = 'https://app.example/'
const APP_PARTITION = 'persist:app'
const inApp = { url: APP, partition: APP_PARTITION }
const onWeb = { url: 'https://news.example/story', partition: undefined }

type Details = Parameters<typeof routePopup>[0]
const scripted = (url: string, features = ''): Details => ({ url, features, disposition: 'foreground-tab' })
const popupWindow = (url: string): Details => ({ url, features: 'width=500,height=600', disposition: 'new-window' })

describe('routePopup -- which window.open()/target=_blank calls keep their opener', () => {
  it('adopts a popup whose target belongs in the opener\'s own session, so window.open returns a real window', () => {
    expect(routePopup(scripted('https://other.example/'), onWeb, undefined)).toBe('adopt')
    expect(routePopup(scripted(`${APP}popout`), inApp, APP_PARTITION)).toBe('adopt')
  })

  it('adopts a sign-in popup (window features) even though its target would otherwise get another session', () => {
    // OAuth: an app opens its identity provider in a sized popup and waits
    // for a postMessage back through window.opener. Chromium keeps a popup
    // with an opener in its opener's session; a tab in any other session
    // could not be its window.
    expect(routePopup(popupWindow('https://accounts.example/auth'), inApp, undefined)).toBe('adopt')
  })

  it('adopts a blank popup the page will write into or navigate itself', () => {
    expect(routePopup(scripted('about:blank'), inApp, undefined)).toBe('adopt')
  })

  it('opens a plain new tab, in the right session from its first load, for a link or featureless open that crosses sessions', () => {
    // A target=_blank link from an app to the open web: nothing waits on
    // an opener, and loading it in the app's session first would write the
    // site's cookies into the app's partition before the swap.
    expect(routePopup(scripted('https://github.example/'), inApp, undefined)).toBe('new-tab')
    expect(routePopup(scripted(APP), onWeb, APP_PARTITION)).toBe('new-tab')
  })

  it('opens a disconnected tab for noopener and noreferrer, as the page asked', () => {
    expect(routePopup(scripted('https://other.example/', 'noopener'), onWeb, undefined)).toBe('new-tab')
    expect(routePopup(scripted('https://other.example/', 'width=10,noreferrer'), onWeb, undefined)).toBe('new-tab')
    expect(routePopup({ ...popupWindow('https://accounts.example/'), features: 'noopener,width=500' }, inApp, undefined)).toBe('new-tab')
  })

  it('matches noopener as a whole feature name, not as a substring of another one', () => {
    expect(routePopup(scripted('https://other.example/', 'nonoopenerx=1'), onWeb, undefined)).toBe('adopt')
  })

  it('adopts a blob: URL from the opener\'s own origin, which only resolves inside the opener\'s session', () => {
    expect(routePopup(scripted('blob:https://app.example/1b4e28ba-2fa1'), inApp, undefined)).toBe('adopt')
    expect(routePopup(scripted('blob:https://app.example/1b4e28ba-2fa1', 'noopener'), inApp, undefined)).toBe('adopt')
  })

  it('does not adopt a blob: URL minted by some other origin', () => {
    expect(routePopup(scripted('blob:https://evil.example/1b4e28ba-2fa1'), inApp, undefined)).toBe('new-tab')
  })
})
