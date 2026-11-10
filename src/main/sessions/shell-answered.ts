// Which main-frame document the shell answered. The verifier's server marks every response the shell answered
// (`loader/fetch/content-root.ts`, `SHELL_ANSWERED_HEADER`); the response watch of each website session
// (`../verifier/partition-stamp.ts`) notes the mark of the main frame's last response here, and the commit of that
// document takes it once (`./session-attribution.ts`). Per page, never for a worker or a frame inside one: only a
// document that is a page's own can be attributed. A commit no response was seen for (a service worker answered it) is
// told apart from one the network or the HTTP cache answered, so the caller can ask the document's own worker.

interface Answered {
  readonly url: string
  readonly answered: boolean
}

const lastResponse = new WeakMap<object, Answered>()

/** The address without a fragment, which a response never has and a commit may: the document is the same. */
function documentUrl (url: string): string | undefined {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return undefined
  }
}

/** The main frame of `page` was answered at `url`, by the shell or not; the last response is the document that commits. */
export function noteMainFrameResponse (page: object, url: string, answered: boolean): void {
  const at = documentUrl(url)
  if (at === undefined) lastResponse.delete(page)
  else lastResponse.set(page, { url: at, answered })
}

/** A navigation of `page` starts: a commit with no response of its own (the HTTP cache, a service worker) is not the earlier one's. */
export function forgetShellAnswered (page: object): void {
  lastResponse.delete(page)
}

/** What answered a document: the shell's handler, the network or the HTTP cache (or a response for another address), or nothing the session saw. */
export type MainFrameAnswer = 'shell' | 'other' | 'none'

/** What answered the document of `page` that committed at `url`; asked once per commit. `none` is a commit no response came for. */
export function takeMainFrameAnswer (page: object, url: string): MainFrameAnswer {
  const noted = lastResponse.get(page)
  lastResponse.delete(page)
  if (noted === undefined) return 'none'
  const at = documentUrl(url)
  return noted.answered && at !== undefined && noted.url === at ? 'shell' : 'other'
}
