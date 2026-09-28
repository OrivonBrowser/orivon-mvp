// The `WebContentsView` lifecycle every toolbar popup in this chrome shares
// -- sizing, click-away dismissal, content-height resizing -- extracted
// once a second popup (../permissions/site-info-panel.js, the site-info
// popover) needed the exact same mechanism ./permissions-panel.ts already
// had (code-guidelines.md Rule 3). Neither caller's own domain (grant rows,
// site info) belongs here; this file only ever moves a rectangle of
// somebody else's web content around.
//
// WHY A SEPARATE VIEW, NOT A REGION OF THE CHROME VIEW: the chrome view is
// exactly CHROME_HEIGHT tall (window.ts) and growing it to hold a popup
// would need window-level transparency to avoid painting an opaque band
// over the page -- and Electron only honours a transparent View inside a
// `transparent: true` window, which the shell's is not, by design. A
// separate view sized to the popup needs none of that.

import { WebContentsView, type BaseWindow, type View, type WebContents } from 'electron'
import { join } from 'node:path'
import { rendererEntryUrl } from '../shell/renderer-entry.js'
import { lockNavigation } from '../shell/lock-navigation.js'

const WIDTH = 380
const MAX_HEIGHT = 460
/** Until the page reports its real content height, and a floor under it --
 * a popup that opens as a 24px sliver while the list loads reads as broken. */
const INITIAL_HEIGHT = 180
const MIN_HEIGHT = 120
/** Gap under the toolbar icon, and the smallest margin kept to the window
 * edges so the popup never sits flush against them. */
const GAP = 6
const EDGE = 8
const CORNER_RADIUS = 10

/**
 * Blur closes this popup on the SAME mousedown that a re-click on its own
 * toolbar icon uses to ask for it again -- the click's IPC message arrives
 * at main only after that blur has already run. Without a debounce, a
 * second click meant to CLOSE an open popup instead closes it and
 * immediately reopens it. A toggle request landing within this window of
 * our own close is read as that echo, not as fresh intent.
 */
const REOPEN_DEBOUNCE_MS = 300

/** Where a popup's toolbar icon is, in the chrome view's own client
 * coordinates. The chrome view is pinned at 0,0 with the window's full
 * width (window.ts's layoutChrome), so these are also window-content
 * coordinates -- no translation, and nothing here needs to know how tall
 * the chrome currently is. */
