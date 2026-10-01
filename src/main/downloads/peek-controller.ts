// When the downloads bubble opens by itself and when it goes again. A new download opens it as a peek that
// never takes focus (the person may be typing), only when nothing else is open and never more than once every
// couple of seconds for one window; it closes a few seconds after the last download ends unless the pointer is
// on it, and stays while a file waits for Keep or Discard. Pure apart from the deps it is given.
import type { DownloadChange, DownloadEntry } from './download-types.js'
import type { StartInfo } from './download-service.js'

/** The peek opens at most this often for one window, so a page cannot flash it by starting downloads in a loop. */
export const MIN_PEEK_GAP_MS = 2000
/** How long the peek stays once nothing is running. */
export const PEEK_LINGER_MS = 5000

export interface PeekDeps<W extends object> {
  showBubble: () => boolean
  buttonAllowed: () => boolean
  windowOf: (info: StartInfo) => W | undefined
  popupOpen: (window: W) => boolean
  peekOpen: (window: W) => boolean
  requestPeek: (window: W) => void
  closePeek: (window: W) => void
  list: () => readonly DownloadEntry[]
  active: () => number
  now: () => number
  schedule: (run: () => void, ms: number) => unknown
  cancel: (timer: unknown) => void
}

export class PeekController<W extends object> {
  private readonly lastAsked = new Map<W, number>()
  private readonly timers = new Map<W, unknown>()
  private readonly pointerOver = new Set<W>()
  private readonly asked = new Set<W>()

  constructor (private readonly deps: PeekDeps<W>) {}

  started (info: StartInfo): void {
    const { deps } = this
    if (!deps.showBubble() || !deps.buttonAllowed()) return
    const window = deps.windowOf(info)
    if (window === undefined) return
    this.stopTimer(window)
    if (deps.peekOpen(window) || deps.popupOpen(window)) return
    const now = deps.now()
    const last = this.lastAsked.get(window)
    if (last !== undefined && now - last < MIN_PEEK_GAP_MS) return
    this.lastAsked.set(window, now)
    this.asked.add(window)
    deps.requestPeek(window)
  }

  /** The peek is on screen: it may already have nothing to wait for. */
  opened (window: W): void {
    this.asked.add(window)
    this.settle(window)
  }

  /** Something in the list changed: a peek with nothing left to show closes after its linger. */
  changed (change: DownloadChange): void {
    if (change !== null && (change.state === 'progressing' || change.state === 'paused')) return
    for (const window of [...this.asked]) this.settle(window)
  }

  /** The pointer entered or left the peek. */
  pointer (window: W, over: boolean): void {
    if (over) this.pointerOver.add(window)
    else this.pointerOver.delete(window)
    this.settle(window)
  }

  /** The peek closed, by whatever means. */
  closed (window: W): void {
    this.stopTimer(window)
    this.pointerOver.delete(window)
    this.asked.delete(window)
  }

  private settle (window: W): void {
    const { deps } = this
    this.stopTimer(window)
    if (!deps.peekOpen(window)) { this.asked.delete(window); return }
    const busy = deps.active() > 0 || deps.list().some((entry) => entry.state === 'held')
    if (busy || this.pointerOver.has(window)) return
    this.timers.set(window, deps.schedule(() => {
      this.timers.delete(window)
      if (!this.pointerOver.has(window) && deps.peekOpen(window)) deps.closePeek(window)
    }, PEEK_LINGER_MS))
  }

  private stopTimer (window: W): void {
    const timer = this.timers.get(window)
    if (timer === undefined) return
    this.deps.cancel(timer)
    this.timers.delete(window)
  }
}

/** The controller of a process, found from its services by the overlay that reports the pointer and the close. */
export const PEEK_CONTROLLERS = new WeakMap<object, PeekController<object>>()
