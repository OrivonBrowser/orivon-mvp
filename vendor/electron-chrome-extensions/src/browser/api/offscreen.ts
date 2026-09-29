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
// Hosted as a BrowserWindow, never shown: a bare, unattached WebContents
// has no public constructor of its own (Electron creates one only by way
// of a BrowserWindow or a WebContentsView attached to one), and a
// WebContentsView never added to any BaseWindow.contentView is exactly as
// unshowable while needing the same BrowserWindow-adjacent plumbing this
// already has, so it is not a smaller surface, only a less familiar one.
// `show: false` and never calling `.show()`/`.showInactive()` anywhere in
// this file is what keeps it off screen; `paintWhenInitiallyHidden`
// defaults to `true` and is left there deliberately -- `false` would stop
// the page rendering (and its getUserMedia/Web Audio graph running) until
// shown, which it never is.
import { BrowserWindow } from 'electron'
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
  win: Electron.BrowserWindow
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
    return entry === undefined || entry.win.isDestroyed() ? undefined : entry.win.webContents
  }

  private async createDocument (
    event: ExtensionEvent,
    parameters: chrome.offscreen.CreateParameters,
  ): Promise<void> {
    const extensionId = event.extension.id
    const existing = this.docs.get(extensionId)
    if (existing !== undefined && !existing.win.isDestroyed()) {
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

    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: this.ctx.session, sandbox: true },
    })
    this.docs.set(extensionId, { win })
    win.on('closed', () => {
      if (this.docs.get(extensionId)?.win === win) this.docs.delete(extensionId)
    })

    try {
      await win.loadURL(url)
    } catch (error) {
      if (!win.isDestroyed()) win.destroy()
      if (this.docs.get(extensionId)?.win === win) this.docs.delete(extensionId)
      throw error
    }
  }

  private async closeDocument (event: ExtensionEvent): Promise<void> {
    this.closeForExtension(event.extension.id)
  }

  private async hasDocument (event: ExtensionEvent): Promise<boolean> {
    const entry = this.docs.get(event.extension.id)
    return entry !== undefined && !entry.win.isDestroyed()
  }

  /** Extension-unloaded (disable/uninstall/crash), `closeDocument()`, or a
   * later caller that needs both to run the same teardown. */
  closeForExtension (extensionId: string): void {
    const entry = this.docs.get(extensionId)
    this.docs.delete(extensionId)
    if (entry !== undefined && !entry.win.isDestroyed()) entry.win.destroy()
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
