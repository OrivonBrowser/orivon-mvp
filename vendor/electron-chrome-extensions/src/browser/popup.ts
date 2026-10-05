import { EventEmitter } from 'node:events'
import { nativeTheme, WebContentsView } from 'electron'
import type { BaseWindow, Session, WebContents } from 'electron'
import { getAllWindows } from './api/common'
import debug from 'debug'

const d = debug('electron-chrome-extensions:popup')

// Orivon patch (UPSTREAM.md patch 35): the colour a popup paints before the extension's own page
// has a pixel to show; a fixed light colour flashed white on every open in dark mode.
const POPUP_BACKGROUND_LIGHT = '#ffffff'
const POPUP_BACKGROUND_DARK = '#202124'
const POPUP_CORNER_RADIUS = 8

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

/** Where a popup goes: the toolbar rectangle it opens from, which side of it, and its size. */
export interface PopupPlacement {
  anchorRect: PopupAnchorRect
  alignment?: string | undefined
  size: { width: number; height: number }
}

/** Orivon patch (UPSTREAM.md patch 68): the popup is a view inside the window it belongs to, and the
 * embedder owns what that means for the window: how the view is attached, where it sits, what gets
 * the keyboard when it leaves. The library never adds the view itself. */
export interface PopupHost {
  /** Puts the view in `parent`, on top. */
  mount(parent: BaseWindow, view: WebContentsView): void
  /** Takes the view out of `parent`. */
  unmount(parent: BaseWindow, view: WebContentsView): void
  /** Sets the view's bounds, in the window's content coordinates. */
  place(parent: BaseWindow, view: WebContentsView, placement: PopupPlacement): void
  /** True while a loss of focus must not close the popup: the embedder itself is moving focus, for
   * the popup's own extension (a tab it just opened). */
  keepOpenOnBlur?(): boolean
}

const POSITION_PADDING = 5

/** What a library with no embedder does: on top of the window, under the anchor, right edge to right edge. */
const defaultHost: PopupHost = {
  mount: (parent, view) => { parent.contentView.addChildView(view) },
  unmount: (parent, view) => { parent.contentView.removeChildView(view) },
  place: (_parent, view, { anchorRect, alignment, size }) => {
    const x = alignment?.includes('right') ? anchorRect.x : anchorRect.x + anchorRect.width - size.width
    const y = alignment?.includes('top')
      ? anchorRect.y - size.height - POSITION_PADDING
      : anchorRect.y + anchorRect.height + POSITION_PADDING
    view.setBounds({ x: Math.floor(x), y: Math.floor(y), ...size })
  },
}

let gPopupHost: PopupHost = defaultHost

export function setPopupHost(host: PopupHost | undefined): void {
  gPopupHost = host ?? defaultHost
}

// Orivon patch (UPSTREAM.md patch 68): a popup's page has no BrowserWindow of its own, so the window
// it hangs under is recorded here for `chrome.tabs`' notion of the current window (api/tabs.ts).
const popupParents = new WeakMap<WebContents, BaseWindow>()

/** The window the popup whose page is `contents` was opened over. */
export function popupParentOf(contents: WebContents): BaseWindow | undefined {
  return popupParents.get(contents)
}

interface PopupViewOptions {
  extensionId: string
  session: Session
  parent: BaseWindow
  url: string
  anchorRect: PopupAnchorRect
  // Orivon patch: `| undefined` added (exactOptionalPropertyTypes) --
  // browser-action.ts's own activateClick passes `alignment: string |
  // undefined` through unchanged (its own ActivateDetails already allows
  // it), which the bare `?:` form refuses.
  alignment?: string | undefined
}

const supportsPreferredSize = () => {
  const major = parseInt(process.versions.electron.split('.').shift() || '', 10)
  return major >= 12
}

/** Every WebContents anywhere in `win`'s own content-view tree (its
 * toolbar/chrome view, every tab view, any further nesting) -- used only to
 * arm a one-shot 'focus' listener across all of them (closeOnNextAppFocus
 * below), never to address any one of them individually. */
