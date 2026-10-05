// The one answer a session gives `getDisplayMedia` once its `media` request was granted. Sessions must not import the
// display-capture gate, so the gate binds its handler here; until then, and for every request it does not take, the
// page gets nothing and its call fails with AbortError.
import type { DisplayMediaRequestHandlerHandlerRequest, Streams } from 'electron'

export type DisplayMediaHandler = (request: DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Streams) => void) => void

let bound: DisplayMediaHandler | undefined

/** Binds the handler that may pick a source, or unbinds with `undefined`. */
export function bindDisplayMediaHandler (handler: DisplayMediaHandler | undefined): void {
  bound = handler
}

/** What `denyByDefault` installs on every session. A handler that throws answers like none. */
export function handleDisplayMedia (request: DisplayMediaRequestHandlerHandlerRequest, callback: (streams: Streams) => void): void {
  if (bound === undefined) { callback({}); return }
  let answered = false
  const answer = (streams: Streams): void => {
    if (answered) return
    answered = true
    callback(streams)
  }
  try {
    bound(request, answer)
  } catch (error) {
    console.error('[display-media] the handler failed:', error)
    answer({})
  }
}
