interface Waiter {
  readonly grant: () => void
}

/**
 * At most `limit` tasks at once; the rest wait their turn in order.
 *
 * A slot a finishing task frees is handed to the next WAITER directly
 * (`release`, below), never freed and then re-taken by whoever calls `run`
 * next. Freeing it first would let it count as free while the waiter it was
 * meant for is still an unsettled promise (its own `active++` would run only
 * once its `await` resumes, a microtask after `release`), so a brand-new
 * caller arriving inside that window could take it too, and both would hold
 * one slot. `../../loader/reach/slots.ts`'s `createReachSlotPool` does the
 * same: the releaser adjusts the count for whoever it hands the slot to, in
 * the same synchronous step.
 *
 * `signal`, if given to `run`, lets a QUEUED caller give up: aborting it
 * removes the waiter from the queue and rejects with `signal.reason`,
 * without ever having held a slot. Used by a hedged gateway attempt whose
 * sibling already answered -- the loser is removed from the queue rather
 * than run at all once nothing needs it.
 */
export class Slots {
  private active = 0
  private readonly waiting: Waiter[] = []

  constructor (private readonly limit: number) {}

  /** True if `run` would start its task immediately right now, with no
   * queueing -- a scheduler choosing between several pools (gateways.ts's
   * `candidates()`) reads this to prefer one with room over one that is
   * merely usable. */
  get free (): boolean {
    return this.active < this.limit && this.waiting.length === 0
  }

  private release (): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.active--
      return
    }
    // The count is unchanged: one task's slot becomes the very next task's,
    // in the same step, with no window where it is merely "free".
    next.grant()
  }

  async run<T> (task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) throw signal.reason
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = this.waiting.indexOf(waiter)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(signal?.reason)
        }
        const waiter: Waiter = {
          grant: () => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(waiter)
      })
    } else {
      this.active++
    }
    try {
      return await task()
    } finally {
      this.release()
    }
  }
}
