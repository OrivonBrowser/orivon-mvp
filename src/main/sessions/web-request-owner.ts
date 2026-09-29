// One owner per (Session, webRequest event). Electron keeps exactly one
// listener per event per session -- a second `session.webRequest.onXxx(...)`
// call for a session that already has one SILENTLY REPLACES it, with no
// warning -- so any two features that each called Electron's own
// `onBeforeRequest`/`onBeforeSendHeaders`/`onHeadersReceived` directly on
// the same session would fight over which one actually runs, and whoever
// registered last would win. `webRequestOwnerFor(session)` is the one place
// that ever calls those three methods on a session it covers; everyone else
// registers a handler with it instead, and ./web-request-compose.ts is what
// actually combines them. See README.md's Design notes for which sessions
// still register directly (never this one), and for why each handler also
// declares a `WebRequestFilter` rather than leaving Electron's own listener
// unfiltered.

import type { Session, WebRequestFilter } from 'electron'
import type {
  CallbackResponse, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails
} from 'electron'
import { composeWebRequest } from './web-request-compose.js'
import type { OrderedHandler } from './web-request-compose.js'

/** Registered last among an event's handlers, when nothing else about
 * order matters: the verifier's partition stamp and the granted-origin CSP
 * both need to run after anything else that may have touched the same
 * headers first. Two handlers both registered at RUN_LAST run in the order
 * they were registered (composeWebRequest's own stable sort). */
export const RUN_LAST = Number.MAX_SAFE_INTEGER

/** The composed result of every `onBeforeSendHeaders` handler on one
 * session: narrower than Electron's own `BeforeSendResponse` (whose
 * `requestHeaders` also allows `string[]` values, which
 * `OnBeforeSendHeadersListenerDetails.requestHeaders` never actually is) so
 * a handler never has to re-check a shape Electron itself never sends. */
export interface RequestHeadersResult {
  readonly cancel?: boolean
  readonly requestHeaders: Record<string, string>
}

/** The composed result of every `onHeadersReceived` handler on one session. */
export interface ResponseHeadersResult {
  readonly cancel?: boolean
  readonly responseHeaders: Record<string, string[]>
  readonly statusLine?: string
}

export type BeforeRequestHandler = OrderedHandler<OnBeforeRequestListenerDetails, CallbackResponse>['run']
export type BeforeSendHeadersHandler = OrderedHandler<OnBeforeSendHeadersListenerDetails, RequestHeadersResult>['run']
export type HeadersReceivedHandler = OrderedHandler<OnHeadersReceivedListenerDetails, ResponseHeadersResult>['run']

export interface WebRequestOwner {
  readonly onBeforeRequest: (order: number, filter: WebRequestFilter, matches: (url: string) => boolean, run: BeforeRequestHandler) => void
  readonly onBeforeSendHeaders: (order: number, filter: WebRequestFilter, matches: (url: string) => boolean, run: BeforeSendHeadersHandler) => void
  readonly onHeadersReceived: (order: number, filter: WebRequestFilter, matches: (url: string) => boolean, run: HeadersReceivedHandler) => void
}

function logHandlerError (event: string, error: unknown, order: number): void {
  console.error(`[web-request-owner] a ${event} handler (order ${String(order)}) failed; passing the request through as the previous handler left it`, error)
}

const requestCancelledOrRedirected = (result: CallbackResponse): boolean => result.cancel === true || result.redirectURL !== undefined
const cancelled = (result: { cancel?: boolean }): boolean => result.cancel === true

/**
 * The union of every registered handler's own `WebRequestFilter`, the
 * filter Electron's own listener is (re-)registered with -- README.md's
 * Design notes. `urls`: `<all_urls>` in ANY handler's filter dominates,
 * since it is already broader than anything else could add; otherwise the
 * plain union of every pattern, deduplicated. `types`: an ABSENT `types` in
 * any handler's filter means that handler needs every type, which also
 * dominates -- the union then omits `types` entirely (Electron's own
 * meaning for "no restriction"), never a partial list that would silently
 * narrow a handler that asked for everything.
 */
function unionFilter (filters: readonly WebRequestFilter[]): WebRequestFilter {
  const urls = filters.some((f) => f.urls.includes('<all_urls>'))
    ? ['<all_urls>']
    : [...new Set(filters.flatMap((f) => f.urls))]
  if (filters.some((f) => f.types === undefined)) return { urls }
  const types = [...new Set(filters.flatMap((f) => f.types ?? []))] as NonNullable<WebRequestFilter['types']>
  return { urls, types }
}

