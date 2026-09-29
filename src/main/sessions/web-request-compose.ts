// Pure ordering/composition for one Electron webRequest event, shared by
// every session's single owner (./web-request-owner.ts). No `electron`
// import: this file knows nothing about Session, WebRequest or any real
// listener shape, only "handlers, in order, threading a result forward."
// See ./README.md's Design notes for why one owner per (session, event)
// exists at all.

/**
 * One registered handler for one event on one session. Lower `order` runs
 * first; `matches` is checked against the request's own URL, since the
 * owner itself never registers Electron's own `{ urls }` filter -- a
 * second `{ urls }` filter on the same event would silently narrow every
 * OTHER handler's own reach, not just this one's.
 */
export interface OrderedHandler<Details, Result> {
  readonly order: number
  readonly matches: (url: string) => boolean
  readonly run: (details: Details, soFar: Result) => Result | Promise<Result>
}

function sorted<Details, Result> (
  handlers: ReadonlyArray<OrderedHandler<Details, Result>>,
  url: string
): ReadonlyArray<OrderedHandler<Details, Result>> {
  return handlers.filter((handler) => handler.matches(url)).slice().sort((a, b) => a.order - b.order)
}

/**
 * Runs `handlers` for `details` in order, threading each one's result to
 * the next -- what `onBeforeSendHeaders`/`onHeadersReceived` both need
 * ("each handler receives the headers as left by the previous one").
 * `isTerminal` stops the chain early: an `onBeforeRequest` handler's
 * `cancel`/`redirectURL` wins outright, and either header event's own
 * `cancel` does the same, so a later handler is never asked to modify a
 * request that is not going to happen.
 *
 * A handler that throws, or whose promise rejects, is logged (`onError`)
 * and treated as "no opinion": the chain continues from whatever the
 * PREVIOUS handler left, never from a half-applied result of the failing
 * one -- so one broken handler cannot corrupt what an earlier, working one
 * already decided, and the caller always gets a well-formed `Result` back,
 * never a thrown error.
 */
export async function composeWebRequest<Details, Result> (
  handlers: ReadonlyArray<OrderedHandler<Details, Result>>,
  details: Details,
  url: string,
  seed: Result,
  isTerminal: (result: Result) => boolean,
  onError: (error: unknown, order: number) => void
): Promise<Result> {
  let current = seed
  for (const handler of sorted(handlers, url)) {
    try {
      const next = await handler.run(details, current)
      current = next
    } catch (error) {
      onError(error, handler.order)
      continue
    }
    if (isTerminal(current)) return current
  }
  return current
}
