import { describe, expect, it, vi } from 'vitest'
import { createExtensionPageRecovery, type ReloadablePage } from '../extension-pages-reload.js'
import { createExtensionOpenedPages, type ExtensionOpenedPages, type TrackablePage } from '../extension-opened-pages.js'
import { watchForMissedServiceWorkerPreload } from '../extension-sw-preload-recovery.js'
import { EXTENSION_SW_HEALTH_REPLY_CHANNEL } from '../../channels.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function page (url: string, destroyed = false): ReloadablePage & { loadURL: ReturnType<typeof vi.fn>, getURL: () => string } {
  return { isDestroyed: () => destroyed, getURL: () => url, loadURL: vi.fn(async () => undefined) }
}

const WELCOME = `chrome-extension://${ID}/welcome.html`
const ERR_FAILED = -2
const ERR_ABORTED = -3
const ERR_BLOCKED_BY_CLIENT = -20

function recovery (now: () => number = () => 0, isEligible: (p: ReloadablePage, id: string) => boolean = () => true) {
  return createExtensionPageRecovery({ now, graceMs: 1000, isEligible })
}

describe('createExtensionPageRecovery: the pages that exist once the extension is loaded again', () => {
  it('navigates every live page of the extension to its own URL again, and nothing else', () => {
    const welcome = page(`chrome-extension://${ID}/welcome.html`)
    const popup = page(`chrome-extension://${ID}/popup.html#tab`)
    const foreign = page(`chrome-extension://${OTHER}/welcome.html`)
    const web = page('https://example.com/')
    const gone = page(`chrome-extension://${ID}/gone.html`, true)

    expect(recovery().sweep(ID, [welcome, popup, foreign, web, gone])).toBe(2)

    expect(welcome.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/welcome.html`)
    expect(popup.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/popup.html#tab`)
    for (const untouched of [foreign, web, gone]) expect(untouched.loadURL).not.toHaveBeenCalled()
  })

  it('leaves a page that is not eligible alone, such as the hidden offscreen document', () => {
    const offscreen = page(`chrome-extension://${ID}/offscreen.html`)
    const tab = page(WELCOME)

    expect(recovery(() => 0, (candidate) => candidate !== offscreen).sweep(ID, [offscreen, tab])).toBe(1)

    expect(offscreen.loadURL).not.toHaveBeenCalled()
    expect(tab.loadURL).toHaveBeenCalledOnce()
  })

  it('logs a page that cannot be reloaded and still reloads the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stuck = page(`chrome-extension://${ID}/a.html`)
    stuck.loadURL.mockRejectedValue(new Error('ERR_FAILED'))
    const fine = page(`chrome-extension://${ID}/b.html`)

    expect(recovery().sweep(ID, [stuck, fine])).toBe(2)
    await new Promise((resolve) => setImmediate(resolve))

    expect(fine.loadURL).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not reload'), expect.any(Error))
    errorSpy.mockRestore()
  })
})

describe('createExtensionPageRecovery: a page whose load fails around the reload', () => {
  it('navigates a page whose load failed after the reload ended, though it held no URL when the reload ended', () => {
    let time = 0
    const recover = recovery(() => time)
    const welcome = page('')
    recover.begin(ID)
    expect(recover.sweep(ID, [welcome])).toBe(0)
    recover.end(ID)
    time = 64

    welcome.getURL = () => WELCOME
    recover.pageFailed(welcome, WELCOME, ERR_FAILED)

    expect(welcome.loadURL).toHaveBeenCalledExactlyOnceWith(WELCOME)
  })

  it('holds a load that failed while the extension was removed until it is loaded again', () => {
    const recover = recovery()
    const welcome = page(WELCOME)
    recover.begin(ID)

    recover.pageFailed(welcome, WELCOME, ERR_FAILED)
    expect(welcome.loadURL).not.toHaveBeenCalled()

    recover.end(ID)
    expect(welcome.loadURL).toHaveBeenCalledExactlyOnceWith(WELCOME)
  })

  it('navigates a page once per reload, whether it is swept, held or reported again', () => {
    const recover = recovery()
    const welcome = page(WELCOME)
    recover.begin(ID)
    recover.pageFailed(welcome, WELCOME, ERR_FAILED)
    recover.sweep(ID, [welcome])
    recover.end(ID)
    recover.pageFailed(welcome, WELCOME, ERR_FAILED)

    expect(welcome.loadURL).toHaveBeenCalledOnce()
  })

  it('ignores a failure long after the reload, an aborted load, another extension and a page that is gone', () => {
    let time = 0
    const recover = recovery(() => time)
    const late = page(WELCOME)
    const aborted = page(WELCOME)
    const foreign = page(`chrome-extension://${OTHER}/welcome.html`)
    const gone = page(WELCOME, true)
    recover.begin(ID)
    recover.end(ID)

    recover.pageFailed(aborted, WELCOME, ERR_ABORTED)
    recover.pageFailed(foreign, foreign.getURL(), ERR_FAILED)
    recover.pageFailed(gone, WELCOME, ERR_FAILED)
    time = 1001
    recover.pageFailed(late, WELCOME, ERR_FAILED)

    for (const untouched of [late, aborted, foreign, gone]) expect(untouched.loadURL).not.toHaveBeenCalled()
  })

  it('never navigates a page when no reload is under way', () => {
    const welcome = page(WELCOME)
    recovery().pageFailed(welcome, WELCOME, ERR_FAILED)
    expect(welcome.loadURL).not.toHaveBeenCalled()
  })
})

