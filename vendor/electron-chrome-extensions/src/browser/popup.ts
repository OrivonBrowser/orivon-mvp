import { EventEmitter } from 'node:events'
import { BrowserWindow, nativeTheme } from 'electron'
import type { Session } from 'electron'
import { getAllWindows } from './api/common'
import debug from 'debug'

const d = debug('electron-chrome-extensions:popup')

// Orivon patch (UPSTREAM.md patch 35): was the single literal '#ffffff'
// passed to the BrowserWindow constructor below. This paints before the
// extension's own popup page has a pixel to show (same reasoning as
// src/main/shell/window-frame.ts's own background colour); a fixed light
// colour flashed white for a moment on every popup open in dark mode.
const POPUP_BACKGROUND_LIGHT = '#ffffff'
const POPUP_BACKGROUND_DARK = '#202124'

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

interface PopupViewOptions {
  extensionId: string
  session: Session
  parent: Electron.BaseWindow
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
function collectWebContents (win: Electron.BaseWindow): Electron.WebContents[] {
  const out: Electron.WebContents[] = []
  const walk = (view: Electron.View): void => {
    const webContents = (view as unknown as { webContents?: Electron.WebContents }).webContents
    if (webContents !== undefined) out.push(webContents)
    for (const child of view.children) walk(child)
  }
  walk(win.contentView)
  return out
}

export class PopupView extends EventEmitter {
  static POSITION_PADDING = 5

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

  // Orivon patch: `| undefined` added to all three (exactOptionalPropertyTypes)
  // -- destroy() assigns `undefined` to browserWindow/parent, and the
  // constructor assigns opts.alignment (now `string | undefined`) to
  // alignment; the bare `?:` form refuses both.
  browserWindow?: BrowserWindow | undefined
  parent?: Electron.BaseWindow | undefined
  extensionId: string

  private anchorRect: PopupAnchorRect
  private destroyed: boolean = false
  private hidden: boolean = true
  private alignment?: string | undefined

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

    this.browserWindow = new BrowserWindow({
      show: false,
      frame: false,
      parent: opts.parent,
      movable: false,
      maximizable: false,
      minimizable: false,
      // https://github.com/electron/electron/issues/47579
      fullscreenable: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? POPUP_BACKGROUND_DARK : POPUP_BACKGROUND_LIGHT,
      roundedCorners: false,
      webPreferences: {
        session: opts.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enablePreferredSizeMode: true,
      },
    })

    const untypedWebContents = this.browserWindow.webContents as any
    untypedWebContents.on('preferred-size-changed', this.updatePreferredSize)

    this.browserWindow.webContents.on('devtools-closed', this.maybeClose)
    this.browserWindow.webContents.on('before-input-event', this.onBeforeInput)
    this.browserWindow.on('blur', this.maybeClose)
    this.browserWindow.on('closed', this.destroy)
    this.parent.once('closed', this.destroy)
    // Orivon patch (UPSTREAM.md patch 34): Chrome closes an extension
    // popup the moment the window it belongs to is moved, resized or
    // minimised, not only on an outside click -- none of the three
    // touches this popup's OWN bounds (only setSize/updatePosition below
    // do that), so there is no risk of a false positive from the popup
    // positioning itself.
    this.parent.on('move', this.destroy)
    this.parent.on('resize', this.destroy)
    this.parent.on('minimize', this.destroy)

    this.readyPromise = this.load(opts.url)
  }

  private show() {
    this.hidden = false
    this.browserWindow?.show()
  }

