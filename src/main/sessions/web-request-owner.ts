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
// still register directly (never this one).

import type { Session } from 'electron'
import type {
  BeforeSendResponse, CallbackResponse, HeadersReceivedResponse,
  OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails
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
  readonly onBeforeRequest: (order: number, matches: (url: string) => boolean, run: BeforeRequestHandler) => void
  readonly onBeforeSendHeaders: (order: number, matches: (url: string) => boolean, run: BeforeSendHeadersHandler) => void
  readonly onHeadersReceived: (order: number, matches: (url: string) => boolean, run: HeadersReceivedHandler) => void
}

function logHandlerError (event: string, error: unknown, order: number): void {
  console.error(`[web-request-owner] a ${event} handler (order ${String(order)}) failed; passing the request through as the previous handler left it`, error)
}

const requestCancelledOrRedirected = (result: CallbackResponse): boolean => result.cancel === true || result.redirectURL !== undefined
const cancelled = (result: { cancel?: boolean }): boolean => result.cancel === true

function makeOwner (target: Session): WebRequestOwner {
  const beforeRequest: Array<OrderedHandler<OnBeforeRequestListenerDetails, CallbackResponse>> = []
  const beforeSendHeaders: Array<OrderedHandler<OnBeforeSendHeadersListenerDetails, RequestHeadersResult>> = []
  const headersReceived: Array<OrderedHandler<OnHeadersReceivedListenerDetails, ResponseHeadersResult>> = []

  return {
    onBeforeRequest (order, matches, run) {
      if (beforeRequest.length === 0) {
        target.webRequest.onBeforeRequest((details, callback) => {
          composeWebRequest(beforeRequest, details, details.url, {}, requestCancelledOrRedirected, (error, handlerOrder) => {
            logHandlerError('onBeforeRequest', error, handlerOrder)
          }).then(callback, (error: unknown) => {
            logHandlerError('onBeforeRequest', error, -1)
            callback({})
          })
        })
      }
      beforeRequest.push({ order, matches, run })
    },
    onBeforeSendHeaders (order, matches, run) {
      if (beforeSendHeaders.length === 0) {
        target.webRequest.onBeforeSendHeaders((details, callback) => {
          const seed: RequestHeadersResult = { requestHeaders: details.requestHeaders }
          composeWebRequest(beforeSendHeaders, details, details.url, seed, cancelled, (error, handlerOrder) => {
            logHandlerError('onBeforeSendHeaders', error, handlerOrder)
          }).then(callback as (result: RequestHeadersResult) => void, (error: unknown) => {
            logHandlerError('onBeforeSendHeaders', error, -1)
            callback(seed)
          })
        })
      }
      beforeSendHeaders.push({ order, matches, run })
    },
    onHeadersReceived (order, matches, run) {
      if (headersReceived.length === 0) {
        target.webRequest.onHeadersReceived((details, callback) => {
          const seed: ResponseHeadersResult = { responseHeaders: details.responseHeaders ?? {} }
          composeWebRequest(headersReceived, details, details.url, seed, cancelled, (error, handlerOrder) => {
            logHandlerError('onHeadersReceived', error, handlerOrder)
          }).then(callback as (result: ResponseHeadersResult) => void, (error: unknown) => {
            logHandlerError('onHeadersReceived', error, -1)
            callback(seed)
          })
        })
      }
      headersReceived.push({ order, matches, run })
    }
  }
}

const owners = new WeakMap<Session, WebRequestOwner>()

/** The one owner for `target` -- the same object on every call, so two
 * callers registering on the same session compose through it instead of
 * one silently replacing the other's Electron listener. Each of the three
 * Electron listeners is registered the first time this session is asked
 * for that event (with no `{ urls }` filter: this file's own header says
 * why), never before. */
export function webRequestOwnerFor (target: Session): WebRequestOwner {
  let owner = owners.get(target)
  if (owner === undefined) {
    owner = makeOwner(target)
    owners.set(target, owner)
  }
  return owner
}
