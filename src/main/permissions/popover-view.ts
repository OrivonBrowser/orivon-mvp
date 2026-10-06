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

import { app, WebContentsView, type BaseWindow, type View, type WebContents } from 'electron'
import { join } from 'node:path'
import { attachShown } from '../shell/attach-view.js'
import { rendererEntryUrl, validatedDevServerUrl } from '../shell/renderer-entry.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import { isEchoOfClose } from '../shell/press-stamps.js'
import { SHELL_PARTITION } from '../shell/shell-session.js'
import type { ShellEntry } from '../shell/shell-session.js'
import { onThemeUpdated, resolveThemeColor } from '../shell/theme-colors.js'
import type { ThemeColorPair } from '../shell/theme-colors.js'
import { recordPopoverShown, recordViewBackground } from '../shell/view-background-test-hook.js'

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
  /** The calling module's own `import.meta.dirname`, which `preloadRelPath` is relative to. */
  readonly dirname: string
  /** electron-vite dev-server subpath, e.g. `/settings/`. */
  readonly entryPath: string
  /** The renderer entry this popup loads when built. */
  readonly entry: ShellEntry
  /** Preload script path relative to `dirname`, e.g. `../preload/permissions.js`. */
  readonly preloadRelPath: string
  /** The `--orivon-<name>-url` flag this popup's own preload gates on -- see e.g. `../../preload/permissions.ts`. */
  readonly urlArgName: string
  /** `'right'` hangs the popup off its icon's right edge (the all-sites list, near the window's right edge); `'left'` off its left edge (the site-info popup, near the window's left edge). */
  readonly align: PopoverAlign
  /**
   * Registers whatever `PERMISSIONS_COMMAND_CHANNEL`-shaped IPC this popup
   * owns for its `webContents`, wired to resize via `onContentHeight`.
   * `url` is the exact address this popup was loaded at (`lockNavigation`
   * already refuses any other), so the registered handler can check it the
   * same way `../ipc/ipc.ts`'s own `isFromChrome` checks the chrome view's
   * URL alongside its identity. Returns the teardown `close()` runs when the
   * popup is actually destroyed -- typically `ipcMain.removeHandler`. Called
   * once per fresh `WebContentsView` (once ever for a `warm` popup, once per
   * open otherwise), matching the channel's own lifecycle (`ipcMain.handle`
   * throws if registered twice).
   */
  readonly registerIpc: (webContents: WebContents, url: string, onContentHeight: (height: number) => void) => () => void
  /** The largest this popup may grow to before its own content scrolls,
   * independent of `room` below (which still applies on top of this): a
   * fixed cap for a popup whose list can run long (permissions, site-info),
   * or `Number.POSITIVE_INFINITY` for one that should simply show all of its
   * content, so only the window's own height ever makes it scroll. Defaults to `MAX_HEIGHT`, the fixed cap a popup that does not set this field gets. */
  readonly maxHeight?: number
  /** This popup's own `--wbg` token, literally, both themes -- what the view
   * is painted BEFORE its own page has loaded that CSS, so nothing white
   * shows in the gap (a freshly created `WebContentsView` defaults to an
   * opaque white). Resolved against the live `nativeTheme` at construction,
   * and again on every OS/app theme change while a `warm` popup's view stays
   * alive past that change (see `warm`'s own doc). */
  readonly background: ThemeColorPair
  /**
   * Keeps ONE `WebContentsView` for this popup's whole window lifetime
   * instead of building and destroying one on every open: `toggle()` only
   * attaches/detaches it, never re-navigates it. Only safe for a popup whose
   * content takes no per-open argument (`extraArgs` below is ignored for a
   * `warm` popup's own construction, since a warm view is built once, before
   * any `toggle()` call ever supplies one). Permissions and site-info both
   * need a different origin's data on each open and stay on the ordinary
   * create/destroy path.
   * NOT built at construction: every window would otherwise carry a hidden
   * renderer process nobody may ever open (`npm run smoke`'s own two-window
   * count, and every e2e launch, measures exactly this). `prewarm()` on the
   * returned `PopoverView` builds it on demand instead -- the caller decides
   * when that is worth doing (say, a toolbar button's own hover/focus). A `toggle()` reaching a still-unbuilt warm popup builds it then,
   * the same as any other click. `onShow` is how a warm popup's own page is
   * told to refresh, since its document is never reloaded.
   */
  readonly warm?: boolean
  /** Called every time the popup becomes visible, warm or not, after it is
   * attached and sized -- a warm popup's page is never reloaded, so this is
   * the only way to tell it to re-fetch and reset its own state (scroll
   * position, keyboard focus) on each open, the way a fresh popup's own
   * first load already does simply by starting over. */
  readonly onShow?: (webContents: WebContents) => void
  /** The tab in front. A popup that closes while it holds the keyboard hands it back here, so the next key press (Ctrl+F) reaches a view that handles it. Never read from `getFocusedWebContents()`, which can touch a torn-down view. */
  readonly activeContents?: () => WebContents | undefined
}

