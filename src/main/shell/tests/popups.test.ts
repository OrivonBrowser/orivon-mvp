import { describe, expect, it, vi } from 'vitest'

// popups.ts constructs WebContentsView when it adopts a popup; routePopup
// itself is pure, but the module cannot load without the mock.
vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { routePopup } = await import('../popups.js')

const APP = 'https://app.example/'
const APP_PARTITION = 'persist:app'
const inApp = { url: APP, partition: APP_PARTITION }
const onWeb = { url: 'https://news.example/story', partition: undefined }

/** Every existing test in this file exercises no granted/cache-served origin at all. */
const notAnApp = (): boolean => false

type Details = Parameters<typeof routePopup>[0]
const scripted = (url: string, features = ''): Details => ({ url, features, disposition: 'foreground-tab' })
const popupWindow = (url: string): Details => ({ url, features: 'width=500,height=600', disposition: 'new-window' })

describe('routePopup -- which window.open()/target=_blank calls keep their opener', () => {
  it('opens a protocol address in a new tab, which loads it from the URL serving it', () => {
    expect(routePopup(popupWindow('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'), onWeb, undefined, notAnApp)).toBe('new-tab')
    expect(routePopup(scripted('ipns://docs.ipfs.tech'), onWeb, undefined, notAnApp)).toBe('new-tab')
  })

  it('adopts a popup whose target belongs in the opener\'s own session, so window.open returns a real window', () => {
    expect(routePopup(scripted('https://other.example/'), onWeb, undefined, notAnApp)).toBe('adopt')
    expect(routePopup(scripted(`${APP}popout`), inApp, APP_PARTITION, notAnApp)).toBe('adopt')
  })

  it('adopts a sign-in popup (window features) even though its target would otherwise get another session', () => {
    // OAuth: an app opens its identity provider in a sized popup and waits
    // for a postMessage back through window.opener. Chromium keeps a popup
    // with an opener in its opener's session; a tab in any other session
    // could not be its window.
    expect(routePopup(popupWindow('https://accounts.example/auth'), inApp, undefined, notAnApp)).toBe('adopt')
  })

  it('never adopts a popup into an isolated app from another session, even one the page asked for', () => {
    // An isolated app's pinned bundle is served only in its own partition;
    // anywhere else its origin would run whatever the network sends, with
    // its grants.
    expect(routePopup(popupWindow(`${APP}signin`), onWeb, APP_PARTITION, notAnApp)).toBe('new-tab')
    expect(routePopup(popupWindow(`${APP}signin`), { url: 'https://b.example/', partition: 'persist:b' }, APP_PARTITION, notAnApp)).toBe('new-tab')
  })

  it('adopts a blank popup the page will write into or navigate itself', () => {
    expect(routePopup(scripted('about:blank'), inApp, undefined, notAnApp)).toBe('adopt')
  })

  it('opens a plain new tab, in the right session from its first load, for a link or featureless open that crosses sessions', () => {
    // A target=_blank link from an app to the open web: nothing waits on
    // an opener, and loading it in the app's session first would write the
    // site's cookies into the app's partition before the swap.
    expect(routePopup(scripted('https://github.example/'), inApp, undefined, notAnApp)).toBe('new-tab')
    expect(routePopup(scripted(APP), onWeb, APP_PARTITION, notAnApp)).toBe('new-tab')
  })

  it('opens a disconnected tab for noopener and noreferrer, as the page asked', () => {
    expect(routePopup(scripted('https://other.example/', 'noopener'), onWeb, undefined, notAnApp)).toBe('new-tab')
    expect(routePopup(scripted('https://other.example/', 'width=10,noreferrer'), onWeb, undefined, notAnApp)).toBe('new-tab')
    expect(routePopup({ ...popupWindow('https://accounts.example/'), features: 'noopener,width=500' }, inApp, undefined, notAnApp)).toBe('new-tab')
  })

  it('matches noopener as a whole feature name, not as a substring of another one', () => {
    expect(routePopup(scripted('https://other.example/', 'nonoopenerx=1'), onWeb, undefined, notAnApp)).toBe('adopt')
  })

  it('adopts a blob: URL from the opener\'s own origin, which only resolves inside the opener\'s session', () => {
    expect(routePopup(scripted('blob:https://app.example/1b4e28ba-2fa1'), inApp, undefined, notAnApp)).toBe('adopt')
    expect(routePopup(scripted('blob:https://app.example/1b4e28ba-2fa1', 'noopener'), inApp, undefined, notAnApp)).toBe('adopt')
  })

  it('does not adopt a blob: URL minted by some other origin', () => {
    expect(routePopup(scripted('blob:https://evil.example/1b4e28ba-2fa1'), inApp, undefined, notAnApp)).toBe('new-tab')
  })
})

// ADR-0044 stopped a held grant, on its own, from putting an origin in its
// own partition -- a granted, network-served app and an ordinary site both
// now commonly carry `partition: undefined`, so `targetPartition ===
// opener.partition` alone can no longer tell them apart. `isApp` is the
// arm that catches this: README.md's Design notes.
describe('routePopup -- isApp: a granted or cache-served origin never keeps an opener from a different origin', () => {
  const isGrantedApp = (url: string): boolean => url.startsWith(APP)
  // A GRANTED-but-not-cache-served app's own tab: partition undefined, per ADR-0044 -- unlike `inApp` above, which represents the cache-served, real-partition case pre-existing tests use.
  const inGrantedApp = { url: APP, partition: undefined }

  it('an ordinary site popping open a GRANTED, network-served app (no partition of its own) is severed, not adopted', () => {
    // Both sides carry `partition: undefined` -- the exact gap ADR-0044 opened.
    expect(routePopup(scripted(`${APP}connect`), onWeb, undefined, isGrantedApp)).toBe('new-tab')
    expect(routePopup(popupWindow(`${APP}connect`), onWeb, undefined, isGrantedApp)).toBe('new-tab')
  })

  it('a granted app popping open a DIFFERENT granted app is also severed, even with matching (undefined) partitions', () => {
    const bothGranted = (url: string): boolean => url.startsWith(APP) || url.startsWith('https://other-app.example/')
    expect(routePopup(scripted('https://other-app.example/x'), inApp, undefined, bothGranted)).toBe('new-tab')
  })

  it('a granted app popping open a popup to ITSELF (same origin) is unaffected -- still adopted', () => {
    expect(routePopup(scripted(`${APP}popout`), inGrantedApp, undefined, isGrantedApp)).toBe('adopt')
    expect(routePopup(popupWindow(`${APP}auth`), inGrantedApp, undefined, isGrantedApp)).toBe('adopt')
  })

  it('a cache-served app (with its own real partition) popped from a different origin stays severed -- isApp only reinforces the existing partition check', () => {
    const isCacheServed = (url: string): boolean => url.startsWith(APP)
    expect(routePopup(popupWindow(`${APP}signin`), onWeb, APP_PARTITION, isCacheServed)).toBe('new-tab')
  })
})
