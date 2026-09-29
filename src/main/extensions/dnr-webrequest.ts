// Applies a DnrEngine's decisions to real requests on session.defaultSession,
// through the single webRequest owner (../sessions/web-request-owner.ts) --
// never a direct session.webRequest.onXxx call (../sessions/README.md's
// Design notes: a second direct registration would silently replace
// whichever handler on that event registered first).

import type {
  CallbackResponse,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session,
  WebFrameMain,
} from 'electron'
import {
  RUN_LAST,
  webRequestOwnerFor,
  type RequestHeadersResult,
  type ResponseHeadersResult,
} from '../sessions/web-request-owner.js'
import type { DnrEngine } from './dnr/dnr-engine.js'
import { mapElectronResourceType, type ElectronResourceType } from './dnr/resource-types.js'
import type { DnrDecision, DnrModifyOps, DnrRequest } from './dnr/types.js'
import { recordMatches } from './dnr-match-log.js'

/**
 * Strictly before `RUN_LAST` (the verifier's partition stamp,
 * `../verifier/verifier-subsystem.ts`; the granted-origin CSP,
 * `../install/granted-origin-csp.ts`) -- an extension rule must never be
 * able to remove or alter either, so both keep running last, after this.
 * Any value below `RUN_LAST` satisfies that; this one leaves generous room
 * below it for a future handler that must still run after extension rules.
 */
const EXTENSION_ORDER = 1000

/** Never `chrome-extension:`/`orivon:`. The URLs a
 * `webRequest` listener actually sees for those schemes are an extension's
 * own resource loads and Orivon's internal pages, neither of which another
 * extension's rules should touch. */
function isInScopeUrl(url: string): boolean {
  return !url.startsWith('chrome-extension:') && !url.startsWith('orivon:')
}

/** Exported for tests (this file's own doc on the mapping); not used by
 * anything outside dnr-webrequest.ts otherwise. */
export function frameIdOf(frame: WebFrameMain): number {
  // Chrome numbers a page's own top frame 0; frameTreeNodeId is Electron's
  // closest stable per-frame id otherwise (dnr/README.md has no opinion on
  // this since the pure engine never sees a WebFrameMain at all -- this is
  // this file's own mapping).
  return frame.parent === null ? 0 : frame.frameTreeNodeId
}

export function parentFrameIdOf(frame: WebFrameMain): number | undefined {
  return frame.parent === null ? undefined : frameIdOf(frame.parent)
}

/** `details.frame` can throw when read after the frame navigated away or
 * was destroyed (Electron's own doc on the field; `../verifier/
 * verifier-subsystem.ts` guards the same read the same way). */
function safeFrame(details: { frame?: WebFrameMain | null }): WebFrameMain | null {
  try {
    return details.frame ?? null
  } catch {
    return null
  }
}

/** The origin of the frame that made the request -- for a subresource or
 * sub_frame load, `frame` already IS the requesting document; for a
 * main_frame navigation, `frame.origin` still reads the PREVIOUS document's
 * origin at this point (the new one has not committed), which is what
 * Chrome's own `initiator` means for a navigation. `"null"` (Chrome's own
 * serialization of an opaque origin) and `""` both mean "no usable
 * initiator" here. */
export function initiatorOf(frame: WebFrameMain | null): string | undefined {
  if (frame === null) {
    return undefined
  }
  try {
    const origin = frame.origin
    return origin === 'null' || origin === '' ? undefined : origin
  } catch {
    return undefined
  }
}

interface ScopedRequest {
  readonly tabId: number
  readonly dnrRequest: DnrRequest
}

/**
 * `null` for anything out of scope for extension rules: no `webContents` at all
 * (Orivon's own main-process `net.fetch`, the verifier's own requests --
 * neither ever carries `webContentsId`), or a resource type this package's
 * `resource-types.ts` has no Chrome equivalent for (none today: Electron 44
 * has no `webtransport`/`webbundle` resource type to map from).
 */
export function toScopedRequest(details: {
  url: string
  method: string
  resourceType: ElectronResourceType
  webContentsId?: number
  frame?: WebFrameMain | null
}): ScopedRequest | null {
  if (details.webContentsId === undefined) {
    return null
  }
  const frame = safeFrame(details)
  const initiator = initiatorOf(frame)
  const parentFrameId = frame === null ? undefined : parentFrameIdOf(frame)
  return {
    tabId: details.webContentsId,
    dnrRequest: {
      url: details.url,
      method: details.method,
      resourceType: mapElectronResourceType(details.resourceType),
      ...(initiator !== undefined ? { initiator } : {}),
      tabId: details.webContentsId,
      frameId: frame === null ? 0 : frameIdOf(frame),
      ...(parentFrameId !== undefined ? { parentFrameId } : {}),
    },
  }
}

export function toHttpsUrl(url: string): string | null {
  try {
    const httpsUrl = new URL(url)
    if (httpsUrl.protocol !== 'http:') {
      return null
    }
    httpsUrl.protocol = 'https:'
    return httpsUrl.href
  } catch {
    return null
  }
}

export function applyRequestHeaders(base: Record<string, string>, ops: DnrModifyOps | undefined): Record<string, string> {
  if (ops === undefined || ops.length === 0) {
    return base
  }
  const headers = { ...base }
  for (const op of ops) {
    applyHeaderOp(headers, op)
  }
  return headers
}

/** `Record<string, string[]>` shape `onHeadersReceived` uses, vs. the plain
 * `Record<string, string>` `onBeforeSendHeaders` uses -- Electron's own two
 * different `*Response` shapes (`../sessions/web-request-owner.ts`'s
 * `RequestHeadersResult`/`ResponseHeadersResult`). */
