import { EventEmitter } from 'node:events'
import type { DownloadItem, Session, WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDownloads } from '../install-downloads.js'

class FakeSession extends EventEmitter {}

function setup (discardHeldAtQuit = false) {
  const app = new EventEmitter()
  const discardHeldFiles = vi.fn()
  const defaultSession = new FakeSession()
  const track = vi.fn()
  const tabs = new Set<WebContents>()
  installDownloads(app as never, {
    windows: { findTab: (contents) => tabs.has(contents) ? { window: {} as never, tabId: 't' } : null },
    downloads: { track, discardHeldFiles },
    defaultSession: defaultSession as unknown as Session,
    discardHeldAtQuit
  })
  const create = (type: string, session: FakeSession, isTab: boolean): WebContents => {
    const contents = { getType: () => type, session, isDestroyed: () => false } as unknown as WebContents
    if (isTab) tabs.add(contents)
    app.emit('web-contents-created', {}, contents)
    return contents
  }
  return { app, defaultSession, track, create, discardHeldFiles }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('installDownloads', () => {
  it('deletes the files a hold left as a private session ends, and does nothing at quit in an ordinary one', () => {
    const private_ = setup(true)
    private_.app.emit('before-quit', {})
    expect(private_.discardHeldFiles).toHaveBeenCalledTimes(1)
    const ordinary = setup(false)
    ordinary.app.emit('before-quit', {})
    expect(ordinary.discardHeldFiles).not.toHaveBeenCalled()
  })

  it('handles the default session from the start, handing over the item, the tab and the event', () => {
    const { defaultSession, track } = setup()
    const event = { preventDefault: vi.fn() }
    const item = {} as DownloadItem
    const contents = {} as WebContents
    defaultSession.emit('will-download', event, item, contents)
    expect(track).toHaveBeenCalledWith(item, contents, event)
  })

  it('handles the session of a tab once it is registered as one, and only once', () => {
    const { track, create } = setup()
    const appSession = new FakeSession()
    create('window', appSession, true)
    create('window', appSession, true)
    vi.runAllTimers()
    expect(appSession.listenerCount('will-download')).toBe(1)
    appSession.emit('will-download', {}, {}, undefined)
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('leaves the session of a page that is not a tab to its own handler', () => {
    const { create } = setup()
    const hostSession = new FakeSession()
    create('window', hostSession, false)
    create('webview', hostSession, true)
    vi.runAllTimers()
    expect(hostSession.listenerCount('will-download')).toBe(0)
  })

  it('does not add a second handler to the default session', () => {
    const { defaultSession, create } = setup()
    create('window', defaultSession, true)
    vi.runAllTimers()
    expect(defaultSession.listenerCount('will-download')).toBe(1)
  })

  it('refuses a download the service could not take, so none waits for ever', () => {
    const { defaultSession, track } = setup()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    track.mockImplementation(() => { throw new Error('boom') })
    const event = { preventDefault: vi.fn() }
    defaultSession.emit('will-download', event, {}, undefined)
    expect(event.preventDefault).toHaveBeenCalled()
    error.mockRestore()
  })
})
