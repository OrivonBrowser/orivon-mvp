// One overlay's WebContentsView: built the way the toolbar popovers are
// (../permissions/popover-view.ts says why a separate view, not a region of
// the chrome), minus every decision about when it is shown, which is the
// host's. Nothing here knows an overlay's feature.
import { app, webContents, WebContentsView } from 'electron'
import type { Rectangle, View, WebContents } from 'electron'
import { join } from 'node:path'
import { rendererEntryUrl, validatedDevServerUrl } from '../shell/renderer-entry.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import { SHELL_PARTITION } from '../shell/shell-session.js'
import { MENU_POPOVER_BACKGROUND, PANEL_POPOVER_BACKGROUND, resolveThemeColor } from '../shell/theme-colors.js'
import { recordViewBackground } from '../shell/view-background-test-hook.js'
import { registerOverlayIpc } from './overlay-ipc.js'
import type { OverlayPort } from './overlay-ipc.js'
import type { OverlayDef } from './overlay-types.js'

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
  /** Adds the view as `parent`'s topmost child; an existing child moves to the top. */
  attach: (parent: View) => void
  detach: (parent: View) => void
  setBounds: (bounds: Rectangle) => void
  /** Focuses the page once it can take it, unless `wanted()` is false by then. */
  focusWhenReady: (wanted: () => boolean) => void
  send: (channel: string, message: unknown) => void
  refreshBackground: () => void
  isDestroyed: () => boolean
  destroy: () => void
}

export interface OverlayViewSpec {
  /** The caller's own `import.meta.dirname`, as `rendererEntryUrl` takes it. */
  readonly dirname: string
  readonly def: Pick<OverlayDef, 'name' | 'surface'>
  readonly port: OverlayPort
  readonly onBlur: () => void
  readonly onFocus: () => void
  /** The page's renderer process died (crashed, was killed or ran out of memory); the webContents itself is not destroyed. */
  readonly onGone: () => void
  /** Called once with the new webContents, before its page loads: where a caller wires per-contents behaviour such as the browser's shortcuts. */
  readonly onCreated?: ((contents: WebContents) => void) | undefined
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
  view.setBorderRadius(CORNER_RADIUS)
  registerOverlayIpc(contents, url, spec.port)
  spec.onCreated?.(contents)
  // Not from inside the native call that raised it: a window shrunk under an open popup blurs the popup while the resize is still running, and taking the view out of the window there kills the process.
  contents.on('blur', () => { setImmediate(spec.onBlur) })
  contents.on('focus', spec.onFocus)
  contents.on('render-process-gone', spec.onGone)
  void contents.loadURL(url)

  return {
    id: contents.id,
    attach: (parent) => { parent.addChildView(view) },
    detach: (parent) => { parent.removeChildView(view) },
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
    destroy: () => { if (!contents.isDestroyed()) contents.close() }
  }
}

/** The webContents that holds keyboard focus in this process, if any. */
export function focusedContents (): FocusTarget | undefined {
  const focused: WebContents | null = webContents.getFocusedWebContents()
  return focused ?? undefined
}
