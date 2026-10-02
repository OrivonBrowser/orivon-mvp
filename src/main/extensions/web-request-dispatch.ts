// Serves `chrome.webRequest` to extensions on session.defaultSession.
// Chromium's own extension webRequest is stripped from every loaded copy
// (ADR-0043), so an extension's listeners register HERE, over the router,
// and Orivon sends each matching request to the page or worker that holds
// them -- through the one webRequest owner (../sessions/web-request-owner.ts),
// never a direct session.webRequest call. The decisions are pure and live in
// ./web-request/; this file holds the registry, the wire and the waiting.

import type { CallbackResponse, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, ServiceWorkerMain, WebContents, WebRequestFilter } from 'electron'
import type { RequestHeadersResult, ResponseHeadersResult, WebRequestHandlerHandle, WebRequestOwner } from '../sessions/web-request-owner.js'
import { baseDetails, detailsFor, type ElectronRequestDetails, type RequestPayload, type WebRequestDetails } from './web-request/details.js'
import {
  BLOCKING_EVENTS, filterMatches, isWebRequestEvent, parseExtraInfoSpec, parseRequestFilter,
  type ExtraInfoSpec, type RequestFilter, type WebRequestEventName
} from './web-request/filter.js'
import { mergeBeforeRequest, mergeRequestHeaders, mergeResponseHeaders, type Reply } from './web-request/merge.js'
import { requestVisibleTo } from './web-request/visibility.js'
import type { ApiEvent } from './api/api-types.js'

/** After declarativeNetRequest's handlers (1000), so a rule that already
 * cancelled or redirected a request ends the chain before any extension
 * listener is asked; before every `RUN_LAST` handler (the verifier's
 * partition stamp and the granted-origin CSP), which no listener may undo. */
export const WEB_REQUEST_ORDER = 1100

/** How long a blocking request waits for the listeners it asked. A listener
 * that has not answered by then is taken to have no opinion. */
export const BLOCKING_REPLY_TIMEOUT_MS = 10_000

/** The channel the preload's `webRequest.dispatch` event listens on. */
const DISPATCH_CHANNEL = 'crx-webRequest.dispatch'

const OWN_PAGES_ONLY = 'webRequest listeners can be added only from the extension\'s own pages'

const BLOCKING_DENIED = 'You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.'

/** Every URL on the session: what each extension may see is decided per
 * extension, after this. */
const ALL_URLS: WebRequestFilter = { urls: ['<all_urls>'] }

/** The page or worker that registered a listener and gets its requests. */
export type DispatchHost = WebContents | ServiceWorkerMain

/** The events a session reports. `onAuthRequired` is accepted and never fires. */
type OwnerEvent = Exclude<WebRequestEventName, 'onAuthRequired'>

interface Registration {
  readonly extensionId: string
  readonly event: OwnerEvent
  readonly listenerId: number
  readonly host: DispatchHost
  readonly filter: RequestFilter
  readonly spec: ExtraInfoSpec
  readonly installedAt: number
}

interface Pending {
  readonly extensionId: string
  readonly host: DispatchHost
  readonly listenerId: number
  readonly settle: (response: unknown, answered: boolean) => void
}

export interface WebRequestDispatcherDeps {
  readonly owner: WebRequestOwner
  /** Whether `webContentsId` is a tab the shell shows: any other page reports tab -1. */
  readonly isTab: (webContentsId: number) => boolean
  /** The loaded extension's host permissions, parsed once by the caller; undefined once it is gone. */
  readonly hostPermissionsOf: (extensionId: string) => readonly string[] | undefined
  readonly hostAccess: (extensionId: string, hostPermissions: readonly string[], url: string, tabId: number | undefined) => boolean
  /** A registered app's origin: no extension sees a request that touches one. */
  readonly isAppOrigin: (url: string) => boolean
  /** The current URL of the page `webContentsId` is; undefined when it is gone. */
  readonly pageUrlOf: (webContentsId: number) => string | undefined
  /** Whether the extension holds a permission the loaded copy had stripped. */
  readonly held: (extensionId: string, permission: string) => boolean
  readonly installedAt: (extensionId: string) => number
  readonly timeoutMs?: number
}