function collectWebContents(win: BaseWindow): WebContents[] {
  const out: WebContents[] = []
  const walk = (view: Electron.View): void => {
    const webContents = (view as unknown as { webContents?: WebContents }).webContents
    if (webContents !== undefined) out.push(webContents)
    for (const child of view.children) walk(child)
  }
  walk(win.contentView)
  return out
}

export class PopupView extends EventEmitter {
  static POSITION_PADDING = POSITION_PADDING

  static BOUNDS = {
    minWidth: 25,
    minHeight: 25,
    maxWidth: 800,
    maxHeight: 600,
  }

  // Orivon patch (UPSTREAM.md patch 35): a reasonable extension-popup size,
  // used only by armVisibilityFallback below -- not a guess at any
  // particular extension's real content size, just large enough that a
  // popup shown this way is usable rather than a 25x25 postage stamp.
  static FALLBACK_BOUNDS = { width: 320, height: 400 }

  // Orivon patch (UPSTREAM.md patch 35): see armVisibilityFallback's own doc.
  static VISIBILITY_FALLBACK_MS = 500

  /** Orivon patch (UPSTREAM.md patch 68): the popup's page, in a view the host puts in `parent`. */
  readonly view: WebContentsView
  readonly webContents: WebContents
  parent?: BaseWindow | undefined
  extensionId: string

  private anchorRect: PopupAnchorRect
  private size = { width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight }
  private destroyed: boolean = false
  private hidden: boolean = true
  private sized: boolean = false
  private alignment?: string | undefined
  private readonly host: PopupHost

  // Orivon patch (UPSTREAM.md patch 34): see closeOnNextAppFocus's own doc.
  private closeOnNextFocusCleanup?: (() => void) | undefined

  /** Preferred size changes are only received in Electron v12+ */
  private usingPreferredSize = supportsPreferredSize()

  private readyPromise: Promise<void>

  constructor(opts: PopupViewOptions) {
    super()

    this.parent = opts.parent
    this.extensionId = opts.extensionId
    this.anchorRect = opts.anchorRect
    this.alignment = opts.alignment
    this.host = gPopupHost

    this.view = new WebContentsView({
      webPreferences: {
        session: opts.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enablePreferredSizeMode: true,
        // Orivon patch 62: no native alert, confirm or prompt box from a popup.
        disableDialogs: true,
      },
    })
    this.view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? POPUP_BACKGROUND_DARK : POPUP_BACKGROUND_LIGHT)
    this.view.setBorderRadius(POPUP_CORNER_RADIUS)
    this.webContents = this.view.webContents
    popupParents.set(this.webContents, opts.parent)

    const untypedWebContents = this.webContents as any
    untypedWebContents.on('preferred-size-changed', this.updatePreferredSize)

    this.webContents.on('devtools-closed', this.maybeClose)
    this.webContents.on('before-input-event', this.onBeforeInput)
    this.webContents.on('blur', this.maybeClose)
    this.webContents.on('destroyed', this.closeSoon)
    this.parent.once('closed', this.closeSoon)
    // Orivon patch (UPSTREAM.md patch 34): Chrome closes an extension
    // popup the moment the window it belongs to is moved, resized or
    // minimised, not only on an outside click -- none of the three
    // touches this popup's OWN bounds (only setSize/updatePosition below
    // do that), so there is no risk of a false positive from the popup
    // positioning itself.
    this.parent.on('move', this.closeSoon)
    this.parent.on('resize', this.closeSoon)
    this.parent.on('minimize', this.closeSoon)

