// What letting go of a tab does when screen positions are unknown (local-pointer.ts): decided from the point in
// the source window and from where another window's chrome saw the pointer arrive. Pure, so every outcome is
// tested without a window.
import type { Zone } from './split-model.js'

/** A point in a window's own content area. */
export interface LocalPoint { readonly x: number, readonly y: number }

/** The first pointer position another window's chrome saw during the drag, in that window's content area. */
export interface Arrival<W> extends LocalPoint {
  readonly window: W
  /** The width of `window`'s content area when it arrived. */
  readonly width: number
}

export type LocalDrop<W> =
  | { readonly kind: 'split', readonly zone: Zone }
  | { readonly kind: 'move', readonly window: W, readonly index: number }
  | { readonly kind: 'stay' }
  | { readonly kind: 'window' }

export interface LocalDropInput<W> {
  /** Where the pointer was let go, in the source window. */
  readonly client: LocalPoint
  /** The source window's content area. */
  readonly content: { readonly width: number }
  /** The height of a window's tab strip and toolbar, where a tab can be dropped. */
  readonly topHeight: number
  /** The split edge the pointer was on, if any. */
  readonly zone: Zone | null
  readonly arrival: Arrival<W> | null
  /** The place in `window`'s strip for a tab let go `x` pixels from the left of its content area. */
  readonly slotOf: (window: W, x: number) => number
}

function inTopRows (point: LocalPoint, width: number, topHeight: number): boolean {
  return point.x >= 0 && point.x < width && point.y >= 0 && point.y < topHeight
}

/** A split edge splits. Another window's strip, if that window saw the pointer arrive on it, takes the tab at
 * the slot under the pointer. The source's own strip and toolbar do nothing. Anything else, including the
 * source's own page and the space around every window, is a window of its own. */
export function planLocalDrop<W> (input: LocalDropInput<W>): LocalDrop<W> {
  const { client, content, topHeight, zone, arrival, slotOf } = input
  if (zone !== null) return { kind: 'split', zone }
  if (arrival !== null && inTopRows(arrival, arrival.width, topHeight)) return { kind: 'move', window: arrival.window, index: slotOf(arrival.window, arrival.x) }
  if (inTopRows(client, content.width, topHeight)) return { kind: 'stay' }
  return { kind: 'window' }
}

/** How long before a drop an arrival still counts: the other window sees the pointer in the same millisecond the
 * source sees it let go, give or take the two messages to main. */
export const ARRIVAL_FRESH_MS = 150
/** How long a drop waits for an arrival that has not come yet. */
export const ARRIVAL_WAIT_MS = 150

export interface ArrivalClock {
  now: () => number
  /** Calls `fn` after `ms` and returns what cancels it. */
  after: (ms: number, fn: () => void) => () => void
}

/** The arrivals of one drag. Only the first of each window is kept: later ones are the pointer moving about
 * a window it was already seen in. */
export class ArrivalBook<W> {
  private readonly seen = new Map<W, { arrival: Arrival<W>, at: number }>()
  private waiting: Array<(arrival: Arrival<W> | null) => void> = []

  constructor (private readonly clock: ArrivalClock) {}

  record (arrival: Arrival<W>): void {
    if (this.seen.has(arrival.window)) return
    this.seen.set(arrival.window, { arrival, at: this.clock.now() })
    const answer = this.waiting
    this.waiting = []
    for (const resolve of answer) resolve(arrival)
  }

  /** The latest arrival that is still fresh, or null. */
  fresh (): Arrival<W> | null {
    const now = this.clock.now()
    let best: { arrival: Arrival<W>, at: number } | null = null
    for (const entry of this.seen.values()) {
      if (now - entry.at <= ARRIVAL_FRESH_MS && (best === null || entry.at >= best.at)) best = entry
    }
    return best?.arrival ?? null
  }

  /** Resolves with a fresh arrival at once, else with the next one, else with null after `ms`. */
  async settle (ms = ARRIVAL_WAIT_MS): Promise<Arrival<W> | null> {
    const known = this.fresh()
    if (known !== null) return known
    return await new Promise((resolve) => {
      let cancel: () => void = () => {}
      const done = (arrival: Arrival<W> | null): void => {
        cancel()
        this.waiting = this.waiting.filter((waiter) => waiter !== done)
        resolve(arrival)
      }
      this.waiting.push(done)
      cancel = this.clock.after(ms, () => { done(null) })
    })
  }

  clear (): void {
    this.seen.clear()
    const answer = this.waiting
    this.waiting = []
    for (const resolve of answer) resolve(null)
  }
}

/** The point the drag's preview follows, or null where it is not shown: over the source window's own page, away
 * from every split edge (a split preview shows there instead) and from the strip and toolbar (where letting go
 * does nothing). Outside the window the cursor is all there is. */
export function ghostPointFor (client: LocalPoint, content: { readonly width: number, readonly height: number }, topHeight: number, inZone: boolean): LocalPoint | null {
  if (inZone) return null
  return client.x >= 0 && client.x < content.width && client.y >= topHeight && client.y < content.height ? client : null
}