export interface WebRequestDispatcher {
  readonly addListener: (event: ApiEvent, name: unknown, listenerId: unknown, filter: unknown, extraInfoSpec: unknown) => void
  readonly removeListener: (event: ApiEvent, name: unknown, listenerId: unknown) => void
  readonly reply: (event: ApiEvent, dispatchId: unknown, response: unknown) => void
  readonly dropExtension: (extensionId: string) => void
  readonly registrationCount: (event: WebRequestEventName) => number
}

/** The preload's answer for a listener it does not hold: exactly `{ gone: true }`. */
function isGone (response: unknown): boolean {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return false
  const keys = Object.keys(response)
  return keys.length === 1 && keys[0] === 'gone' && (response as { gone: unknown }).gone === true
}

function hostOf (event: ApiEvent): DispatchHost {
  if (event.sender === undefined) throw new Error('webRequest listeners need a page or a worker to answer')
  return event.sender
}

export function createWebRequestDispatcher (deps: WebRequestDispatcherDeps): WebRequestDispatcher {
  const timeoutMs = deps.timeoutMs ?? BLOCKING_REPLY_TIMEOUT_MS
  let registrations: Registration[] = []
  const handles = new Map<OwnerEvent, WebRequestHandlerHandle>()
  const pending = new Map<number, Pending>()
  const watchedHosts = new WeakSet<object>()
  const warned = new Set<string>()
  let nextDispatchId = 1

  function warnOnce (extensionId: string, what: string): void {
    const key = `${extensionId}:${what}`
    if (warned.has(key)) return
    warned.add(key)
    console.error(`[webRequest] ${extensionId}: ${what}; the request goes on without its opinion`)
  }

  function settleWhere (match: (entry: Pending) => boolean): void {
    for (const [id, entry] of [...pending]) {
      if (match(entry)) {
        pending.delete(id)
        entry.settle(undefined, false)
      }
    }
  }

  function dropHost (host: DispatchHost): void {
    registrations = registrations.filter((entry) => entry.host !== host)
    settleWhere((entry) => entry.host === host)
    syncOwner()
  }

  /** A page keeps its registrations only while it is the document that made them: a page that is gone, crashed or navigated away from its extension no longer holds the listeners. A host belongs to one extension. */
  function watch (host: DispatchHost, extensionId: string): void {
    if (watchedHosts.has(host)) return
    watchedHosts.add(host)
    if (!('on' in host)) return
    const ownPages = `chrome-extension://${extensionId}/`
    host.once('destroyed', () => { dropHost(host) })
    host.on('render-process-gone', () => { dropHost(host) })
    host.on('did-navigate', (_event, url) => { if (!url.startsWith(ownPages)) dropHost(host) })
  }

  /** The registrations that may hear `url`'s `event`, in registration order. */
  function targetsFor (event: WebRequestEventName, base: WebRequestDetails, fromPage: boolean, pageUrl: string | undefined): Registration[] {
    const visibleTo = new Map<string, boolean>()
    const tabId = base.tabId === -1 ? undefined : base.tabId
    const out: Registration[] = []
    for (const entry of registrations) {
      if (entry.event !== event) continue
      if (isHostGone(entry.host)) continue
      if (!filterMatches(entry.filter, base)) continue
      let visible = visibleTo.get(entry.extensionId)
      if (visible === undefined) {
        // The permission is read per request: a grant taken back stops the events at once.
        const hostPermissions = deps.held(entry.extensionId, 'webRequest') ? deps.hostPermissionsOf(entry.extensionId) : undefined
        visible = hostPermissions !== undefined && requestVisibleTo(
          entry.extensionId,
          { url: base.url, fromPage, type: base.type, initiator: base.initiator, pageUrl },
          (url) => deps.hostAccess(entry.extensionId, hostPermissions, url, tabId),
          deps.isAppOrigin
        )
        visibleTo.set(entry.extensionId, visible)
      }
      if (visible) out.push(entry)
    }
    return out
  }

  function isHostGone (host: DispatchHost): boolean {
    if (!host.isDestroyed()) return false
    dropHost(host)
    return true
  }

  function send (entry: Registration, dispatchId: number, details: unknown): boolean {
    try {
      entry.host.send(DISPATCH_CHANNEL, entry.listenerId, dispatchId, entry.event, details)
      return true
    } catch (error) {
      warnOnce(entry.extensionId, `could not reach a listener (${String(error)})`)
      return false
    }
  }

  function ask (entry: Registration, details: unknown): Promise<Reply | undefined> {
    return new Promise((resolve) => {
      const dispatchId = nextDispatchId++
      const timer = setTimeout(() => {
        pending.delete(dispatchId)
        warnOnce(entry.extensionId, `a blocking listener did not answer within ${String(timeoutMs / 1000)} s`)
        resolve(undefined)
      }, timeoutMs)
      pending.set(dispatchId, {
        extensionId: entry.extensionId,
        host: entry.host,
        listenerId: entry.listenerId,
        settle: (response, answered) => {
          clearTimeout(timer)
          resolve(answered ? { extensionId: entry.extensionId, installedAt: entry.installedAt, response } : undefined)
        }
      })
      if (!send(entry, dispatchId, details)) {
        pending.delete(dispatchId)
        clearTimeout(timer)
        resolve(undefined)
      }
    })
  }

  /** Sends one request's `event` to every listener that may see it and, for
   * a blocking event, gathers what they answer. */
  async function dispatch (event: OwnerEvent, raw: ElectronRequestDetails, payload: RequestPayload, blocking: boolean): Promise<Reply[]> {
    const base = baseDetails(event, raw, deps.isTab)
    const targets = targetsFor(event, base, raw.webContentsId !== undefined, raw.webContentsId === undefined ? undefined : deps.pageUrlOf(raw.webContentsId))
    if (targets.length === 0) return []
    const replies: Array<Promise<Reply | undefined>> = []
    for (const entry of targets) {
      const details = detailsFor(event, base, payload, entry.spec)
      // A listener that has since lost webRequestBlocking is told about the request and not waited for.
      if (blocking && entry.spec.blocking && deps.held(entry.extensionId, 'webRequestBlocking')) replies.push(ask(entry, details))
      else send(entry, 0, details)
    }
    return (await Promise.all(replies)).filter((reply): reply is Reply => reply !== undefined)
  }

  const beforeRequest = async (details: OnBeforeRequestListenerDetails, soFar: CallbackResponse): Promise<CallbackResponse> => {
    const merged = mergeBeforeRequest(await dispatch('onBeforeRequest', details, details, true))
    if (merged === undefined) return soFar
    return 'cancel' in merged ? { ...soFar, cancel: true } : { ...soFar, redirectURL: merged.redirectUrl }
  }

  const beforeSendHeaders = async (details: OnBeforeSendHeadersListenerDetails, soFar: RequestHeadersResult): Promise<RequestHeadersResult> => {
    const merged = mergeRequestHeaders(soFar.requestHeaders, await dispatch('onBeforeSendHeaders', details, { requestHeaders: soFar.requestHeaders }, true))
    if (merged === undefined) return soFar
    return 'cancel' in merged ? { cancel: true, requestHeaders: soFar.requestHeaders } : { requestHeaders: merged.requestHeaders }
  }

  const headersReceived = async (details: OnHeadersReceivedListenerDetails, soFar: ResponseHeadersResult): Promise<ResponseHeadersResult> => {
    const merged = mergeResponseHeaders(soFar.responseHeaders, await dispatch('onHeadersReceived', details, { responseHeaders: soFar.responseHeaders }, true))
    if (merged === undefined) return soFar
    return 'cancel' in merged ? { cancel: true, responseHeaders: soFar.responseHeaders } : { ...soFar, responseHeaders: merged.responseHeaders }
  }

  /** The owner's observer events share one shape: send and forget. */
  const observe = (event: OwnerEvent) => (details: ElectronRequestDetails): void => {
    dispatch(event, details, details, false).catch((error: unknown) => { console.error(`[webRequest] ${event} could not be dispatched`, error) })
  }

  /** Everything but the extension's own `orivon:` pages is offered; each extension's visibility rules do the rest. */
  const offered = (url: string): boolean => !url.startsWith('orivon:')

  function register (event: OwnerEvent): WebRequestHandlerHandle {
    const { owner } = deps
    switch (event) {
      case 'onBeforeRequest': return owner.onBeforeRequest(WEB_REQUEST_ORDER, ALL_URLS, offered, beforeRequest)
      case 'onBeforeSendHeaders': return owner.onBeforeSendHeaders(WEB_REQUEST_ORDER, ALL_URLS, offered, beforeSendHeaders)
      case 'onHeadersReceived': return owner.onHeadersReceived(WEB_REQUEST_ORDER, ALL_URLS, offered, headersReceived)
      case 'onSendHeaders': return owner.onSendHeaders(ALL_URLS, offered, observe(event))
      case 'onResponseStarted': return owner.onResponseStarted(ALL_URLS, offered, observe(event))
      case 'onBeforeRedirect': return owner.onBeforeRedirect(ALL_URLS, offered, observe(event))
      case 'onCompleted': return owner.onCompleted(ALL_URLS, offered, observe(event))
      case 'onErrorOccurred': return owner.onErrorOccurred(ALL_URLS, offered, observe(event))
    }
  }

  /** An owner handler exists for an event exactly while a listener does. */
  function syncOwner (): void {
    const wanted = new Set(registrations.map((entry) => entry.event))
    for (const [event, handle] of [...handles]) {
      if (!wanted.has(event)) {
        handle.remove()
        handles.delete(event)
      }
    }
    for (const event of wanted) {
      if (!handles.has(event)) handles.set(event, register(event))
    }
  }

  return {
    addListener (event, name, listenerId, filter, extraInfoSpec) {
      if (!isWebRequestEvent(name)) throw new Error(`webRequest.${String(name)} is not an event`)
      if (typeof listenerId !== 'number' || !Number.isInteger(listenerId)) throw new Error('webRequest.addListener needs a listener id')
      const parsedFilter = parseRequestFilter(filter)
      if (!parsedFilter.ok) throw new Error(parsedFilter.error)
      const parsedSpec = parseExtraInfoSpec(name, extraInfoSpec)
      if (!parsedSpec.ok) throw new Error(parsedSpec.error)
      // Orivon never asks for credentials through an extension: the call is valid and the listener never fires.
      if (name === 'onAuthRequired') return
      const extensionId = event.extension.id
      if (parsedSpec.value.blocking && !(BLOCKING_EVENTS.has(name) && deps.held(extensionId, 'webRequestBlocking') && event.extension.manifest.manifest_version === 2)) {
        throw new Error(BLOCKING_DENIED)
      }
      const host = hostOf(event)
      // `send` reaches a page's main frame only, so a listener added from a frame inside some other page would be answered by that page.
      if ('getURL' in host && !host.getURL().startsWith(`chrome-extension://${extensionId}/`)) throw new Error(OWN_PAGES_ONLY)
      watch(host, extensionId)
      registrations = registrations.filter((entry) => !(entry.host === host && entry.listenerId === listenerId))
      registrations.push({ extensionId, event: name, listenerId, host, filter: parsedFilter.value, spec: parsedSpec.value, installedAt: deps.installedAt(extensionId) })
      syncOwner()
    },

    removeListener (event, name, listenerId) {
      const host = event.sender
      if (host === undefined || !isWebRequestEvent(name)) return
      registrations = registrations.filter((entry) => !(entry.host === host && entry.listenerId === listenerId && entry.event === name && entry.extensionId === event.extension.id))
      syncOwner()
    },

    reply (event, dispatchId, response) {
      if (typeof dispatchId !== 'number') return
      const entry = pending.get(dispatchId)
      if (entry === undefined || entry.extensionId !== event.extension.id || entry.host !== event.sender) return
      pending.delete(dispatchId)
      if (isGone(response)) {
        // The page no longer holds this listener: forget it and go on without its opinion.
        registrations = registrations.filter((held) => !(held.host === entry.host && held.listenerId === entry.listenerId))
        syncOwner()
        entry.settle(undefined, false)
        return
      }
      entry.settle(response, true)
    },

    dropExtension (extensionId) {
      registrations = registrations.filter((entry) => entry.extensionId !== extensionId)
      settleWhere((entry) => entry.extensionId === extensionId)
      syncOwner()
    },

    registrationCount: (event) => registrations.filter((entry) => entry.event === event).length
  }
}
