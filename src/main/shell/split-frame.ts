// The view behind the two panes of a split. It fills the area the panes share
// and the panes sit on it, inset, so what shows between and round them is this
// page: the divider, an outline on the pane the person is in, and the place a
// dragged tab would go. The gap between the panes is its only exposed part, so
// it is also what the pointer grabs to resize -- no overlay over a page needed.
//
// A window that never splits never makes it: the view is built when first asked for.
import { app, WebContentsView } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { SPLIT_FRAME_CHANNEL, SPLIT_STATE_CHANNEL } from '../channels.js'
import { lockNavigation } from './lock-navigation.js'
import { rendererEntryUrl, validatedDevServerUrl } from './renderer-entry.js'
import type { FrameState } from './split-controller.js'
import type { SplitBackdrop } from './tab-types.js'
import { SHELL_PARTITION } from './shell-session.js'

export interface SplitFrameActions {
  /** The divider was dragged to this place along the area (x for side by side, y for stacked). */
  dragTo: (at: number) => void
  reset: () => void
}

export class SplitFrame implements SplitBackdrop {
  private made: WebContentsView | null = null
  private loaded = false
  private latest: FrameState | null = null

  constructor (private readonly actions: SplitFrameActions, private readonly dirname: string) {}

  get view (): WebContentsView {
    this.made ??= this.build()
    return this.made
  }

  update (state: FrameState): void {
    this.latest = state
    this.send()
  }

  /** The window is closing. */
  dispose (): void {
    if (this.made !== null && !this.made.webContents.isDestroyed()) this.made.webContents.close()
    this.made = null
  }

  private send (): void {
    const contents = this.made?.webContents
    if (contents === undefined || contents.isDestroyed() || !this.loaded || this.latest === null) return
    contents.send(SPLIT_STATE_CHANNEL, this.latest)
  }

  private build (): WebContentsView {
    const url = rendererEntryUrl(this.dirname, validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']), '/split-frame/', '../renderer/split-frame/index.html')
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.dirname, '../preload/split-frame.js'),
        partition: SHELL_PARTITION,
        additionalArguments: [`--orivon-split-frame-url=${url}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    const { webContents } = view
    // Its preload is privileged: this view must never end up on another document. Locked before the load.
    lockNavigation(webContents, url)
    // A webContents' handlers hear every frame in it: only its own top frame is heard.
    webContents.ipc.handle(SPLIT_FRAME_CHANNEL, (event: IpcMainInvokeEvent, command: { type?: unknown, at?: unknown }): void => {
      if (event.senderFrame !== webContents.mainFrame) return
      if (command.type === 'drag' && typeof command.at === 'number' && Number.isFinite(command.at)) this.actions.dragTo(command.at)
      else if (command.type === 'reset') this.actions.reset()
    })
    webContents.on('did-finish-load', () => {
      this.loaded = true
      this.send()
    })
    void webContents.loadURL(url)
    return view
  }
}
