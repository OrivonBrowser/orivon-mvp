// A tab drag that is the browser's own drag and drop, used where the screen position of the pointer is unknown
// (a native Wayland session, local-pointer.ts). The compositor draws the drag image anywhere; every window's chrome
// takes the drag over its tab strip and a drop catcher (drop-catcher.ts) takes it over its page. This holds the one
// drag in progress: which windows have a catcher up, what the windows report, and what the drop finally does
// (native-drag-plan.ts decides). One instance for the whole process, since only one tab is dragged at a time.
import { SHELL_EVENT_CHANNEL } from '../channels.js'
import type { ShellEvent } from './shell-events.js'
import type { Catcher, CatcherHooks } from './drop-catcher.js'
import { DropSettler } from './native-drag-plan.js'
import type { DragClock, DragPoint, NativeOutcome } from './native-drag-plan.js'
import type { Zone } from './split-model.js'
import type { ShellWindow } from './window-registry.js'

/** What the window the drag began in does with it. */
export interface NativeDragOps {
  readonly pinned: boolean
  /** The split edge of the source's page that `point` (content coordinates) is on. */
  readonly splitZone: (point: DragPoint) => Zone | null
  readonly setSplitPreview: (zone: Zone | null) => void
  readonly apply: (outcome: NativeOutcome<ShellWindow>) => void
}

export interface NativeDragDeps {
  readonly windows: () => readonly ShellWindow[]
  readonly clock: DragClock
  readonly catcher: (window: ShellWindow, hooks: CatcherHooks) => Catcher
  /** The tab's page as a data URL, or null when it cannot be captured (a tab behind another one). */
  readonly thumbnail: (source: ShellWindow, tabId: string) => Promise<string | null>
}

interface Active {
  readonly source: ShellWindow
  readonly nonce: string
  readonly ops: NativeDragOps
  readonly settler: DropSettler<ShellWindow>
  readonly onSourceClosed: () => void
}

export class NativeTabDrag {
  private readonly catchers = new Map<ShellWindow, Catcher>()
  private active: Active | null = null

  constructor (private readonly deps: NativeDragDeps) {}

  /** A tab was pressed: its page, for the drag image. */
  async thumbnail (source: ShellWindow, tabId: string): Promise<string | null> {
    return await this.deps.thumbnail(source, tabId)
  }

  /** A tab is being pulled: every window gets its catcher ready, so a drag finds each one loaded. */
  warm (): void {
    for (const window of this.live()) this.catcherOf(window).warm()
  }

  /** The browser started the drag of `tabId` from `source`, carrying `nonce`. Windows other than the source learn
   * a drag is over them; every window's page is covered. */
  start (source: ShellWindow, nonce: string, ops: NativeDragOps): void {
    this.abandon()
    const onSourceClosed = (): void => { this.abandon() }
    source.window.once('closed', onSourceClosed)
    const settler = new DropSettler<ShellWindow>(source, this.deps.clock, (outcome) => { this.finish(outcome) })
    this.active = { source, nonce, ops, settler, onSourceClosed }
    for (const window of this.live()) {
      this.catcherOf(window).show()
      if (window !== source) this.tell(window, { type: 'nativeTabDrag', on: true, pinned: ops.pinned })
    }
  }

  /** A chrome took the drop over its top rows (`below` false), or below them over the bookmarks bar. */
  dropped (window: ShellWindow, nonce: string, index: number | null, below: boolean): void {
    const drag = this.matching(nonce)
    if (drag === null) return
    drag.settler.dropped(below ? { on: 'page', window, zone: null } : { on: 'strip', window, index })
  }

  /** The source's drag ended, whether or not anything took it. */
  ended (window: ShellWindow, nonce: string): void {
    const drag = this.matching(nonce)
    if (drag !== null && window === drag.source) drag.settler.end()
  }

  /** The source saw Escape after its drag ended. */
  cancelled (window: ShellWindow, nonce: string): void {
    const drag = this.matching(nonce)
    if (drag !== null && window === drag.source) drag.settler.cancel()
  }

  dispose (): void {
    this.abandon()
    for (const catcher of this.catchers.values()) catcher.dispose()
    this.catchers.clear()
  }

  private matching (nonce: string): Active | null {
    return this.active !== null && this.active.nonce === nonce ? this.active : null
  }

  private live (): ShellWindow[] {
    return this.deps.windows().filter((window) => !window.window.isDestroyed())
  }

  private catcherOf (window: ShellWindow): Catcher {
    let catcher = this.catchers.get(window)
    if (catcher === undefined) {
      const made = this.deps.catcher(window, {
        over: (point) => {
          const drag = this.active
          if (drag?.source === window) drag.ops.setSplitPreview(drag.ops.splitZone(point))
        },
        leave: () => {
          const drag = this.active
          if (drag?.source === window) drag.ops.setSplitPreview(null)
        },
        drop: (nonce, point) => {
          const drag = this.matching(nonce)
          if (drag === null) return
          drag.settler.dropped({ on: 'page', window, zone: window === drag.source ? drag.ops.splitZone(point) : null })
        }
      })
      catcher = made
      this.catchers.set(window, made)
      window.window.once('closed', () => {
        made.dispose()
        this.catchers.delete(window)
      })
    }
    return catcher
  }

  private tell (window: ShellWindow, event: ShellEvent): void {
    const contents = window.chrome.webContents
    if (!window.window.isDestroyed() && !contents.isDestroyed()) contents.send(SHELL_EVENT_CHANNEL, event)
  }

  /** The drag is over: the catchers come down, the windows are told, and the outcome is carried out. */
  private finish (outcome: NativeOutcome<ShellWindow>): void {
    const drag = this.active
    if (drag === null) return
    this.close(drag)
    if (!drag.source.window.isDestroyed()) {
      drag.ops.setSplitPreview(null)
      drag.ops.apply(outcome)
    }
  }

  /** The drag is dropped without an outcome: its source is gone, or another drag began. */
  private abandon (): void {
    const drag = this.active
    if (drag === null) return
    this.close(drag)
    if (!drag.source.window.isDestroyed()) drag.ops.setSplitPreview(null)
  }

  private close (drag: Active): void {
    this.active = null
    drag.settler.dispose()
    if (!drag.source.window.isDestroyed()) drag.source.window.removeListener('closed', drag.onSourceClosed)
    for (const window of this.live()) {
      this.catchers.get(window)?.hide()
      this.tell(window, { type: 'nativeTabDrag', on: false, pinned: false })
    }
  }
}
