// Policy for the windows an extension owns that Orivon did not create: the
// browserAction popup and an MV2 background page. Both otherwise get
// Electron's default for `window.open()`, a raw, unpoliced BrowserWindow.
import { app, session } from 'electron'
import type { BaseWindow, WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import type { ShellServices } from '../shell/shell-services.js'
import { extensionOpenedUrl, type IsLoadedExtension } from './extension-url-policy.js'
import { openExtensionTab } from './extension-opened-pages.js'
import { sidePanelWindowOf } from './side-panel-pages.js'

export interface PopupPolicyDeps {
  /** undefined until the first window exists. */
  readonly services: () => ShellServices | undefined
  readonly isLoaded: IsLoadedExtension
}

/** The one open browserAction popup, if any -- browser-action.ts's own
 * activateClick destroys a previous popup before ever creating a second
 * one, so there is never more than one to track. */
let currentPopup: {
  isDestroyed: () => boolean
  destroy: () => void
  readonly parent?: BaseWindow | undefined
  readonly webContents: WebContents
} | undefined

/** The shell window the open popup was opened over, when `contents` is that popup's page. */
export function parentOf (contents: WebContents): BaseWindow | undefined {
  if (currentPopup === undefined || currentPopup.isDestroyed()) return undefined
  return currentPopup.webContents === contents ? currentPopup.parent : undefined
}

/** Chrome closes an open popup the moment the PERSON switches tabs; the
 * caller decides whether a given switch is theirs. */
export function closeCurrentPopup (): void {
  if (currentPopup !== undefined && !currentPopup.isDestroyed()) currentPopup.destroy()
}

/** Routes `window.open()`/`target=_blank` out of an extension popup or
 * MV2 background page through the same URL policy and `openTrusted`
 * chrome.tabs.create uses, instead of letting Electron's own default -- a
 * raw, unpoliced BrowserWindow -- through. Always denies the native window
 * Electron would otherwise open: whatever this opens, it opens itself, as a
 * tracked tab. */
export function setupWindowOpenPolicy (contents: WebContents, deps: PopupPolicyDeps): void {
  contents.setWindowOpenHandler(({ url }) => {
    const services = deps.services()
    if (services !== undefined) {
      // A popup's or a side panel's own page opens its tab beside the window it belongs to; a background page has no window of its own.
      const win = parentOf(contents) ?? sidePanelWindowOf(contents) ?? services.windows.focused()?.window
      const target = extensionOpenedUrl(url, deps.isLoaded)
      const shellWindow = win === undefined ? undefined : services.windows.all().find((w) => w.window === win)
      if (shellWindow !== undefined && target !== undefined) openExtensionTab(shellWindow.tabs, target)
    }
    return { action: 'deny' }
  })
}

/** Gives every popup and MV2 background page the window-open policy above
 * the moment Electron creates it, and closes a popup when the tab it was
 * opened over navigates away. 'browser-action-popup-created' fires
 * synchronously right after the popup's own view is constructed
 * (browser-action.ts's own activateClick), before its page has had a chance
 * to load and call window.open() itself. */
export function installPopupPolicy (host: ElectronChromeExtensions, deps: PopupPolicyDeps): void {
  host.on('browser-action-popup-created', (popup) => {
    setupWindowOpenPolicy(popup.webContents, deps)

    // Chrome closes a popup the moment the tab it was opened over switches
    // or navigates away -- neither is something popup.ts (generic vendored
    // code, ADR-0043) can know about on its own, so it is wired here from
    // the shell's own events instead. `closeCurrentPopup` is the tab-switch
    // half; the active tab's navigation is watched directly, since
    // tabLifecycle has no per-navigation event of its own (tab-lifecycle.ts's
    // own doc: created/activated/closed/view-replaced only).
    currentPopup = popup
    const services = deps.services()
    const shellWindow = popup.parent === undefined || services === undefined
      ? undefined
      : services.windows.all().find((w) => w.window === popup.parent)
    const activeTabWc = shellWindow?.tabs.activeWebContents()
    // Only a real navigation of the tab's OWN top document: an ad iframe
    // reloading, or the page's own history.pushState/replaceState (a
    // same-document navigation, changing nothing the popup was anchored
    // to), must not close it -- Chrome doesn't, and any web page holding
    // an ad iframe or calling pushState could otherwise close a person's
    // still-open password-manager popup out from under them. `.on`, not
    // `.once`: a one-shot listener would already be consumed by the first
    // (filtered-out) subframe/same-document event, silently going deaf to
    // the real navigation that should have closed the popup.
    const closePopup = (details: { isMainFrame: boolean, isSameDocument: boolean }): void => {
      if (!details.isMainFrame || details.isSameDocument) return
      if (!popup.isDestroyed()) popup.destroy()
    }
    activeTabWc?.on('did-start-navigation', closePopup)
    popup.webContents.once('destroyed', () => {
      if (currentPopup === popup) currentPopup = undefined
      activeTabWc?.removeListener('did-start-navigation', closePopup)
    })
  })
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session === session.defaultSession && contents.getType() === 'backgroundPage') {
      setupWindowOpenPolicy(contents, deps)
    }
  })
}