describe('watchForMissedServiceWorkerPreload: pages opened around the recovery', () => {
  it('tells the caller once the extension has been reloaded', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handlers: Array<(event: { runningStatus: string, versionId: number }) => void> = []
    let reply: ((event: unknown, ok: boolean) => void) | undefined
    const worker = {
      scope: `chrome-extension://${ID}/background.js`,
      send: vi.fn(),
      ipc: { once: vi.fn((channel: string, fn: (event: unknown, ok: boolean) => void) => { if (channel === EXTENSION_SW_HEALTH_REPLY_CHANNEL) reply = fn }) }
    }
    const session = {
      extensions: { getExtension: vi.fn(() => ({ path: '/ext' })), removeExtension: vi.fn(), loadExtension: vi.fn(async () => undefined) },
      serviceWorkers: {
        on: vi.fn((name: string, fn: (event: { runningStatus: string, versionId: number }) => void) => { if (name === 'running-status-changed') handlers.push(fn) }),
        getWorkerFromVersionID: vi.fn(() => worker)
      }
    } as unknown as Parameters<typeof watchForMissedServiceWorkerPreload>[0]
    const reloaded = vi.fn()

    watchForMissedServiceWorkerPreload(session, undefined, reloaded)
    handlers[0]?.({ runningStatus: 'running', versionId: 1 })
    reply?.(undefined, false)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(reloaded).toHaveBeenCalledExactlyOnceWith(ID)
    errorSpy.mockRestore()
  })
})

describe('extension pages the host opened: only those are navigated again', () => {
  type Details = { url: string, isMainFrame: boolean, isSameDocument: boolean }
  type Tracked = ReloadablePage & TrackablePage & { loadURL: ReturnType<typeof vi.fn>, emit: (url: string, isMainFrame?: boolean, isSameDocument?: boolean) => void }

  function tracked (): Tracked {
    const listeners: Array<(details: Details) => void> = []
    return Object.assign(page(WELCOME), {
      on: (_event: 'did-start-navigation', listener: (details: Details) => void) => { listeners.push(listener) },
      emit: (url: string, isMainFrame = true, isSameDocument = false) => { for (const l of listeners) l({ url, isMainFrame, isSameDocument }) }
    })
  }

  function trackedRecovery (opened: ExtensionOpenedPages<Tracked>) {
    return createExtensionPageRecovery({ now: () => 0, graceMs: 1000, isEligible: (p, id) => opened.isOpenedBy(p as Tracked, id) })
  }

  it('never reloads a web page that sits on the extension URL its own navigation was refused', () => {
    const opened = createExtensionOpenedPages<Tracked>()
    const hostile = tracked()
    const recover = trackedRecovery(opened)

    recover.begin(ID)
    recover.pageFailed(hostile, WELCOME, ERR_BLOCKED_BY_CLIENT)
    expect(recover.sweep(ID, [hostile])).toBe(0)
    recover.end(ID)
    recover.pageFailed(hostile, WELCOME, ERR_BLOCKED_BY_CLIENT)

    expect(hostile.loadURL).not.toHaveBeenCalled()
  })

  it('still reloads a page the host sent to the extension URL, held or swept', () => {
    const opened = createExtensionOpenedPages<Tracked>()
    const swept = tracked()
    const held = tracked()
    opened.mark(swept, WELCOME)
    opened.mark(held, WELCOME)
    const recover = trackedRecovery(opened)

    expect(recover.sweep(ID, [swept])).toBe(1)
    recover.begin(ID)
    recover.pageFailed(held, WELCOME, ERR_FAILED)
    recover.end(ID)

    expect(swept.loadURL).toHaveBeenCalledExactlyOnceWith(WELCOME)
    expect(held.loadURL).toHaveBeenCalledExactlyOnceWith(WELCOME)
  })

  it('stops counting a page once its main frame leaves the extension, so a web page steered back is not reloaded', () => {
    const opened = createExtensionOpenedPages<Tracked>()
    const tab = tracked()
    opened.mark(tab, WELCOME)

    tab.emit(`chrome-extension://${ID}/other.html`)
    tab.emit('https://evil.example/', false)
    tab.emit(`chrome-extension://${ID}/page.html#x`, true, true)
    expect(opened.isOpenedBy(tab, ID)).toBe(true)

    tab.emit('https://evil.example/')
    expect(opened.isOpenedBy(tab, ID)).toBe(false)
  })

  it('does not count a page for another extension, and ignores a URL that is not an extension page', () => {
    const opened = createExtensionOpenedPages<Tracked>()
    const tab = tracked()
    opened.mark(tab, 'https://example.com/')
    expect(opened.isOpenedBy(tab, ID)).toBe(false)
    opened.mark(tab, WELCOME)
    expect(opened.isOpenedBy(tab, OTHER)).toBe(false)
    tab.emit(`chrome-extension://${OTHER}/x.html`)
    expect(opened.isOpenedBy(tab, ID)).toBe(false)
  })
})
