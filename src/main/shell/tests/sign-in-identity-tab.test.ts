import { EventEmitter } from 'node:events'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { wireSignInIdentity } from '../sign-in-identity-tab.js'

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** The few members of a tab's webContents the wiring touches; the user agent is the live string a real one keeps. */
function fakeTab (): { tab: WebContents, emitter: EventEmitter, setUserAgent: ReturnType<typeof vi.fn>, at: (url: string) => void } {
  const emitter = new EventEmitter()
  let userAgent = CHROME
  let url = 'about:blank'
  const setUserAgent = vi.fn((value: string) => { userAgent = value })
  const tab = Object.assign(emitter, { getUserAgent: () => userAgent, setUserAgent, getURL: () => url }) as unknown as WebContents
  return { tab, emitter, setUserAgent, at: (next) => { url = next } }
}

const SIGN_IN = 'https://accounts.google.com/signin'
const ELSEWHERE = 'https://www.youtube.com/'

describe('wireSignInIdentity', () => {
  // Plain Node has no Chromium version; Electron's process does.
  beforeAll(() => { Object.defineProperty(process.versions, 'chrome', { value: '140.0.0.0', configurable: true }) })

  it('never swaps the identity from will-redirect, where Chromium answers by reloading the tab mid-navigation', () => {
    const { tab, emitter, setUserAgent } = fakeTab()
    wireSignInIdentity(tab)
    emitter.emit('will-redirect', { url: SIGN_IN, isMainFrame: true })
    emitter.emit('will-redirect', { url: ELSEWHERE, isMainFrame: true })
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('never swaps the identity from will-navigate either, for the same reason', () => {
    const { tab, emitter, setUserAgent } = fakeTab()
    wireSignInIdentity(tab)
    emitter.emit('will-navigate', { url: SIGN_IN, isMainFrame: true })
    emitter.emit('will-navigate', { url: ELSEWHERE, isMainFrame: true })
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('swaps once at the start of a navigation onto a sign-in host, and back at the start of one off it', () => {
    const { tab, emitter, setUserAgent } = fakeTab()
    wireSignInIdentity(tab)
    emitter.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    emitter.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    expect(setUserAgent).toHaveBeenCalledTimes(1)
    expect(setUserAgent.mock.calls[0]![0]).toContain('Firefox/')
    emitter.emit('did-start-navigation', { url: ELSEWHERE, isMainFrame: true, isSameDocument: false })
    expect(setUserAgent).toHaveBeenCalledTimes(2)
    expect(setUserAgent.mock.calls[1]![0]).toContain('Chrome/')
  })

  it('ignores subframes and same-document navigations', () => {
    const { tab, emitter, setUserAgent } = fakeTab()
    wireSignInIdentity(tab)
    emitter.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: false, isSameDocument: false })
    emitter.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: true })
    expect(setUserAgent).not.toHaveBeenCalled()
  })

  it('restores the Chrome identity when a redirect took the tab off the sign-in host, once loading has stopped', () => {
    const { tab, emitter, setUserAgent, at } = fakeTab()
    wireSignInIdentity(tab)
    emitter.emit('did-start-navigation', { url: SIGN_IN, isMainFrame: true, isSameDocument: false })
    emitter.emit('will-redirect', { url: ELSEWHERE, isMainFrame: true })
    at(ELSEWHERE)
    expect(setUserAgent).toHaveBeenCalledTimes(1)
    emitter.emit('did-stop-loading')
    expect(setUserAgent).toHaveBeenCalledTimes(2)
    expect(setUserAgent.mock.calls[1]![0]).toContain('Chrome/')
  })

  it('takes the Firefox identity at did-stop-loading when a redirect entered a sign-in host, and does nothing when the tab is already right', () => {
    const { tab, emitter, setUserAgent, at } = fakeTab()
    wireSignInIdentity(tab)
    at(SIGN_IN)
    emitter.emit('did-stop-loading')
    expect(setUserAgent).toHaveBeenCalledTimes(1)
    expect(setUserAgent.mock.calls[0]![0]).toContain('Firefox/')
    emitter.emit('did-stop-loading')
    expect(setUserAgent).toHaveBeenCalledTimes(1)
  })

  it('leaves an ordinary tab alone: it never calls setUserAgent', () => {
    const { tab, emitter, setUserAgent, at } = fakeTab()
    wireSignInIdentity(tab)
    at('https://example.com/')
    emitter.emit('did-start-navigation', { url: 'https://example.com/', isMainFrame: true, isSameDocument: false })
    emitter.emit('did-stop-loading')
    expect(setUserAgent).not.toHaveBeenCalled()
  })
})
