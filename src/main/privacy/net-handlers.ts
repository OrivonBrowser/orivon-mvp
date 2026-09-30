// The three web-request handlers of the network privacy controls, as plain
// functions over injected settings and state so each is unit-tested without
// Electron. Each reads its setting on every request and returns what it was
// given when its setting is off, so turning a control on or off needs no
// re-registration. Tied to Electron only through the owner's handler types.
import type { CallbackResponse, OnBeforeRequestListenerDetails, OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, WebContents } from 'electron'
import type { RequestHeadersResult, ResponseHeadersResult } from '../sessions/web-request-owner.js'
import { createThirdPartyMemory, requestIsThirdParty } from './cookie-policy.js'
import type { ThirdPartyMemory } from './cookie-policy.js'
import type { UpgradeTracker } from './https-fallback.js'
import { upgradeTarget } from './https-only.js'
import type { HttpsExemptions } from './https-state.js'
import { withoutCookie, withoutSetCookie, withPrivacySignals } from './privacy-headers.js'

/** The settings these handlers read. */
export interface NetSettings {
  get: (key: 'privacy.cookies' | 'privacy.globalPrivacyControl' | 'privacy.doNotTrack' | 'privacy.httpsOnly') => string | boolean
}

export interface NetHandlerDeps {
  readonly settings: NetSettings
  readonly exemptions: HttpsExemptions
  readonly tracker: UpgradeTracker
  /** A host of this run's developer names: served over plain HTTP on purpose. */
  readonly isDevHost: (host: string) => boolean
  /** An upgrade that came back round to the same address: the page is sending the browser in a circle. */
  readonly loopDetected: (contents: WebContents | undefined, from: string) => void
  readonly thirdParties?: ThirdPartyMemory
}

/** Each one assignable to the owner's handler of the same event; answering synchronously keeps them easy to test. */
export interface NetHandlers {
  readonly beforeRequest: (details: OnBeforeRequestListenerDetails, current: CallbackResponse) => CallbackResponse
  readonly beforeSendHeaders: (details: OnBeforeSendHeadersListenerDetails, current: RequestHeadersResult) => RequestHeadersResult
  readonly headersReceived: (details: OnHeadersReceivedListenerDetails, current: ResponseHeadersResult) => ResponseHeadersResult
}

export function createNetHandlers (deps: NetHandlerDeps): NetHandlers {
  const thirdParties = deps.thirdParties ?? createThirdPartyMemory()
  const blocking = (): boolean => deps.settings.get('privacy.cookies') === 'blockThirdParty'

  const beforeRequest = (details: OnBeforeRequestListenerDetails, current: CallbackResponse): CallbackResponse => {
    if (deps.settings.get('privacy.httpsOnly') !== true || details.resourceType !== 'mainFrame') return current
    const target = upgradeTarget(details.url, (host) => deps.exemptions.has(host) || deps.isDevHost(host))
    if (target === null) return current
    const contentsId = details.webContentsId
    if (contentsId !== undefined && deps.tracker.noteUpgrade(contentsId, details.url, target) === 'loop') {
      deps.loopDetected(details.webContents, details.url)
      return { cancel: true }
    }
    return { redirectURL: target }
  }

  const beforeSendHeaders = (details: OnBeforeSendHeadersListenerDetails, current: RequestHeadersResult): RequestHeadersResult => {
    let requestHeaders = withPrivacySignals(current.requestHeaders, {
      gpc: deps.settings.get('privacy.globalPrivacyControl') === true,
      dnt: deps.settings.get('privacy.doNotTrack') === true
    })
    if (blocking() && requestIsThirdParty(details)) {
      thirdParties.note(details.id)
      requestHeaders = withoutCookie(requestHeaders)
    }
    return requestHeaders === current.requestHeaders ? current : { ...current, requestHeaders }
  }

  const headersReceived = (details: OnHeadersReceivedListenerDetails, current: ResponseHeadersResult): ResponseHeadersResult => {
    if (!blocking() || !(thirdParties.has(details.id) || requestIsThirdParty(details))) return current
    const responseHeaders = withoutSetCookie(current.responseHeaders)
    return responseHeaders === current.responseHeaders ? current : { ...current, responseHeaders }
  }

  return { beforeRequest, beforeSendHeaders, headersReceived }
}
