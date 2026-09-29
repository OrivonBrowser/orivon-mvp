// Orivon patch (UPSTREAM.md, patch 32): chrome.offscreen is absent from
// both Electron and this library -- Volume Master
// (jghecgabfgfdldnmbfkhmffcabddioke) and any other MV3 extension using
// chrome.tabCapture need it to host the getUserMedia() call a capture
// stream id feeds into; Electron's own extensions system has no concept of
// an offscreen document at all.
//
// One document per extension, matching Chrome's own limit -- a second
// createDocument() call while one is open rejects with Chrome's own error
// text (developer.chrome.com/docs/extensions/reference/api/offscreen).
//
// Hosted as a `WebContentsView`, never a `BrowserWindow`. MEASURED
// (docs/planning's tabCapture/offscreen probe): a `WebContentsView`
// constructed and used WITHOUT ever attaching it to any `BaseWindow`'s
// `contentView` still gets this library's own preload injected and
// chrome.runtime messaging works in full (`chrome.runtime.id` reads back
// correctly through it) -- and, unlike a hidden `BrowserWindow`, it never
// appears in `BrowserWindow.getAllWindows()` at all (measured: 0 before, 0
// after creating and loading one). A hidden `BrowserWindow` DOES appear
// there, which is exactly the bug this replaces: `src/main/index.ts` quits
// on `window-all-closed` and recreates a window on macOS `activate` by
// counting real windows, so an offscreen document hosted as a
// `BrowserWindow` kept the whole app resident with no window on screen, and
// blocked `activate` from ever reopening one on macOS.
import { WebContentsView } from 'electron'
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'

/** developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason --
 * an unlisted string is refused the same way an unknown chrome.offscreen
 * reason is refused in real Chrome, rather than silently accepted. */
const OFFSCREEN_REASONS = new Set([
  'TESTING', 'AUDIO_PLAYBACK', 'IFRAME_SCRIPTING', 'DOM_SCRAPING', 'BLOBS',
  'DOM_PARSER', 'USER_MEDIA', 'DISPLAY_MEDIA', 'WEB_RTC', 'CLIPBOARD',
  'LOCAL_STORAGE', 'WORKERS', 'BATTERY_STATUS', 'MATCH_MEDIA', 'GEOLOCATION',
])

interface OffscreenEntry {
  view: Electron.WebContentsView
}

export class OffscreenAPI {
  /** Keyed by extension id -- Chrome allows exactly one offscreen document
   * per extension at a time. */
  private docs = new Map<string, OffscreenEntry>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('offscreen.createDocument', this.createDocument.bind(this), { permission: 'offscreen' })
    handle('offscreen.closeDocument', this.closeDocument.bind(this), { permission: 'offscreen' })
    handle('offscreen.hasDocument', this.hasDocument.bind(this), { permission: 'offscreen' })