    this.readyPromise = this.load(opts.url)
  }

  /** Mounts the view in the window and gives it the keyboard: a view that never held focus never blurs. */
  private show() {
    if (this.destroyed || this.parent === undefined || !this.hidden) return
    this.hidden = false
    this.host.mount(this.parent, this.view)
    if (!this.webContents.isDestroyed()) this.webContents.focus()
  }

  private async load(url: string): Promise<void> {
    try {
      await this.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }

    if (this.destroyed) return

    if (this.usingPreferredSize) {
      // Set small initial size so the preferred size grows to what's needed
      this.setSize({ width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight })
      // Orivon patch (UPSTREAM.md patch 68): mounted at its smallest size, under its anchor, and
      // grown from there. A view still outside any window has not been seen to report a size.
      this.updatePosition()
      this.show()
      this.armSizeFallback()
    } else {
      // Set large initial size to avoid overflow
      this.setSize({ width: PopupView.BOUNDS.maxWidth, height: PopupView.BOUNDS.maxHeight })

      // Wait for content and layout to load
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (this.destroyed) return

      await this.queryPreferredSize()
      if (this.destroyed) return

      this.show()
    }
  }

  /**
   * Orivon patch (UPSTREAM.md patches 35 and 68): `updatePreferredSize` (this
   * class's only other path to a size, on the branch above) fires from
   * `'preferred-size-changed'`, an event Chromium's own layout/compositor
   * pipeline emits -- there is nothing in this class that requires it to
   * arrive promptly, or at all (measured: it never fires under a GPU-less
   * virtual display). A popup left waiting for it would stay at its smallest
   * size, a postage stamp, for its entire life. After a moment the page's own
   * content is measured instead, and the popup is sized to that. A
   * `'preferred-size-changed'` that does still arrive after this fires
   * still resizes and repositions the popup correctly.
   */
  private armSizeFallback (): void {
    setTimeout(async () => {
      if (this.destroyed || this.sized) return
      d('preferred-size-changed did not arrive in time; measuring the page')
      const measured = await this.measureContent()
      if (this.destroyed || this.sized) return
      this.setSize(measured ?? PopupView.FALLBACK_BOUNDS)
      this.updatePosition()
      this.show()
    }, PopupView.VISIBILITY_FALLBACK_MS)
  }

  /** The size of the page's content as it lays out at its natural width, whatever the view's size is now. */
  private async measureContent (): Promise<{ width: number; height: number } | undefined> {
    try {
      const size = await this.webContents.executeJavaScript(
        `((${() => {
          const root = document.documentElement
          const saved = root.style.width
          root.style.width = 'max-content'
          const rect = root.getBoundingClientRect()
          root.style.width = saved
          return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
        }})())`,
      )
      if (!(size?.width > 0) || !(size?.height > 0)) return undefined
      return size
    } catch (error) {
      d('measuring the popup page failed: %O', error)
      return undefined
    }
  }

  /** Orivon patch (UPSTREAM.md patch 68): every close trigger runs `destroy` a macrotask later. A
   * window shrunk under an open popup blurs the popup while that resize is still running, and
   * taking a view out of the window from inside the native call kills the process. */
  private closeSoon = () => {
    setImmediate(this.destroy)
  }

  destroy = () => {
    if (this.destroyed) return

    this.destroyed = true

    d(`destroying ${this.extensionId}`)

    this.closeOnNextFocusCleanup?.()

    const parent = this.parent
    if (parent) {
      if (!parent.isDestroyed()) {
        parent.off('closed', this.closeSoon)
        parent.off('move', this.closeSoon)
        parent.off('resize', this.closeSoon)
        parent.off('minimize', this.closeSoon)
      }
      this.parent = undefined
    }

    const { webContents } = this
    if (!webContents.isDestroyed() && webContents.isDevToolsOpened()) {
      webContents.closeDevTools()
    }

    if (parent && !this.hidden) {
      try {
        this.host.unmount(parent, this.view)
      } catch (error) {
        d('unmounting the popup failed: %O', error)
      }
    }

    if (!webContents.isDestroyed()) webContents.close()
  }

  isDestroyed() {
    return this.destroyed
  }

  /** Resolves when the popup finishes loading. */
  whenReady() {
    return this.readyPromise
  }

  setSize(rect: Partial<Electron.Rectangle>) {
    if (this.destroyed || !this.parent) return

    const width = Math.floor(
      Math.min(PopupView.BOUNDS.maxWidth, Math.max(rect.width || 0, PopupView.BOUNDS.minWidth)),
    )

    const height = Math.floor(
      Math.min(PopupView.BOUNDS.maxHeight, Math.max(rect.height || 0, PopupView.BOUNDS.minHeight)),
    )

    const size = { width, height }
    d(`setSize`, size)

    this.emit('will-resize', size)

    this.size = size
    this.view.setBounds({ ...this.view.getBounds(), ...size })

    this.emit('resized')
  }

  private onBeforeInput = (_event: Electron.Event, input: Electron.Input): void => {
    // Orivon patch (UPSTREAM.md patch 34): Chrome closes an extension
    // popup on Escape.
    if (input.type === 'keyDown' && input.key === 'Escape') this.closeSoon()
  }

  private maybeClose = () => {
    if (this.host.keepOpenOnBlur?.() === true) {
      d('preventing close due to the embedder moving focus')
      return
    }

    // Keep open if webContents is being inspected
    if (!this.webContents.isDestroyed() && this.webContents.isDevToolsOpened()) {
      d('preventing close due to DevTools being open')
      return
    }

    // For extension popups with a login form, the user may need to access a
    // program outside of the app. Closing the popup would then add
    // inconvenience.
    if (!getAllWindows().some((win) => win.isFocused())) {
      d('preventing close due to focus residing outside of the app')
      this.closeOnNextAppFocus()
      return
    }

    this.closeSoon()
  }

  /**
   * Orivon patch (UPSTREAM.md patch 34): `blur` fires once, on the
   * transition away from this popup, and `maybeClose` reads
   * `getAllWindows().some(isFocused)` at that same instant. On X11 (and
   * plausibly other platforms/window managers), focus handing from the
   * popup to whichever window the person actually clicked is not
   * necessarily atomic with the blur that reports it: for a brief window
   * neither the popup nor the shell reports itself focused, which reads
   * identically to focus having genuinely left the app for a login-form
   * program (the case maybeClose's own guard above exists to keep open
   * for). Since blur only fires on that one transition, missing it here
   * left the popup stuck open for good.
   *
   * Arms a one-shot 'focus' listener across every app window AND every
   * webContents living inside the parent's own view tree (its toolbar/chrome
   * view, every tab view): the parent's tab/toolbar views can gain
   * Chromium's own internal input focus without the parent BaseWindow itself
   * re-firing 'focus'. Whichever fires first disarms the rest, and closes
   * the popup unless its own page holds the keyboard a macrotask later:
   * coming back from a program outside the app hands focus to the popup's
   * page, which is the person returning to it, not leaving it.
   */
  private closeOnNextAppFocus (): void {
    if (this.closeOnNextFocusCleanup !== undefined || this.parent === undefined) return

    const windows = getAllWindows()
    const webContentsList = collectWebContents(this.parent).filter((wc) => wc !== this.webContents)

    const cleanup = (): void => {
      for (const win of windows) win.removeListener('focus', onFocus)
      for (const wc of webContentsList) wc.removeListener('focus', onFocus)
      this.closeOnNextFocusCleanup = undefined
    }
    const onFocus = (): void => {
      cleanup()
      setImmediate(() => {
        if (this.destroyed) return
        if (!this.webContents.isDestroyed() && this.webContents.isFocused()) return
        this.destroy()
      })
    }

    for (const win of windows) win.on('focus', onFocus)
    for (const wc of webContentsList) wc.on('focus', onFocus)

    this.closeOnNextFocusCleanup = cleanup
  }

  private updatePosition() {
    if (this.destroyed || !this.parent) return

    const placement = { anchorRect: this.anchorRect, alignment: this.alignment, size: this.size }
    d(`updatePosition`, placement)

    this.emit('will-move', placement)

    this.host.place(this.parent, this.view, placement)

    this.emit('moved')
  }

  /** Backwards compat for Electron <12 */
  private async queryPreferredSize() {
    if (this.usingPreferredSize || this.destroyed) return

    const rect = await this.webContents.executeJavaScript(
      `((${() => {
        const rect = document.body.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }})())`,
    )

    if (this.destroyed) return

    this.setSize({ width: rect.width, height: rect.height })
    this.updatePosition()
  }

  private updatePreferredSize = (event: Electron.Event, size: Electron.Size) => {
    d('updatePreferredSize', size)
    this.usingPreferredSize = true
    this.sized = true
    this.setSize(size)
    this.updatePosition()

    // Wait to reveal popup until it's sized and positioned correctly
    if (this.hidden) this.show()
  }
}
