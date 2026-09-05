// A62 (docs/open-questions.md) names two hazards in Loader.load()'s on-disk
// writes: (1) nothing serializes concurrent load() calls for the same
// origin, and (2) nodeLoaderStorage's writes are not atomic (no
// temp-file-then-rename, no fsync), which can also leave a half-written
// file if the process dies mid-write. This file closes only (1); (2) is
// still open.
//
// A chained-promise queue keyed by origin is sufficient for (1), and
// simpler than a real lock: this process has one event loop, so two calls
// for one origin can only INTERLEAVE at an `await` boundary, never truly
// run at once. Chaining each call onto the previous one for the same key
// closes that window completely, with no lock object, no acquire/release
// pairing to get wrong, and no way to forget to release one.

import { AsyncLocalStorage } from 'node:async_hooks'

const queues = new Map<string, Promise<unknown>>()

/**
 * The origins whose task is an ANCESTOR of the code executing right now --
 * e.g. while a task for origin A awaits a nested `withOriginQueue` call for
 * origin B, code running inside B's task sees `['A', 'B']`. This is NOT the
 * same thing as "some task for this origin happens to be running somewhere
 * right now": an ordinary second caller for an origin that already has a
 * task in flight (the whole point of this module) runs with an EMPTY chain,
 * because it is not nested inside that task's own execution. Only a task
 * calling back into `withOriginQueue` for an origin already in its own
 * chain is re-entrancy -- that call's own settlement is queued behind a
 * chain link that cannot resolve until the call itself does.
 */
const runningChain = new AsyncLocalStorage<readonly string[]>()

/**
 * Runs `task` after every previously queued task for `origin` has settled
 * (resolved OR rejected -- an earlier failure must not wedge every later
 * call for the same origin), and returns exactly what `task` returns or
 * throws. Two different origins never wait on each other; `queues` holds
 * one chain per origin, never a single global one.
 *
 * `origin` MUST already be canonical -- e.g. the return value of
 * `originFromUrl` (`src/broker/policy/origin.ts`). This function does not
 * normalize it: `'https://X.example'`, `'https://x.example'` and
 * `'https://x.example:443'` would otherwise queue separately and never
 * serialize against each other, silently reopening the exact interleaving
 * this function exists to close.
 *
 * Throws, rather than deadlocking, if `task` calls back into
 * `withOriginQueue` for this same origin -- directly or transitively --
 * while still running. See `runningChain`, above.
 *
 * What's stored back into `queues` is deliberately NOT `chained` itself, but
 * a version that never rejects (`.then(ok, ok)`) -- `prior` is therefore
 * always a resolving promise, which is what makes a failed task unable to
 * wedge the next one: there is nothing here for the next call's `.then` to
 * reject FROM. Without this, a rejected `chained` left in the map would
 * also become an unhandled rejection the moment nothing else still held a
 * reference to it, once whatever queued after it moved the map entry along.
 * The real result or error still reaches this call's own caller via
 * `chained` itself, returned/awaited below, never swallowed by any of this.
 *
 * Once this call's own chain settles, its entry is removed from `queues` --
 * but only if it is STILL the current entry for `origin`. A later call may
 * already have replaced it by the time this runs, and deleting
 * unconditionally would drop that still-in-flight replacement, reopening
 * this file's own interleaving bug for whatever calls next.
 */
export async function withOriginQueue<T> (origin: string, task: () => Promise<T>): Promise<T> {
  const chain = runningChain.getStore() ?? []
  if (chain.includes(origin)) {
    throw new Error(
      `withOriginQueue: re-entrant call for origin ${origin} -- a task must not call ` +
      'withOriginQueue again for an origin it is already running under, or its own settlement ' +
      'would wait on a call that is queued behind it'
    )
  }

  const prior = queues.get(origin) ?? Promise.resolve()
  const chained = prior.then(async () => await runningChain.run([...chain, origin], task))
  const settled = chained.then(() => undefined, () => undefined)
  queues.set(origin, settled)
  void settled.then(() => {
    if (queues.get(origin) === settled) queues.delete(origin)
  })
  return await chained
}

/**
 * True if `origin` currently has a live queue entry -- a task running, or
 * still chained behind one. Test-only introspection: production code never
 * needs this, since the whole point of `withOriginQueue` is that a caller
 * never has to know whether it is first in line.
 */
export function hasQueuedOrigin (origin: string): boolean {
  return queues.has(origin)
}