    // An offscreen document has no owner but the extension that created
    // it -- Electron's own 'extension-unloaded' (Session.removeExtension,
    // which install-runner.ts's uninstall() and setEnabled(false) both
    // call) is the one signal that reaches every disable/uninstall path at
    // once, with no separate wiring from extension-host.ts needed.
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.addListener('extension-unloaded', (_event, extension) => {
      this.closeForExtension(extension.id)
    })
  }

  /** The requester's own webContents when it hosts the offscreen document,
   * used as `tab-capture.ts`'s `getMediaSourceId()` requester -- Volume
   * Master (and MV3 tabCapture generally) always create the offscreen
   * document before calling `chrome.tabCapture.getMediaStreamId()`, and it
   * is the only page context guaranteed open at that point when the SW
   * itself has no webContents of its own. */
  getDocumentWebContents (extensionId: string): Electron.WebContents | undefined {
    const entry = this.docs.get(extensionId)
    return entry === undefined || entry.view.webContents.isDestroyed() ? undefined : entry.view.webContents
  }

  private async createDocument (
    event: ExtensionEvent,
    parameters: chrome.offscreen.CreateParameters,
  ): Promise<void> {
    const extensionId = event.extension.id
    const existing = this.docs.get(extensionId)
    if (existing !== undefined && !existing.view.webContents.isDestroyed()) {
      throw new Error('Only a single offscreen document may be created.')
    }

    if (!Array.isArray(parameters.reasons) || parameters.reasons.length === 0) {
      throw new Error('reasons is required and must not be empty.')
    }
    const unknown = parameters.reasons.find((reason) => !OFFSCREEN_REASONS.has(reason))
    if (unknown !== undefined) throw new Error(`Invalid reason: ${unknown}`)
    if (typeof parameters.justification !== 'string' || parameters.justification.length === 0) {
      throw new Error('justification is required.')
    }

    const url = resolveOwnPageUrl(extensionId, parameters.url)

    const view = new WebContentsView({
      webPreferences: { session: this.ctx.session, sandbox: true },
    })
    this.docs.set(extensionId, { view })

    // An offscreen document has no tab, no toolbar chrome and no
    // one watching it -- `window.open` from it, left to the library's own
    // default new-window handling, created a raw, frameless,
    // always-on-top `BrowserWindow`; denying it outright is correct
    // because nothing about an offscreen document's own job (hosting a
    // `getUserMedia`/Web Audio graph, a `DOMParser`, ...) ever calls for a
    // second window. Navigation is locked to the extension's own origin
    // for the mirror-image reason: an offscreen document that could
    // navigate itself to an arbitrary URL would let a compromised or
    // malicious extension turn its own hidden, sandboxed, never-shown
    // document into an equally hidden window onto anywhere else on the
    // web.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const ownOriginPrefix = `chrome-extension://${extensionId}/`
    const refuseForeignNavigation = (navigationEvent: Electron.Event, targetUrl: string): void => {
      if (!targetUrl.startsWith(ownOriginPrefix)) navigationEvent.preventDefault()
    }
    view.webContents.on('will-navigate', refuseForeignNavigation)
    view.webContents.on('will-redirect', refuseForeignNavigation)

    // A renderer crash leaves `webContents.isDestroyed()` false --
    // electron.d.ts's own `isCrashed()` getter exists because the
    // WebContents object survives a crash on its own, reloadable in
    // principle -- so without this, a crashed offscreen document would
    // keep `hasDocument`/`getContexts` reporting it present forever, and a
    // fresh `createDocument()` call would keep throwing "Only a single
    // offscreen document may be created." for a document that can no
    // longer do anything. Dropping the map entry alone is enough for both:
    // `getDocumentWebContents`/`hasDocument` key off entry PRESENCE first,
    // and `createDocument`'s own guard reads the same map. MEASURED,
    // deliberately NOT done here: calling `close()` on the crashed
    // webContents to force it destroyed too -- `close()`'s own "as if
    // window.close() had been called" contract (electron.d.ts) waits on a
    // beforeunload round-trip with a renderer that, post-crash, can never
    // answer it; reproduced directly as Chromium's own hung-process
    // watchdog fataling the whole child process. Whatever native resources
    // the crashed webContents still holds are Electron's own to reclaim,
    // the same as any other crashed, never-explicitly-closed webContents
    // elsewhere in this codebase.
    view.webContents.once('render-process-gone', () => {
      if (this.docs.get(extensionId)?.view === view) this.docs.delete(extensionId)
    })
    view.webContents.once('destroyed', () => {
      if (this.docs.get(extensionId)?.view === view) this.docs.delete(extensionId)
    })

    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
      if (this.docs.get(extensionId)?.view === view) this.docs.delete(extensionId)
      throw error
    }
  }

  private async closeDocument (event: ExtensionEvent): Promise<void> {
    this.closeForExtension(event.extension.id)
  }

  private async hasDocument (event: ExtensionEvent): Promise<boolean> {
    const entry = this.docs.get(event.extension.id)
    return entry !== undefined && !entry.view.webContents.isDestroyed()
  }

  /** Extension-unloaded (disable/uninstall/crash), `closeDocument()`, or a
   * later caller that needs both to run the same teardown. */
  closeForExtension (extensionId: string): void {
    const entry = this.docs.get(extensionId)
    this.docs.delete(extensionId)
    if (entry !== undefined && !entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  }
}

/** Refuses anything but the calling extension's own page, the same
 * requirement Chrome documents for `chrome.offscreen.createDocument`'s
 * `url` -- an absolute URL naming a different origin resolves to that
 * origin instead of throwing, so the check is against the RESOLVED result,
 * the same shape `browser-action.ts`'s `getPopupUrl` already uses for
 * `chrome.action.setPopup`. */
function resolveOwnPageUrl (extensionId: string, url: string): string {
  const base = `chrome-extension://${extensionId}/`
  const resolved = new URL(url, base)
  if (resolved.protocol !== 'chrome-extension:' || resolved.hostname !== extensionId) {
    throw new Error('url must be a page of the calling extension.')
  }
  return resolved.toString()
}
