// One origin's third-party reach allowance: how many reach requests it may
// hold open at once (its manifest-declared socket allowance, read live), and
// a bounded FIFO queue for the ones that arrive while every slot is taken.
// A browser queues an over-limit request rather than failing it, and a page
// has no retry for a subresource that answered 404. See README.md's Design
// notes for why a bounded queue here is not the unbounded one T11b forbids.

import type { ReleaseReachSlot, ReserveReachSlot } from './guard.js'

/** How long a queued reach request waits for a slot before it is refused. Provisional. */
export const REACH_SLOT_WAIT_MS = 30_000

/** How many reach requests one origin may have queued at once; one more is refused at once. Provisional. */
export const REACH_SLOT_MAX_WAITERS = 256

export interface ReachSlotPool {
  readonly reserve: ReserveReachSlot
  readonly release: ReleaseReachSlot
}

interface Waiter {
  readonly grant: (granted: boolean) => void
}

/**
 * `limit` is read on every reserve and release, so a changed allowance
 * applies to the next decision. A free slot is reserved synchronously (the
 * check and the increment never straddle an `await`); a queued request
 * resolves `true` once a release hands it a slot, `false` on timeout, abort
 * or a full queue.
 */
export function createReachSlotPool (limit: () => number): ReachSlotPool {
  let inUse = 0
  const waiters: Waiter[] = []

  function dequeue (waiter: Waiter): void {
    const index = waiters.indexOf(waiter)
    if (index !== -1) waiters.splice(index, 1)
  }

  function handOutFreeSlots (): void {
    while (waiters.length > 0 && inUse < limit()) {
      inUse += 1
      waiters.shift()?.grant(true)
    }
  }

  const reserve: ReserveReachSlot = (signal) => {
    // `waiters.length === 0`: a newcomer never takes a slot ahead of the queue.
    if (waiters.length === 0 && inUse < limit()) {
      inUse += 1
      return true
    }
    if (signal?.aborted === true || waiters.length >= REACH_SLOT_MAX_WAITERS) return false

    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => { waiter.grant(false) }
      const timer = setTimeout(() => { waiter.grant(false) }, REACH_SLOT_WAIT_MS)
      // A queued request must not keep the main process alive.
      timer.unref?.()
      const waiter: Waiter = {
        grant: (granted) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          dequeue(waiter)
          resolve(granted)
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  const release: ReleaseReachSlot = () => {
    // Clamped: a mismatched release degrades to an over-strict count, never
    // a negative one a later reserve could exploit.
    inUse = Math.max(0, inUse - 1)
    handOutFreeSlots()
  }

  return { reserve, release }
}
