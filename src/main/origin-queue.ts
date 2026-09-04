// A62 (docs/open-questions.md): Loader.load() has no per-origin concurrency
// control -- two tabs hitting the same manifest hint near-simultaneously can
// interleave writeAsset/pruneAssets/writePin calls into a corrupted,
// hash-mismatched on-disk state. That entry's own text assigns the fix to
// "whoever wires Loader.load() into something with real concurrent callers
// (multiple windows/tabs)" -- this file is that fix.
//
// A chained-promise queue keyed by origin is sufficient here, and simpler
// than a real lock: this process has one event loop, so two calls for one
// origin can only INTERLEAVE at an `await` boundary, never truly run at
// once. Chaining each call onto the previous one for the same key closes
// that window completely, with no lock object, no acquire/release pairing
// to get wrong, and no way to forget to release one.

const queues = new Map<string, Promise<unknown>>()

/**
 * Runs `task` after every previously queued task for `origin` has settled
 * (resolved OR rejected -- an earlier failure must not wedge every later
 * call for the same origin), and returns exactly what `task` returns or
 * throws. Two different origins never wait on each other; `queues` holds
 * one chain per origin, never a single global one.
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
 */
export async function withOriginQueue<T> (origin: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(origin) ?? Promise.resolve()
  const chained = prior.then(async () => await task())
  queues.set(origin, chained.then(() => undefined, () => undefined))
  return await chained
}
