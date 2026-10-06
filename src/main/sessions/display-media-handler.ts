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
  let answered = false
  const answer = (streams: Streams): void => {
    if (answered) return
    answered = true
    try {
      callback(streams)
    } catch (error) {
      // Electron reports an answer with no stream by throwing here, and the page's call then fails with AbortError.
      if (Object.keys(streams).length > 0) console.error('[display-media] the answer was refused:', error)
    }
  }
  if (bound === undefined) { answer({}); return }
  try {
    bound(request, answer)
  } catch (error) {
    console.error('[display-media] the handler failed:', error)
    answer({})
  }
}
