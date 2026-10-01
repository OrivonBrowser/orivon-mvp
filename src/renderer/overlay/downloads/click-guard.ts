// A page can time a download so the bubble opens, or a file turns "held", just under the pointer, hoping the click it
// lured there lands on a button. A click that early is ignored. Pure: the clock is passed in.
import type { BubbleActionId } from './line.js'

/** How long after a peek opens, or a row turns held, a click on its buttons is ignored. */
export const CLICK_GUARD_MS = 500

export class ClickGuard {
  private peekReadyAt = 0
  private readonly heldReadyAt = new Map<string, number>()

  constructor (private readonly now: () => number, private readonly peek: boolean) {}

  /** The peek has just appeared. */
  shown (): void {
    this.peekReadyAt = this.now() + CLICK_GUARD_MS
  }

  /** The row `id` has just turned held, or has just appeared as one. */
  heldNow (id: string): void {
    this.heldReadyAt.set(id, this.now() + CLICK_GUARD_MS)
  }

  /** Every action in the peek waits for it to settle, and Keep waits for its own row to. */
  allows (action: BubbleActionId | 'open', id: string): boolean {
    const now = this.now()
    if (this.peek && now < this.peekReadyAt) return false
    return action !== 'keep' || now >= (this.heldReadyAt.get(id) ?? 0)
  }
}
