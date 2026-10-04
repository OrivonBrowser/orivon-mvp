// The transparent view laid over a window's page while a tab is dragged. A page under an HTML drag is told which
// data types the drag holds, so the pages never get to be the drop target: this view takes the drag instead, tells
// main where it is over the page and where it was dropped, and the page beneath sees no event. It is attached for
// the length of a drag only; between drags it is not in the window, and is released after a minute unused.
import { app, WebContentsView } from 'electron'
import type { BaseWindow, IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { DROP_CATCHER_CHANNEL } from '../channels.js'
import { attachShown } from './attach-view.js'
import { lockNavigation } from './lock-navigation.js'
import type { DragPoint } from './native-drag-plan.js'
import { rendererEntryUrl, validatedDevServerUrl } from './renderer-entry.js'
import { SHELL_PARTITION } from './shell-session.js'

const IDLE_RELEASE_MS = 60_000
/** A drop nonce is a UUID; anything longer is not one. */
const MAX_NONCE_LENGTH = 64

/** What a catcher says, in the window's content coordinates. */
export interface CatcherHooks {
  readonly over: (point: DragPoint) => void
  readonly leave: () => void
  readonly drop: (nonce: string, point: DragPoint) => void
}

/** The part of a catcher the drag session uses. */
export interface Catcher {
  /** Makes the view and loads its page, so a drag finds it ready. */
  warm: () => void
  /** Puts it over the window's page, on top of everything. */
  show: () => void
  hide: () => void
  dispose: () => void
}

type Message =
  | { readonly type: 'over', readonly x: number, readonly y: number }
  | { readonly type: 'leave' }
  | { readonly type: 'drop', readonly nonce: string, readonly x: number, readonly y: number }

function parseMessage (value: unknown): Message | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Record<string, unknown>
  const { type, x, y, nonce } = message
  if (type === 'leave') return { type }
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  if (type === 'over') return { type, x, y }
  if (type === 'drop' && typeof nonce === 'string' && nonce.length <= MAX_NONCE_LENGTH) return { type, nonce, x, y }
  return null
}

export class DropCatcher implements Catcher {
  private view: WebContentsView | null = null
  private origin: DragPoint = { x: 0, y: 0 }
  private shown = false
  private idle: ReturnType<typeof setTimeout> | null = null

  /** `chromeHeight` is where the window's chrome ends: the catcher covers what lies below it. */
  constructor (
    private readonly window: BaseWindow,
    private readonly chromeHeight: () => number,
    private readonly dirname: string,
    private readonly hooks: CatcherHooks
  ) {}

  warm (): void {
    if (this.window.isDestroyed()) return
    this.view ??= this.build()
    if (!this.shown) this.restartIdle()
  }

  show (): void {
    if (this.window.isDestroyed()) return
    const view = this.view ?? this.build()
    this.view = view
    this.clearIdle()
    const content = this.window.getContentBounds()
    const top = this.chromeHeight()
    this.origin = { x: 0, y: top }
    view.setBounds({ x: 0, y: top, width: content.width, height: Math.max(0, content.height - top) })
    attachShown(this.window.contentView, view)
    this.shown = true
  }

  hide (): void {
    if (!this.shown) return
    this.shown = false
    if (this.view !== null && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    this.restartIdle()
  }

  dispose (): void {
    this.clearIdle()
    this.shown = false
    const view = this.view
    this.view = null
    if (view !== null && !view.webContents.isDestroyed()) view.webContents.close()
  }

  private clearIdle (): void {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = null
  }

  private restartIdle (): void {
    this.clearIdle()
    this.idle = setTimeout(() => { this.dispose() }, IDLE_RELEASE_MS)
    this.idle.unref()
  }

  private build (): WebContentsView {
    const url = rendererEntryUrl(this.dirname, validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']), '/drop-catcher/', '../renderer/drop-catcher/index.html')
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.dirname, '../preload/drop-catcher.js'),
        partition: SHELL_PARTITION,
        additionalArguments: [`--orivon-drop-catcher-url=${url}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    view.setBackgroundColor('#00000000')
    const { webContents } = view
    // Its preload is privileged: the view must never end up on another document. Locked before the load.
    lockNavigation(webContents, url)
    webContents.ipc.on(DROP_CATCHER_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
      if (event.senderFrame !== webContents.mainFrame) return
      const message = parseMessage(raw)
      if (message === null) return
      const inWindow = (x: number, y: number): DragPoint => ({ x: x + this.origin.x, y: y + this.origin.y })
      if (message.type === 'over') this.hooks.over(inWindow(message.x, message.y))
      else if (message.type === 'leave') this.hooks.leave()
      else this.hooks.drop(message.nonce, inWindow(message.x, message.y))
    })
    void webContents.loadURL(url)
    return view
  }
}