  private async load(url: string): Promise<void> {
    const win = this.browserWindow!

    try {
      await win.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }

    if (this.destroyed) return

    if (this.usingPreferredSize) {
      // Set small initial size so the preferred size grows to what's needed
      this.setSize({ width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight })
      this.armVisibilityFallback()
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
   * Orivon patch (UPSTREAM.md patch 35): `updatePreferredSize` (this
   * class's only other path to `show()`, on the branch above) fires from
   * `'preferred-size-changed'`, an event Chromium's own layout/compositor
   * pipeline emits -- there is nothing in this class that requires it to
   * arrive promptly, or at all. A popup left waiting for it is fully
   * loaded and interactive over CDP the whole time, but `show: false`
   * forever: invisible and unfocusable to a real person. A
   * `'preferred-size-changed'` that does still arrive after this fires
   * still resizes and repositions the popup correctly (updatePreferredSize
   * does not check `hidden` before acting).
   */
  private armVisibilityFallback (): void {
    setTimeout(() => {
      if (this.destroyed || !this.hidden) return
      d('preferred-size-changed did not arrive in time; showing with a default size')
      this.setSize(PopupView.FALLBACK_BOUNDS)
      this.show()
    }, PopupView.VISIBILITY_FALLBACK_MS)
  }

  destroy = () => {
    if (this.destroyed) return

    this.destroyed = true

    d(`destroying ${this.extensionId}`)

    this.closeOnNextFocusCleanup?.()

    if (this.parent) {
      if (!this.parent.isDestroyed()) {
        this.parent.off('closed', this.destroy)
        this.parent.off('move', this.destroy)
        this.parent.off('resize', this.destroy)
        this.parent.off('minimize', this.destroy)
      }
      this.parent = undefined
    }

    if (this.browserWindow) {
      if (!this.browserWindow.isDestroyed()) {
        const { webContents } = this.browserWindow

        if (!webContents.isDestroyed() && webContents.isDevToolsOpened()) {
          webContents.closeDevTools()
        }

        this.browserWindow.off('closed', this.destroy)
        this.browserWindow.destroy()
      }

      this.browserWindow = undefined
    }
  }

  isDestroyed() {
    return this.destroyed
  }

  /** Resolves when the popup finishes loading. */
  whenReady() {
    return this.readyPromise
  }

  setSize(rect: Partial<Electron.Rectangle>) {
    if (!this.browserWindow || !this.parent) return

    const width = Math.floor(
      Math.min(PopupView.BOUNDS.maxWidth, Math.max(rect.width || 0, PopupView.BOUNDS.minWidth)),
    )

    const height = Math.floor(
      Math.min(PopupView.BOUNDS.maxHeight, Math.max(rect.height || 0, PopupView.BOUNDS.minHeight)),
    )

    const size = { width, height }
    d(`setSize`, size)

    this.emit('will-resize', size)

    this.browserWindow?.setBounds({
      ...this.browserWindow.getBounds(),
      ...size,
    })

    this.emit('resized')
  }

  private onBeforeInput = (_event: Electron.Event, input: Electron.Input): void => {
    // Orivon patch (UPSTREAM.md patch 34): Chrome closes an extension
    // popup on Escape.
    if (input.type === 'keyDown' && input.key === 'Escape') this.destroy()
  }

  private maybeClose = () => {
    // Keep open if webContents is being inspected
    if (!this.browserWindow?.isDestroyed() && this.browserWindow?.webContents.isDevToolsOpened()) {
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

    this.destroy()
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
   * Arms a one-shot 'focus' listener across every other app window AND
   * every webContents living inside the parent's own view tree (its
   * toolbar/chrome view, every tab view): the parent's tab/toolbar views
   * can gain Chromium's own internal input focus without the parent
   * BaseWindow itself re-firing 'focus' (it never lost native OS focus in
   * the first place, if the popup itself never actually took it) --
   * exactly the case a plain `app.on('browser-window-focus', ...)` would
   * miss. Whichever fires first closes the popup and disarms the rest.
   */
  private closeOnNextAppFocus (): void {
    if (this.closeOnNextFocusCleanup !== undefined || this.parent === undefined) return

    const windows = getAllWindows().filter((win) => win !== this.browserWindow)
    const webContentsList = collectWebContents(this.parent)

    const cleanup = (): void => {
      for (const win of windows) win.removeListener('focus', onFocus)
      for (const wc of webContentsList) wc.removeListener('focus', onFocus)
      this.closeOnNextFocusCleanup = undefined
    }
    const onFocus = (): void => {
      cleanup()
      if (!this.destroyed) this.destroy()
    }

    for (const win of windows) win.on('focus', onFocus)
    for (const wc of webContentsList) wc.on('focus', onFocus)

    this.closeOnNextFocusCleanup = cleanup
  }

  private updatePosition() {
    if (!this.browserWindow || !this.parent) return

    const winBounds = this.parent.getBounds()
    const winContentBounds = this.parent.getContentBounds()
    const nativeTitlebarHeight = winBounds.height - winContentBounds.height

    const viewBounds = this.browserWindow.getBounds()

    let x = winBounds.x + this.anchorRect.x + this.anchorRect.width - viewBounds.width
    let y =
      winBounds.y +
      nativeTitlebarHeight +
      this.anchorRect.y +
      this.anchorRect.height +
      PopupView.POSITION_PADDING

    // If aligned to a differently then we need to offset the popup position
    if (this.alignment?.includes('right')) x = winBounds.x + this.anchorRect.x
    if (this.alignment?.includes('top'))
      y =
        winBounds.y +
        nativeTitlebarHeight -
        viewBounds.height +
        this.anchorRect.y -
        PopupView.POSITION_PADDING

    // Convert to ints
    x = Math.floor(x)
    y = Math.floor(y)

    const position = { x, y }
    d(`updatePosition`, position)

    this.emit('will-move', position)

    this.browserWindow.setBounds({
      ...this.browserWindow.getBounds(),
      ...position,
    })

    this.emit('moved')
  }

  /** Backwards compat for Electron <12 */
  private async queryPreferredSize() {
    if (this.usingPreferredSize || this.destroyed) return

    const rect = await this.browserWindow!.webContents.executeJavaScript(
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
    this.setSize(size)
    this.updatePosition()

    // Wait to reveal popup until it's sized and positioned correctly
    if (this.hidden) this.show()
  }
}