interface Registered<Details, Result> extends OrderedHandler<Details, Result> {
  readonly filter: WebRequestFilter
}

function makeOwner (target: Session): WebRequestOwner {
  const beforeRequest: Array<Registered<OnBeforeRequestListenerDetails, CallbackResponse>> = []
  const beforeSendHeaders: Array<Registered<OnBeforeSendHeadersListenerDetails, RequestHeadersResult>> = []
  const headersReceived: Array<Registered<OnHeadersReceivedListenerDetails, ResponseHeadersResult>> = []

  function registerBeforeRequest (): void {
    target.webRequest.onBeforeRequest(unionFilter(beforeRequest.map((h) => h.filter)), (details, callback) => {
      const seed: CallbackResponse = {}
      composeWebRequest(beforeRequest, details, details.url, seed, requestCancelledOrRedirected, (error, handlerOrder) => {
        logHandlerError('onBeforeRequest', error, handlerOrder)
      }).then((result) => { callback(result === seed ? {} : result) }, (error: unknown) => {
        logHandlerError('onBeforeRequest', error, -1)
        callback({})
      })
    })
  }

  function registerBeforeSendHeaders (): void {
    target.webRequest.onBeforeSendHeaders(unionFilter(beforeSendHeaders.map((h) => h.filter)), (details, callback) => {
      const seed: RequestHeadersResult = { requestHeaders: details.requestHeaders }
      composeWebRequest(beforeSendHeaders, details, details.url, seed, cancelled, (error, handlerOrder) => {
        logHandlerError('onBeforeSendHeaders', error, handlerOrder)
      // A result identical to `seed` (no handler that ran produced a new
      // object) answers with a bare `{}`, never a seeded header set --
      // README.md's Design notes: a `{}` answer leaves Electron's own
      // request untouched, while resending `requestHeaders` as data (even
      // unchanged) is Electron's signal to REPLACE them.
      }).then((result: RequestHeadersResult) => { callback(result === seed ? {} : result) }, (error: unknown) => {
        logHandlerError('onBeforeSendHeaders', error, -1)
        callback({})
      })
    })
  }

  function registerHeadersReceived (): void {
    target.webRequest.onHeadersReceived(unionFilter(headersReceived.map((h) => h.filter)), (details, callback) => {
      const seed: ResponseHeadersResult = { responseHeaders: details.responseHeaders ?? {} }
      composeWebRequest(headersReceived, details, details.url, seed, cancelled, (error, handlerOrder) => {
        logHandlerError('onHeadersReceived', error, handlerOrder)
      // Same "unchanged -> bare {}" rule as onBeforeSendHeaders above: a
      // response whose `details.responseHeaders` was undefined must not be
      // answered with an explicit empty header set, which Electron reads as
      // "strip everything" rather than "nothing to say."
      }).then((result: ResponseHeadersResult) => { callback(result === seed ? {} : result) }, (error: unknown) => {
        logHandlerError('onHeadersReceived', error, -1)
        callback({})
      })
    })
  }

  return {
    onBeforeRequest (order, filter, matches, run) {
      beforeRequest.push({ order, matches, run, filter })
      registerBeforeRequest()
    },
    onBeforeSendHeaders (order, filter, matches, run) {
      beforeSendHeaders.push({ order, matches, run, filter })
      registerBeforeSendHeaders()
    },
    onHeadersReceived (order, filter, matches, run) {
      headersReceived.push({ order, matches, run, filter })
      registerHeadersReceived()
    }
  }
}

const owners = new WeakMap<Session, WebRequestOwner>()

/** The one owner for `target` -- the same object on every call, so two
 * callers registering on the same session compose through it instead of
 * one silently replacing the other's Electron listener. Each of the three
 * Electron listeners is (re-)registered every time a handler is added for
 * that event, with the union of every registered handler's own
 * `WebRequestFilter` (`unionFilter` above) -- never left unfiltered, and
 * never narrower than what any one handler already declared it needs. */
export function webRequestOwnerFor (target: Session): WebRequestOwner {
  let owner = owners.get(target)
  if (owner === undefined) {
    owner = makeOwner(target)
    owners.set(target, owner)
  }
  return owner
}