export function applyResponseHeaders(
  base: Record<string, string[]>,
  ops: DnrModifyOps | undefined
): Record<string, string[]> {
  if (ops === undefined || ops.length === 0) {
    return base
  }
  const headers = { ...base }
  for (const op of ops) {
    const key = findHeaderKey(headers, op.header) ?? op.header
    if (op.operation === 'remove') {
      delete headers[key]
    } else if (op.operation === 'set' || headers[key] === undefined) {
      headers[key] = op.value === undefined ? [] : [op.value]
    } else {
      // "append": dnr/README.md's own Design notes flag that a real
      // Cookie-header merge separator needs the request's CURRENT value,
      // which this decision does not carry for response headers either
      // (there is no equivalent ambiguity for a response's Set-Cookie,
      // Chrome always adds a new header instance there instead of joining).
      headers[key] = [...headers[key]!, ...(op.value === undefined ? [] : [op.value])]
    }
  }
  return headers
}

function findHeaderKey(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(headers).find((key) => key.toLowerCase() === lower)
}

/** Chrome joins repeated `Cookie` request headers with `"; "`, every other
 * header with `", "` -- dnr/README.md's own Design notes says this decision
 * carries no existing-header state, so this is where that responsibility
 * (stated there as the caller's) is discharged. */
function applyHeaderOp(headers: Record<string, string>, op: { header: string, operation: string, value?: string }): void {
  const key = findHeaderKey(headers, op.header) ?? op.header
  if (op.operation === 'remove') {
    delete headers[key]
    return
  }
  if (op.operation === 'set' || headers[key] === undefined) {
    headers[key] = op.value ?? ''
    return
  }
  const separator = key.toLowerCase() === 'cookie' ? '; ' : ', '
  headers[key] = op.value === undefined ? headers[key] : `${headers[key]}${separator}${op.value}`
}

/** Called once per matched rule from `onBeforeRequest`, for the action-count
 * badge (`declarativeNetRequest.setExtensionActionOptions`) and the
 * `onRuleMatchedDebug` event -- both cross into extension-permission/router
 * territory `dnr-webrequest.ts` itself has no business knowing about, so
 * `extensions-subsystem.ts` supplies the real implementation
 * (`dnr-api.ts`'s `onRuleMatched`); tests and any caller that does not need
 * either get a no-op default. */
export type OnRuleMatched = (tabId: number, info: DnrDecision['matchedRules'][number]) => void

const noopOnRuleMatched: OnRuleMatched = () => {}

/** Installs all three handlers this package owns on `defaultSession`'s
 * webRequest owner. Re-evaluates the same request independently at each of
 * the three phases (a request that is cancelled/redirected at
 * `onBeforeRequest` never reaches the other two, so there is no risk of a
 * decision being "applied twice"): simpler than threading one decision
 * across phases, and the engine is fast enough (dnr/README.md's measured
 * median/p99) that recomputing costs nothing an extension would notice.
 */
export function installDnrWebRequestHandlers(
  defaultSession: Session,
  getEngine: () => DnrEngine | undefined,
  onRuleMatched: OnRuleMatched = noopOnRuleMatched
): void {
  const owner = webRequestOwnerFor(defaultSession)

  owner.onBeforeRequest(EXTENSION_ORDER, isInScopeUrl, (details: OnBeforeRequestListenerDetails, soFar: CallbackResponse): CallbackResponse => {
    const engine = getEngine()
    const scoped = engine === undefined ? null : toScopedRequest(details)
    if (engine === undefined || scoped === null) {
      return soFar
    }
    const decision = engine.evaluate(scoped.dnrRequest)
    recordMatches(scoped.tabId, decision.matchedRules)
    for (const info of decision.matchedRules) {
      onRuleMatched(scoped.tabId, info)
    }
    if (decision.cancel === true) {
      return { cancel: true }
    }
    if (decision.upgradeToHttps === true) {
      const httpsUrl = toHttpsUrl(details.url)
      return httpsUrl === null ? soFar : { redirectURL: httpsUrl }
    }
    if (decision.redirectUrl !== undefined) {
      return { redirectURL: decision.redirectUrl }
    }
    return soFar
  })

  owner.onBeforeSendHeaders(
    EXTENSION_ORDER,
    isInScopeUrl,
    (details: OnBeforeSendHeadersListenerDetails, soFar: RequestHeadersResult): RequestHeadersResult => {
      const engine = getEngine()
      const scoped = engine === undefined ? null : toScopedRequest(details)
      if (engine === undefined || scoped === null) {
        return soFar
      }
      const decision: DnrDecision = engine.evaluate(scoped.dnrRequest)
      if (decision.cancel === true) {
        return { cancel: true, requestHeaders: soFar.requestHeaders }
      }
      return { requestHeaders: applyRequestHeaders(soFar.requestHeaders, decision.requestHeaders) }
    }
  )

  owner.onHeadersReceived(
    EXTENSION_ORDER,
    isInScopeUrl,
    (details: OnHeadersReceivedListenerDetails, soFar: ResponseHeadersResult): ResponseHeadersResult => {
      const engine = getEngine()
      const scoped = engine === undefined ? null : toScopedRequest(details)
      if (engine === undefined || scoped === null) {
        return soFar
      }
      const decision: DnrDecision = engine.evaluate(scoped.dnrRequest)
      if (decision.cancel === true) {
        return { cancel: true, responseHeaders: soFar.responseHeaders }
      }
      return { responseHeaders: applyResponseHeaders(soFar.responseHeaders, decision.responseHeaders) }
    }
  )
}