export interface PopoverView {
  /** `extraArgs` are appended after the url argument verbatim, e.g. `--orivon-focus-origin=...` or `--orivon-site-info-page=web3`. Ignored by a `warm` popup, which takes no per-open argument.
   * `key` names the toolbar icon asking: while the popup shows, another key swaps to that icon's content; just after a blur close, only the key that was showing is read as an echo.
   * `pressedAt` is the time, on main's clock, of the press this click completes (see ../shell/press-stamps.ts); a click without one is judged by the clock alone. */
  toggle: (anchor: PopoverAnchor, extraArgs: readonly string[], key?: string, pressedAt?: number) => void
  close: () => void
  isOpen: () => boolean
  /** Builds a `warm` popup's view now, if it is not already built -- a no-op
   * for a non-`warm` popup (nothing to build ahead of an open it always pays
   * for) and a no-op if already built. Idempotent: safe to call from a hover
   * handler that can fire more than once. */
  prewarm: () => void
  /** Moves an open popup back above every other child of the window, where a later `addChildView` of a sibling left it under. */
  restack: () => void
}

/** Exported for its own unit tests (popover-view.test.ts): pure geometry, no view or IPC involved. */
export function popoverBounds (win: BaseWindow, anchor: PopoverAnchor, align: PopoverAlign, contentHeight: number, maxHeight: number): Electron.Rectangle {
  const { width: winWidth, height: winHeight } = win.getContentBounds()

  const preferredX = align === 'right' ? anchor.x + anchor.width - WIDTH : anchor.x
  const x = Math.round(Math.min(Math.max(preferredX, EDGE), Math.max(EDGE, winWidth - WIDTH - EDGE)))
  const y = Math.round(anchor.y + anchor.height + GAP)

  // Sized to its content, then bounded twice: by the popup's own maxHeight
  // (a fixed cap for one whose list can run long, or unbounded for one that
  // should simply show everything), and by the room actually left below the
  // toolbar so it is never cut off by the window edge. Past either, the
  // list scrolls inside the popup.
  const room = winHeight - y - EDGE
  const height = Math.round(Math.max(MIN_HEIGHT, Math.min(contentHeight, maxHeight, room)))
  return { x, y, width: Math.min(WIDTH, winWidth - EDGE * 2), height }
}

