// What an extension's popup needs from its window. The popup is a view the library builds and never attaches
// itself (UPSTREAM.md patch 68); this puts it in the window above every other view, places it under the toolbar
// button that opened it, and gives the keyboard back to the page in front when it goes. Tied to Electron: it
// adds and removes real views.
import type { BaseWindow, WebContentsView } from 'electron'
import type { PopupHost } from 'orivon:crx-extensions-browser-action'
import { attachShown } from '../shell/attach-view.js'
import { popupBounds } from './extension-popup-geometry.js'

export interface PopupHostDeps {
  /** Gives the keyboard to the page in front in `window`. */
  readonly focusTab: (window: BaseWindow) => void
  /** True while the shell is moving focus for the popup's own extension, which must not close the popup. */
  readonly keepOpenOnBlur?: (popup: { extensionId: string, parent: BaseWindow }) => boolean
  /** How long that hand-over lasts: the popup takes the keyboard back after it. */
  readonly focusHandoverMs?: number | undefined
}

/** The panel shape the overlay host adopts: lifted above the bars on every restack, and never closed by it. */
export interface ExtensionPopupPanel {
  /** Does nothing: a tab the popup's own extension opens must not close it, and the library closes the popup itself. */
  close: () => void
  isOpen: () => boolean
  restack: () => void
}

export interface ExtensionPopupHost {
  readonly host: PopupHost
  readonly panelFor: (window: BaseWindow) => ExtensionPopupPanel
}

export function createExtensionPopupHost (deps: PopupHostDeps): ExtensionPopupHost {
  const open = new WeakMap<BaseWindow, WebContentsView>()

  const host: PopupHost = {
    ...(deps.keepOpenOnBlur === undefined ? {} : { keepOpenOnBlur: deps.keepOpenOnBlur }),
    // Read when a popup asks, not when the host is built: the shared host is wired later.
    get focusHandoverMs () { return deps.focusHandoverMs },
    mount: (parent, view) => {
      attachShown(parent.contentView, view)
      open.set(parent, view)
    },
    unmount: (parent, view) => {
      // Read before the view leaves: a view out of the window holds no focus to read.
      // A page that closed itself has no `webContents` left to ask.
      const contents = view.webContents as Electron.WebContents | undefined
      const hadKeyboard = contents !== undefined && !contents.isDestroyed() && contents.isFocused()
      if (open.get(parent) === view) open.delete(parent)
      try {
        parent.contentView.removeChildView(view)
      } catch {
        // The window is closing: its views go with it.
        return
      }
      if (hadKeyboard) deps.focusTab(parent)
    },
    place: (parent, view, { anchorRect, alignment, size }) => {
      const { width, height } = parent.getContentBounds()
      view.setBounds(popupBounds({ anchor: anchorRect, alignment, size, content: { width, height } }))
    }
  }

  return {
    host,
    panelFor: (window) => ({
      close: () => {},
      isOpen: () => open.has(window),
      restack: () => {
        const view = open.get(window)
        if (view === undefined) return
        // A page that closed itself leaves its view recorded until the library's own close runs.
        const contents = view.webContents as Electron.WebContents | undefined
        if (contents === undefined || contents.isDestroyed()) { open.delete(window); return }
        attachShown(window.contentView, view)
      }
    })
  }
}

let wired: PopupHostDeps | undefined
const shared = createExtensionPopupHost({
  focusTab: (window) => { wired?.focusTab(window) },
  keepOpenOnBlur: (popup) => wired?.keepOpenOnBlur?.(popup) === true,
  get focusHandoverMs () { return wired?.focusHandoverMs }
})

/** The one host the library's popups use, and the panel a window hands its overlay host (`../shell/window-panels.ts`). */
export const extensionPopupHost: PopupHost = shared.host
export function extensionPopupPanel (window: BaseWindow): ExtensionPopupPanel {
  return shared.panelFor(window)
}

/** Supplies what the shell alone can answer, once it exists. */
export function wirePopupHost (deps: PopupHostDeps): void {
  wired = deps
}