export interface PopoverAnchor {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type PopoverAlign = 'left' | 'right'

export interface PopoverSpec {
  /** The calling module's own `import.meta.dirname` -- `rendererEntryUrl`'s own parameter, unchanged. */
  readonly dirname: string
  /** electron-vite dev-server subpath, e.g. `/settings/`. */
  readonly entryPath: string
  /** Built-output path relative to `dirname`, e.g. `../renderer/settings/index.html`. */
  readonly fallbackHtml: string
  /** Preload script path relative to `dirname`, e.g. `../preload/settings.js`. */
  readonly preloadRelPath: string
  /** The `--orivon-<name>-url` flag this popup's own preload gates on -- see e.g. `../../preload/settings.ts`. */
  readonly urlArgName: string
  /** `'right'` hangs the popup off its icon's right edge (the all-sites list, near the window's right edge); `'left'` off its left edge (the site-info popup, near the window's left edge). */
  readonly align: PopoverAlign
  /**
   * Registers whatever `SETTINGS_COMMAND_CHANNEL`-shaped IPC this popup
   * owns for its (freshly created) `webContents`, wired to resize via
   * `onContentHeight`. Returns the teardown `close()` runs -- typically
   * `ipcMain.removeHandler`. Called once per `open()`, matching the
   * channel's own once-per-open lifecycle (`ipcMain.handle` throws if
   * registered twice).
   */
  readonly registerIpc: (webContents: WebContents, onContentHeight: (height: number) => void) => () => void
}

export interface PopoverView {
  /** `extraArgs` are appended after the url argument verbatim, e.g. `--orivon-focus-origin=...` or `--orivon-site-info-page=web3`. */
  toggle: (anchor: PopoverAnchor, extraArgs: readonly string[]) => void
  close: () => void
  isOpen: () => boolean
}

function popoverBounds (win: BaseWindow, anchor: PopoverAnchor, align: PopoverAlign, contentHeight: number): Electron.Rectangle {
  const { width: winWidth, height: winHeight } = win.getContentBounds()

  const preferredX = align === 'right' ? anchor.x + anchor.width - WIDTH : anchor.x
  const x = Math.round(Math.min(Math.max(preferredX, EDGE), Math.max(EDGE, winWidth - WIDTH - EDGE)))
  const y = Math.round(anchor.y + anchor.height + GAP)

  // Sized to its content, then bounded twice: by MAX_HEIGHT so a long list
  // does not become a full-height slab, and by the room actually left below
  // the toolbar so it is never cut off by the window edge. Past either, the
  // list scrolls inside the popup.
  const room = winHeight - y - EDGE
  const height = Math.round(Math.max(MIN_HEIGHT, Math.min(contentHeight, MAX_HEIGHT, room)))
  return { x, y, width: Math.min(WIDTH, winWidth - EDGE * 2), height }
}

export function createPopoverView (win: BaseWindow, contentView: View, spec: PopoverSpec): PopoverView {
  let view: WebContentsView | null = null
  let removeIpc: (() => void) | null = null
  let lastClosedAt = 0

  function close (): void {
    if (view === null) return
    const closing = view
    const closingIpc = removeIpc
    // Cleared BEFORE the teardown below, not after: closing the webContents
    // can fire its own 'blur' synchronously, which re-enters this function.
    // Without this the second pass would remove an already-removed child and
    // call close() on a destroyed webContents, and an uncaught throw in a
    // main-process callback takes the whole browser down (the same failure
    // class tabs.ts's own 'destroyed' guard exists for).
    view = null
    removeIpc = null
    lastClosedAt = Date.now()
    closingIpc?.()
    contentView.removeChildView(closing)
    if (!closing.webContents.isDestroyed()) closing.webContents.close()
  }

  function open (anchor: PopoverAnchor, extraArgs: readonly string[]): void {
    const url = rendererEntryUrl(spec.dirname, process.env['ELECTRON_RENDERER_URL'], spec.entryPath, spec.fallbackHtml)

    const popup = new WebContentsView({
      webPreferences: {
        preload: join(spec.dirname, spec.preloadRelPath),
        additionalArguments: [`--${spec.urlArgName}=${url}`, ...extraArgs],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    view = popup
    // The popup's preload (`spec.preloadRelPath`) is privileged in exactly
    // the chrome view's own way, gated on the identical `location.href ===
    // expectedUrl` pattern -- a view holding it must never end up attached
    // to a document other than `url`. Registered before the load, matching
    // the chrome view's own ordering (main/shell/window.ts): `loadURL`
    // never fires `will-navigate` for itself, so this blocks nothing this
    // function is about to do on purpose.
    lockNavigation(popup.webContents, url)

    // Added last, so it renders above the active tab's view. Tab switches
    // and clicks into the page both blur this webContents, which closes the
    // popup below -- so it can never be left stranded under a view that was
    // attached after it.
    contentView.addChildView(popup)
    popup.setBorderRadius(CORNER_RADIUS)
    popup.setBounds(popoverBounds(win, anchor, spec.align, INITIAL_HEIGHT))

    removeIpc = spec.registerIpc(popup.webContents, (contentHeight) => {
      // Guarded on `view === popup`: a height reported by a popup that has
      // already been dismissed must not resize the one that replaced it.
      if (view !== popup || popup.webContents.isDestroyed()) return
      popup.setBounds(popoverBounds(win, anchor, spec.align, contentHeight))
    })
    void popup.webContents.loadURL(url)

    // Click-away dismissal, the one behaviour that makes this feel like a
    // toolbar popup rather than a stuck overlay. Focus is taken explicitly
    // once the page is ready: a view that never held focus can never blur,
    // and the popup would then stay open forever.
    popup.webContents.once('did-finish-load', () => {
      if (view === popup && !popup.webContents.isDestroyed()) popup.webContents.focus()
    })
    popup.webContents.on('blur', () => { if (view === popup) close() })
  }

  return {
    toggle (anchor, extraArgs) {
      if (view !== null) { close(); return }
      // See REOPEN_DEBOUNCE_MS's own doc: a toggle arriving just after our
      // own blur-triggered close is that close's echo, not fresh intent.
      if (Date.now() - lastClosedAt < REOPEN_DEBOUNCE_MS) return
      open(anchor, extraArgs)
    },
    close,
    isOpen: () => view !== null
  }
}