export function createPopoverView (win: BaseWindow, contentView: View, spec: PopoverSpec): PopoverView {
  const maxHeight = spec.maxHeight ?? MAX_HEIGHT

  /** The view currently attached to `contentView`, or null while hidden/closed. */
  let shown: WebContentsView | null = null
  /** What `shown` held when it was shown. A view whose contents were destroyed answers `webContents` with nothing, so the close path reads these instead. */
  let shownContents: WebContents | null = null
  let shownContentsId = 0
  /** Popups this module closed itself, whose `destroyed` event follows. */
  const closedHere = new WeakSet<WebContentsView>()
  /** Set only for a `warm` popup: the one view built for this window's whole
   * lifetime, kept even while `shown` is null. */
  let warmView: WebContentsView | null = null
  /** This popup's own toolbar-icon position, as of the last `show()` -- read
   * by the content-height resize callback below, which a `warm` popup
   * registers once but must still size against whichever anchor the CURRENT
   * show used, not the one its view happened to be built under. */
  let currentAnchor: PopoverAnchor | null = null
  let removeIpc: (() => void) | null = null
  let lastClosedAt = 0
  /** Which icon the showing popup was opened by, and which one the last close was of. */
  let shownKey = ''
  let lastClosedKey = ''

  /** A view's contents, or undefined once they were destroyed (the view then answers `webContents` with nothing, whatever its type says). */
  function contentsOf (view: WebContentsView): WebContents | undefined {
    const contents = view.webContents as WebContents | undefined
    return contents === undefined || contents.isDestroyed() ? undefined : contents
  }

  function currentBackground (): string {
    return resolveThemeColor(spec.background)
  }

  /** Builds one `WebContentsView`, loads it, and wires everything that does
   * not depend on whether it is shown yet: background, navigation lockdown,
   * the command channel, and the blur-closes-it behaviour. Shared by a fresh
   * (non-`warm`) open and a `warm` popup's own one-time construction. */
  function construct (extraArgs: readonly string[]): WebContentsView {
    const url = rendererEntryUrl(validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']), spec.entryPath, spec.entry)

    const popup = new WebContentsView({
      webPreferences: {
        preload: join(spec.dirname, spec.preloadRelPath),
        partition: SHELL_PARTITION,
        additionalArguments: [`--${spec.urlArgName}=${url}`, ...extraArgs],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    // Set BEFORE this view is ever attached, so the first frame Electron
    // composites for it is already this popup's own theme colour, not the
    // default opaque white a fresh WebContentsView otherwise shows for
    // however long the page takes to load its own `background: var(--wbg)`.
    const color = currentBackground()
    popup.setBackgroundColor(color)
    recordViewBackground(popup.webContents.id, color)
    // The popup's preload (`spec.preloadRelPath`) is privileged in exactly
    // the chrome view's own way, gated on the identical `location.href ===
    // expectedUrl` pattern -- a view holding it must never end up attached
    // to a document other than `url`. Locked before the load, as every
    // caller does (lock-navigation.ts says why that is safe).
    lockNavigation(popup.webContents, url)
    popup.setBorderRadius(CORNER_RADIUS)

    removeIpc = spec.registerIpc(popup.webContents, url, (contentHeight) => {
      // Guarded on `shown === popup`: a height reported by a popup that is
      // hidden (or, for a non-warm popup, already destroyed) must not resize
      // whatever replaced it. `currentAnchor` is null exactly when `shown` is,
      // so the second check only matters for the type-checker.
      if (shown !== popup || currentAnchor === null || contentsOf(popup) === undefined) return
      popup.setBounds(popoverBounds(win, currentAnchor, spec.align, contentHeight, maxHeight))
    })
    // Click-away dismissal, the one behaviour that makes this feel like a
    // toolbar popup rather than a stuck overlay.
    popup.webContents.on('blur', () => { if (shown === popup) hide() })
    // A popup whose page is gone (crashed, or its contents destroyed) leaves the window the same way a click away does,
    // so the person's next click on its icon opens a new one instead of closing the dead one.
    const gone = (): void => {
      const wasShown = shown === popup
      // The popup held the keyboard, and its page is gone before it can hand it back.
      if (wasShown) hide(true)
      // Not the echo of a click away: the next click on the icon is a request to open. A popup this module closed itself is that echo.
      if (wasShown || !closedHere.has(popup)) lastClosedAt = 0
      if (warmView === popup) {
        warmView = null
        removeIpc?.()
        removeIpc = null
        closedHere.add(popup)
        contentsOf(popup)?.close()
      }
    }
    popup.webContents.on('render-process-gone', gone)
    popup.webContents.once('destroyed', gone)
    void popup.webContents.loadURL(url)
    return popup
  }

  function ensureWarmView (): WebContentsView {
    if (warmView === null || contentsOf(warmView) === undefined) warmView = construct([])
    return warmView
  }

  function show (anchor: PopoverAnchor, extraArgs: readonly string[], key: string): void {
    const popup = spec.warm === true ? ensureWarmView() : construct(extraArgs)
    currentAnchor = anchor
    shown = popup
    shownContents = popup.webContents
    shownContentsId = popup.webContents.id
    shownKey = key
    // Added last, so it renders above the active tab's view. Tab switches
    // and clicks into the page both blur this webContents, which hides the
    // popup below -- so it can never be left stranded under a view that was
    // attached after it.
    attachShown(contentView, popup)
    popup.setBounds(popoverBounds(win, anchor, spec.align, INITIAL_HEIGHT, maxHeight))
    recordPopoverShown(popup.webContents.id, true)
    spec.onShow?.(popup.webContents)
    if (popup.webContents.isDestroyed()) return
    // Focus is taken explicitly: a view that never held focus can never
    // blur, and the popup would then stay open forever. A `warm` popup past
    // its first show has already finished loading and can be focused at
    // once; a popup still loading (every non-warm open, and a warm popup's
    // very first show) is focused once its page is actually ready to take it.
    if (popup.webContents.isLoading()) {
      popup.webContents.once('did-finish-load', () => {
        if (shown === popup) contentsOf(popup)?.focus()
      })
    } else {
      popup.webContents.focus()
    }
  }

  /** `focusTabAfter`: the popup's page is gone, so it cannot be asked whether it held the keyboard. */
  function hide (focusTabAfter = false): void {
    if (shown === null) return
    const popup = shown
    const contents = shownContents
    const id = shownContentsId
    shown = null
    shownContents = null
    currentAnchor = null
    lastClosedAt = Date.now()
    lastClosedKey = shownKey
    const alive = contents !== null && !contents.isDestroyed()
    // Read before the view leaves: a blur close finds it already false, and focus then stays where the person put it.
    const hadFocus = focusTabAfter || (alive && contents.isFocused())
    // A throw here (a window being disposed) must not skip the cleanup below nor reach the caller.
    try {
      contentView.removeChildView(popup)
    } catch (error) {
      console.error('[popover] detaching the popup failed', error)
    }
    recordPopoverShown(id, false)
    // A `warm` popup's view survives being hidden -- only the window closing
    // (below) ever destroys it.
    if (spec.warm !== true) {
      removeIpc?.()
      removeIpc = null
      if (alive && !contents.isDestroyed()) {
        closedHere.add(popup)
        contents.close()
      }
    }
    if (hadFocus) {
      const tab = spec.activeContents?.()
      if (tab !== undefined && !tab.isDestroyed()) tab.focus()
    }
  }

  if (spec.warm === true) {
    // A `warm` view lives past any number of OS/app theme changes; a
    // non-warm popup instead picks up the current theme fresh on every
    // `construct()` call, so it needs no listener of its own here.
    // Registered through theme-colors.ts's `onThemeUpdated`, not a
    // `nativeTheme.on('updated', ...)` of its own -- see window.ts's own
    // comment on the same call for why (one process-wide EventEmitter, one
    // direct listener per window/popover otherwise).
    const applyBackgroundForTheme = (): void => {
      if (warmView === null || contentsOf(warmView) === undefined) return
      const color = currentBackground()
      warmView.setBackgroundColor(color)
      recordViewBackground(warmView.webContents.id, color)
    }
    const unregisterThemeListener = onThemeUpdated(applyBackgroundForTheme)
    win.on('closed', () => {
      unregisterThemeListener()
      removeIpc?.()
      if (warmView !== null) contentsOf(warmView)?.close()
    })
  }

  return {
    toggle (anchor, extraArgs, key = '', pressedAt) {
      if (shown !== null) {
        const sameIcon = shownKey === key
        hide()
        if (!sameIcon) show(anchor, extraArgs, key)
        return
      }
      // See isEchoOfClose's own doc: a toggle arriving just after our
      // own blur-triggered hide is that hide's echo, not fresh intent -- when
      // it is the same icon. Another icon's click is fresh intent.
      if (key === lastClosedKey && isEchoOfClose(lastClosedAt, pressedAt, Date.now())) return
      show(anchor, extraArgs, key)
    },
    close: () => { hide() },
    isOpen: () => shown !== null,
    prewarm () { if (spec.warm === true) ensureWarmView() },
    restack () { if (shown !== null && contentsOf(shown) !== undefined) attachShown(contentView, shown) }
  }
}
