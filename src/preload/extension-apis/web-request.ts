import type { Crx } from './crx.js'

/**
 * `chrome.webRequest`: the constants and enums the library's object of that
 * name lacks (a blocker builds its listener filter from `ResourceType` while
 * its worker loads), and its nine events, which main serves. A listener is
 * registered with main under a number this context picks; main sends each
 * matching request over the one `webRequest.dispatch` event, and a blocking
 * listener's answer goes back through `webRequest.reply`.
 */
export function webRequestApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  crx.define('webRequest', (base) => {
    const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value)
    const EVENT_NAMES = [
      'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired',
      'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'
    ]
    const listeners = new Map<number, { event: string, callback: unknown }>()
    const addOnMain = crx.call('webRequest.addListener')
    const removeOnMain = crx.call('webRequest.removeListener')
    const replyToMain = crx.call('webRequest.reply')
    let nextListenerId = 1
    let subscribed = false

    const warn = (error: unknown): void => {
      console.error('Unchecked runtime.lastError: ' + (error instanceof Error ? error.message : String(error)))
    }

    /** What main reads of a listener's answer: a cancel, a redirect, or a complete header list. A malformed header list is left out whole. */
    const pick = (answer: any): object | null => {
      if (typeof answer !== 'object' || answer === null) return null
      const picked: Record<string, unknown> = {}
      if (answer.cancel === true) picked.cancel = true
      if (typeof answer.redirectUrl === 'string') picked.redirectUrl = answer.redirectUrl
      for (const key of ['requestHeaders', 'responseHeaders']) {
        if (!Array.isArray(answer[key])) continue
        const list: Array<{ name: string, value?: string, binaryValue?: number[] }> = []
        let sound = true
        for (const header of answer[key]) {
          if (typeof header !== 'object' || header === null || typeof header.name !== 'string') { sound = false; break }
          if (typeof header.value === 'string') list.push({ name: header.name, value: header.value })
          else if (Array.isArray(header.binaryValue)) list.push({ name: header.name, binaryValue: header.binaryValue.slice() })
          else { sound = false; break }
        }
        if (sound) picked[key] = list
      }
      return picked
    }

    const answer = (dispatchId: number, picked: object | null): void => {
      replyToMain(dispatchId, picked).catch(() => {})
    }

    const onDispatch = (listenerId: number, dispatchId: number, details: unknown): void => {
      const entry = listeners.get(listenerId)
      if (entry === undefined || typeof entry.callback !== 'function') {
        // A registration this context no longer holds (the page reloaded): answer at once so the request does not wait.
        if (dispatchId !== 0) answer(dispatchId, null)
        return
      }
      let result: unknown
      try {
        result = entry.callback(details)
      } catch (error) {
        console.error(error)
        if (dispatchId !== 0) answer(dispatchId, null)
        return
      }
      if (dispatchId === 0) return
      Promise.resolve(result).then(pick, (error: unknown) => { console.error(error); return null }).then((picked) => { answer(dispatchId, picked) })
    }

    const makeEvent = (name: string): object => ({
      addListener: (callback: unknown, filter: any, extraInfoSpec?: unknown): void => {
        const signature = 'Error in invocation of webRequest.' + name + '.addListener(function callback, object filter, optional array extraInfoSpec): '
        if (typeof callback !== 'function') throw new TypeError(signature + 'No matching signature.')
        if (typeof filter !== 'object' || filter === null) throw new TypeError(signature + 'No matching signature.')
        for (const entry of listeners.values()) if (entry.event === name && entry.callback === callback) return
        if (!subscribed) {
          subscribed = true
          crx.event('webRequest.dispatch').addListener(onDispatch)
        }
        const listenerId = nextListenerId++
        listeners.set(listenerId, { event: name, callback })
        const sent = { urls: filter.urls, types: filter.types, tabId: filter.tabId, windowId: filter.windowId }
        let registered: Promise<unknown>
        try {
          registered = addOnMain(name, listenerId, sent, Array.isArray(extraInfoSpec) ? extraInfoSpec.slice() : extraInfoSpec)
        } catch (error) {
          listeners.delete(listenerId)
          throw error
        }
        registered.catch((error: unknown) => {
          listeners.delete(listenerId)
          warn(error)
        })
      },
      removeListener: (callback: unknown): void => {
        for (const [listenerId, entry] of [...listeners]) {
          if (entry.event !== name || entry.callback !== callback) continue
          listeners.delete(listenerId)
          removeOnMain(name, listenerId).catch(() => {})
        }
      },
      hasListener: (callback: unknown): boolean => [...listeners.values()].some((entry) => entry.event === name && entry.callback === callback),
      hasListeners: (): boolean => [...listeners.values()].some((entry) => entry.event === name)
    })

    const events: Record<string, object> = {}
    for (const name of EVENT_NAMES) events[name] = makeEvent(name)

    return {
      ...base,
      ...events,
      onActionIgnored: { addListener: () => {}, removeListener: () => {}, hasListener: () => false, hasListeners: () => false },
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      handlerBehaviorChanged: (callback?: unknown): Promise<void> | undefined => {
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
      },
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
