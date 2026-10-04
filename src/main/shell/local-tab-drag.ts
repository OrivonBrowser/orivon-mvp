// A tab drag when screen positions are unknown (local-pointer.ts). The window the drag started in keeps the
// pointer (pointer capture) and says where it is in its own coordinates; no other window hears anything until the
// pointer is let go, and then the one under it sees it arrive. So the preview is a view inside the source window
// (drag-ghost.ts), the other windows are told a tab is being dragged, and the first pointer position each one's
// chrome sees is what says whether the tab was let go over its strip (local-drop.ts decides).
// One instance for the whole process, like tear-drag.ts: only one tab is mid-drag at a time.
import { SHELL_EVENT_CHANNEL } from '../channels.js'
import { DragGhost } from './drag-ghost.js'
import { ArrivalBook, ghostPointFor } from './local-drop.js'
import type { Arrival, ArrivalClock } from './local-drop.js'
import { refreshStripLayout } from './strip-centres.js'
import { captureTabPage } from './tab-view.js'
import { CURSOR_OFFSET, imageToDataUrl, previewSizeFor } from './tear-drag.js'
import type { ShellWindow } from './window-registry.js'

/** How long after a drag ends without a drop the other windows are still listened to: an arrival can reach main
 * after the end message does, when the drop that follows has not come (a cancel has none). */
const END_GRACE_MS = 400

const realClock: ArrivalClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => { clearTimeout(timer) }
  }
}

export class LocalTabDrag {
  private source: ShellWindow | null = null
  private tabId: string | null = null
  private ghost: DragGhost | null = null
  private arrivals: ArrivalBook<ShellWindow> | null = null
  private thumbnail: Promise<string | null> = Promise.resolve(null)
  private cancelGrace: (() => void) | null = null

  constructor (private readonly windows: () => readonly ShellWindow[], private readonly clock: ArrivalClock = realClock) {}

  /** A drag just started: tell the other windows, and capture the tab's page for the preview. */
  begin (source: ShellWindow, tabId: string): void {
    this.finish()
    this.source = source
    this.tabId = tabId
    this.arrivals = new ArrivalBook<ShellWindow>(this.clock)
    const bounds = source.window.getContentBounds()
    const size = previewSizeFor(bounds.width, bounds.height)
    this.thumbnail = captureTabPage(source.tabs.liveWebContents(tabId)).then((image) => imageToDataUrl(image, size))
    for (const other of this.others()) {
      void refreshStripLayout(other) // so the slot under a drop is known when it comes
      this.tell(other, true)
    }
  }

  /** The dragged tab is out of its strip at `client` (the source window's own coordinates). */
  update (source: ShellWindow, tabId: string, client: { x: number, y: number }, inZone: boolean, topHeight: number): void {
    if (this.source !== source || this.tabId !== tabId || source.window.isDestroyed()) return
    const content = source.window.getContentBounds()
    const at = ghostPointFor(client, content, topHeight, inZone)
    if (at === null) {
      this.ghost?.hide()
      return
    }
    if (this.ghost === null) {
      const title = source.tabs.getState().tabs.find((tab) => tab.id === tabId)?.title ?? ''
      this.ghost = new DragGhost(source.window.contentView, previewSizeFor(content.width, content.height), title.length === 0 ? 'New Tab' : title, this.thumbnail)
    }
    this.ghost.follow(at, CURSOR_OFFSET)
  }

  /** The pointer is back in the strip, or the drag is over: nothing to show. */
  hide (): void { this.ghost?.hide() }

  /** The chrome of `window` saw the pointer for the first time during the drag, at `point` in its content area. */
  arrived (window: ShellWindow, point: { x: number, y: number }): void {
    if (this.source === null || window === this.source || window.window.isDestroyed()) return
    this.arrivals?.record({ window, x: point.x, y: point.y, width: window.window.getContentBounds().width })
  }

  /** The drag ended without a drop (let go in the strip, or cancelled). */
  ended (): void {
    this.ghost?.dispose()
    this.ghost = null
    this.cancelGrace?.()
    this.cancelGrace = this.clock.after(END_GRACE_MS, () => { this.finish() })
  }

  /** The tab was let go outside its strip: the arrival that says which window's strip it was over, if any. The
   * drag is over once the caller has acted on it (`finish`). */
  async settle (): Promise<Arrival<ShellWindow> | null> {
    this.ghost?.dispose()
    this.ghost = null
    this.cancelGrace?.()
    this.cancelGrace = null
    return await (this.arrivals?.settle() ?? Promise.resolve(null))
  }

  /** Nothing left to listen for: every window is told the drag is over. */
  finish (): void {
    this.cancelGrace?.()
    this.cancelGrace = null
    this.ghost?.dispose()
    this.ghost = null
    this.arrivals?.clear()
    this.arrivals = null
    if (this.source !== null) for (const other of this.others()) this.tell(other, false)
    this.source = null
    this.tabId = null
  }

  dispose (): void { this.finish() }

  private others (): ShellWindow[] {
    return this.windows().filter((other) => other !== this.source && !other.window.isDestroyed() && !other.chrome.webContents.isDestroyed())
  }

  private tell (window: ShellWindow, on: boolean): void {
    window.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'tabDrag', on })
  }
}
