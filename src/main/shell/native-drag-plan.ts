// What letting go of a tab does when the drag is the browser's own drag and drop (native-tab-drag.ts): decided from
// what the windows reported and in what order. Pure, so every outcome is tested without a window or a clock.
import type { Zone } from './split-model.js'

/** A point in a window's content area. */
export interface DragPoint { readonly x: number, readonly y: number }

/** Where the drop landed, as the window that took it reported it. */
export type DropReport<W> =
  /** On a window's tab strip or toolbar. `index` is the place in that window's tabs; null when the window accepted
   * the drop and there is nothing to do (the source's own toolbar). */
  | { readonly on: 'strip', readonly window: W, readonly index: number | null }
  /** On a window's page (its drop catcher) or below the chrome's top rows. `zone` is the split edge it was on. */
  | { readonly on: 'page', readonly window: W, readonly zone: Zone | null }

export type NativeOutcome<W> =
  | { readonly kind: 'none' }
  | { readonly kind: 'reorder', readonly index: number }
  | { readonly kind: 'move', readonly window: W, readonly index: number }
  | { readonly kind: 'split', readonly zone: Zone }
  | { readonly kind: 'window' }

/** How long, after a drag ends with no drop reported, to wait for one (the two messages can cross) or for the
 * cancel that tells Escape from a release over nothing. Provisional: measured, Escape's key-up reaches the source
 * 100 to 200 ms after the drag ends. */
export const CANCEL_WAIT_MS = 300

/** A drop on a strip reorders it at the source and moves the tab into any other window; a split edge of the
 * source's page splits; every other drop, and a release over nothing, is a window of its own; an Escape changes
 * nothing. A drop that was reported wins over a cancel. */
export function planNativeDrop<W> (source: W, drop: DropReport<W> | null, cancelled: boolean): NativeOutcome<W> {
  if (drop === null) return cancelled ? { kind: 'none' } : { kind: 'window' }
  if (drop.on === 'strip') {
    if (drop.index === null) return { kind: 'none' }
    return drop.window === source ? { kind: 'reorder', index: drop.index } : { kind: 'move', window: drop.window, index: drop.index }
  }
  return drop.window === source && drop.zone !== null ? { kind: 'split', zone: drop.zone } : { kind: 'window' }
}

export interface DragClock {
  /** Calls `fn` after `ms` and returns what cancels it. */
  after: (ms: number, fn: () => void) => () => void
}

/** The reports of one drag, and the moment they are enough: the drag has ended and a drop is known, or it has
 * ended, nothing dropped, and a cancel came or the wait ran out. Calls `done` once. */
export class DropSettler<W> {
  private drop: DropReport<W> | null = null
  private ended = false
  private cancelled = false
  private finished = false
  private cancelTimer: (() => void) | null = null

  constructor (
    private readonly source: W,
    private readonly clock: DragClock,
    private readonly done: (outcome: NativeOutcome<W>) => void
  ) {}

  /** A window took the drop. The first report stands. */
  dropped (report: DropReport<W>): void {
    if (this.finished || this.drop !== null) return
    this.drop = report
    if (this.ended) this.finish()
  }

  /** The source's drag ended, whether or not anything took it. */
  end (): void {
    if (this.finished || this.ended) return
    this.ended = true
    if (this.drop !== null) this.finish()
    else this.cancelTimer = this.clock.after(CANCEL_WAIT_MS, () => { this.finish() })
  }

  /** Escape was seen after the drag ended. Before it ended, or after a drop, it means nothing. */
  cancel (): void {
    if (this.finished || !this.ended || this.drop !== null) return
    this.cancelled = true
    this.finish()
  }

  /** Gives up: nothing is decided. */
  dispose (): void {
    this.finished = true
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private finish (): void {
    if (this.finished) return
    this.finished = true
    this.cancelTimer?.()
    this.cancelTimer = null
    this.done(planNativeDrop(this.source, this.drop, this.cancelled))
  }
}
