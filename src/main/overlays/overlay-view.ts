// One overlay's WebContentsView: built the way the toolbar popovers are
// (../permissions/popover-view.ts says why a separate view, not a region of
// the chrome), minus every decision about when it is shown, which is the
// host's. Nothing here knows an overlay's feature.
import { app, WebContentsView } from 'electron'
import type { Rectangle, View, WebContents } from 'electron'
import { join } from 'node:path'
import { rendererEntryUrl, validatedDevServerUrl } from '../shell/renderer-entry.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import { SHELL_PARTITION } from '../shell/shell-session.js'
import { MENU_POPOVER_BACKGROUND, PANEL_POPOVER_BACKGROUND, resolveThemeColor } from '../shell/theme-colors.js'
import { recordViewBackground } from '../shell/view-background-test-hook.js'
import { registerOverlayIpc } from './overlay-ipc.js'
import type { OverlayPort } from './overlay-ipc.js'
import type { OverlayDef, OverlayKey } from './overlay-types.js'

const CORNER_RADIUS = 10

/** What a view is asked to give focus back to: a webContents, or nothing the host can reason about. */
export interface FocusTarget {
  readonly id: number
  focus: () => void
  isDestroyed: () => boolean
}

/** The narrow surface the host drives; a test replaces the whole module with a fake. */
export interface OverlayViewHandle {
  readonly id: number
  /** Adds the view as `parent`'s topmost child, or moves an existing child to the top, and shows it. */
  attach: (parent: View) => void
  /** Takes the view off the window for good: a view about to be destroyed. */
  detach: (parent: View) => void
  /** Takes the view off the screen but leaves it a child of its window, so the next `attach` only shows it again. */
  hide: () => void
  setBounds: (bounds: Rectangle) => void
  /** Focuses the page once it can take it, unless `wanted()` is false by then. */
  focusWhenReady: (wanted: () => boolean) => void
  send: (channel: string, message: unknown) => void
  refreshBackground: () => void
  isDestroyed: () => boolean
  isFocused: () => boolean
  focus: () => void
  destroy: () => void
}

export interface OverlayViewSpec {
  /** The caller's own `import.meta.dirname`, as `rendererEntryUrl` takes it. */
  readonly dirname: string
  readonly def: Pick<OverlayDef, 'name' | 'surface'>
  /** No rounded corners: a view that sits flush against the window's edge. */
  readonly square?: boolean
  readonly port: OverlayPort
  readonly onBlur: () => void
  readonly onFocus: () => void
  /** A key pressed down in the page, before the page sees it; true drops it. */
  readonly onKey?: (key: OverlayKey) => boolean
  /** The page's renderer process died (crashed, was killed or ran out of memory); the webContents itself is not destroyed. */
  readonly onGone: () => void
}

function backgroundFor (surface: OverlayDef['surface']): string {
  return resolveThemeColor(surface === 'menu' ? MENU_POPOVER_BACKGROUND : PANEL_POPOVER_BACKGROUND)
}

/** The page's address. The preload's gate and the ipc sender check both compare it character for character. */
export function overlayUrl (dirname: string, def: Pick<OverlayDef, 'name' | 'surface'>): string {
  const base = rendererEntryUrl(dirname, validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']), '/overlay/', '../renderer/overlay/index.html')
  return `${base}?overlay=${encodeURIComponent(def.name)}&surface=${def.surface}`
}

export function createOverlayView (spec: OverlayViewSpec): OverlayViewHandle {
  const url = overlayUrl(spec.dirname, spec.def)
  const view = new WebContentsView({
    webPreferences: {
      preload: join(spec.dirname, '../preload/overlay.js'),
      partition: SHELL_PARTITION,
      additionalArguments: [`--orivon-overlay-url=${url}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  const contents = view.webContents
  // Before the view is ever attached, so the first frame composited is the
  // surface's colour and not the opaque white a new view defaults to.
  const color = backgroundFor(spec.def.surface)
  view.setBackgroundColor(color)
  recordViewBackground(contents.id, color)
  // The preload is privileged: a view holding it must never end up on a document other than `url`.
  lockNavigation(contents, url)
  view.setBorderRadius(spec.square === true ? 0 : CORNER_RADIUS)
  registerOverlayIpc(contents, url, spec.port)
  // Not from inside the native call that raised it: a window shrunk under an open popup blurs the popup while the resize is still running, and taking the view out of the window there kills the process.
  contents.on('blur', () => { setImmediate(spec.onBlur) })
  contents.on('focus', spec.onFocus)
  contents.on('render-process-gone', spec.onGone)
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || spec.onKey === undefined) return
    if (spec.onKey({ key: input.key, isAutoRepeat: input.isAutoRepeat })) event.preventDefault()
  })
  void contents.loadURL(url)

  return {
    id: contents.id,
    attach: (parent) => {
      parent.addChildView(view)
      view.setVisible(true)
    },
    detach: (parent) => { parent.removeChildView(view) },
    // A warm view is hidden in place, never removed: see README.md's Design notes for why.
    hide: () => { view.setVisible(false) },
    setBounds: (bounds) => { view.setBounds(bounds) },
    focusWhenReady: (wanted) => {
      // A view that never held focus can never blur, so a blur-closed overlay would stay open forever.
      const focus = (): void => { if (wanted() && !contents.isDestroyed()) contents.focus() }
      if (contents.isLoading()) contents.once('did-finish-load', focus)
      else focus()
    },
    send: (channel, message) => { if (!contents.isDestroyed()) contents.send(channel, message) },
    refreshBackground: () => {
      if (contents.isDestroyed()) return
      const next = backgroundFor(spec.def.surface)
      view.setBackgroundColor(next)
      recordViewBackground(contents.id, next)
    },
    isDestroyed: () => contents.isDestroyed(),
    isFocused: () => !contents.isDestroyed() && contents.isFocused(),
    focus: () => { if (!contents.isDestroyed()) contents.focus() },
    destroy: () => { if (!contents.isDestroyed()) contents.close() }
  }
}

/** A view the host can ask about focus: one it owns, or the chrome or the tab in front. */
export interface FocusCandidate extends FocusTarget {
  isFocused: () => boolean
}

/** Which of these holds keyboard focus, if any. Only views the window knows are live are asked:
 * `webContents.getFocusedWebContents()` can answer one that is being torn down (an app's child host
 * after its page ends), and reading it then kills the main process. */
export function focusedContents (candidates: ReadonlyArray<FocusCandidate | undefined>): FocusTarget | undefined {
  return candidates.find((candidate) => candidate !== undefined && !candidate.isDestroyed() && candidate.isFocused())
}
