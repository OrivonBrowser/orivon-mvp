import type { Crx } from './crx.js'

/**
 * The constants and enums of `chrome.webRequest`, over the library's object of
 * that name, which carries the events and none of these. A blocker builds its
 * listener filter from `webRequest.ResourceType` while its service worker
 * loads, so without it the worker fails before registering anything. The events
 * stay inert: main never dispatches a webRequest listener (blocking is
 * declarativeNetRequest's job here).
 */
export function webRequestApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  crx.define('webRequest', (base) => {
    const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value)
    return {
      ...base,
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      handlerBehaviorChanged: async () => {},
      ResourceType: frozen({
        MAIN_FRAME: 'main_frame',
        SUB_FRAME: 'sub_frame',
        STYLESHEET: 'stylesheet',
        SCRIPT: 'script',
        IMAGE: 'image',
        FONT: 'font',
        OBJECT: 'object',
        XMLHTTPREQUEST: 'xmlhttprequest',
        PING: 'ping',
        CSP_REPORT: 'csp_report',
        MEDIA: 'media',
        WEBSOCKET: 'websocket',
        WEBBUNDLE: 'webbundle',
        OTHER: 'other'
      }),
      OnBeforeRequestOptions: frozen({ BLOCKING: 'blocking', REQUEST_BODY: 'requestBody', EXTRA_HEADERS: 'extraHeaders' }),
      OnBeforeSendHeadersOptions: frozen({ BLOCKING: 'blocking', REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' }),
      OnSendHeadersOptions: frozen({ REQUEST_HEADERS: 'requestHeaders', EXTRA_HEADERS: 'extraHeaders' }),
      OnHeadersReceivedOptions: frozen({ BLOCKING: 'blocking', RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' }),
      OnAuthRequiredOptions: frozen({ RESPONSE_HEADERS: 'responseHeaders', BLOCKING: 'blocking', ASYNC_BLOCKING: 'asyncBlocking', EXTRA_HEADERS: 'extraHeaders' }),
      OnResponseStartedOptions: frozen({ RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' }),
      OnBeforeRedirectOptions: frozen({ RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' }),
      OnCompletedOptions: frozen({ RESPONSE_HEADERS: 'responseHeaders', EXTRA_HEADERS: 'extraHeaders' })
    }
  })
}
