import { describe, expect, it, vi } from 'vitest'
import { webRequestApi } from '../web-request.js'

interface Harness {
  readonly api: Record<string, any>
  /** Every `crx.call(name)(...args)` made, in order. */
  readonly calls: Array<{ name: string, args: unknown[] }>
  /** What main sends over `webRequest.dispatch`. */
  readonly dispatch: (listenerId: number, dispatchId: number, details: unknown) => void
  /** Settles when main's next `webRequest.addListener` call is answered. */
  readonly failNextAdd: (message: string) => void
  readonly subscriptions: () => number
}

/** What the entry defines on `chrome.webRequest`, rebuilt from its source text as the library runs it, against a fake `__crx`. */
function harness (): Harness {
  const rebuilt = new Function(`return (${webRequestApi.toString()})`)() as () => void
  const calls: Array<{ name: string, args: unknown[] }> = []
  let dispatchListener: ((...args: unknown[]) => void) | undefined
  let subscriptions = 0
  let failure: string | undefined
  let api: Record<string, any> = {}
  const crx = {
    call: (name: string) => async (...args: unknown[]) => {
      calls.push({ name, args })
      if (name === 'webRequest.addListener' && failure !== undefined) {
        const message = failure
        failure = undefined
        throw new Error(message)
      }
      return undefined
    },
    event: (name: string) => ({
      addListener: (listener: (...args: unknown[]) => void) => {
        if (name === 'webRequest.dispatch') { subscriptions++; dispatchListener = listener }
      }
    }),
    define: (_ns: string, build: (b: unknown) => object) => { api = build({ onBeforeRequest: 'event' }) as Record<string, unknown> }
  }
  ;(globalThis as { __crx?: unknown }).__crx = crx
  try { rebuilt() } finally { delete (globalThis as { __crx?: unknown }).__crx }
  return {
    api,
    calls,
    dispatch: (listenerId, dispatchId, details) => { dispatchListener?.(listenerId, dispatchId, details) },
    failNextAdd: (message) => { failure = message },
    subscriptions: () => subscriptions
  }
}

const defined = (): Record<string, any> => harness().api
const settle = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }
const FILTER = { urls: ['<all_urls>'] }

describe('chrome.webRequest constants', () => {
  it('lists exactly the resource types Chrome names', () => {
    expect(Object.values(defined().ResourceType as Record<string, string>)).toEqual([
      'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
      'ping', 'csp_report', 'media', 'websocket', 'webbundle', 'other'
    ])
  })

  it('lists BLOCKING on the four enums Chrome gives it', () => {
    const api = defined()
    for (const name of ['OnBeforeRequestOptions', 'OnBeforeSendHeadersOptions', 'OnHeadersReceivedOptions', 'OnAuthRequiredOptions']) {
      expect((api[name] as Record<string, string>).BLOCKING).toBe('blocking')
    }
  })

  it('names the option values an extension passes as extraInfoSpec', () => {
    const api = defined()
    expect((api.OnHeadersReceivedOptions as Record<string, string>).EXTRA_HEADERS).toBe('extraHeaders')
    expect((api.OnAuthRequiredOptions as Record<string, string>).ASYNC_BLOCKING).toBe('asyncBlocking')
    expect((api.OnBeforeRequestOptions as Record<string, string>).REQUEST_BODY).toBe('requestBody')
  })

  it('answers handlerBehaviorChanged without throwing, with or without a callback', async () => {
    await expect((defined().handlerBehaviorChanged as () => Promise<void>)()).resolves.toBeUndefined()
    let called = false
    expect(defined().handlerBehaviorChanged(() => { called = true })).toBeUndefined()
    expect(called).toBe(true)
  })

  it('freezes the enums', () => {
    expect(Object.isFrozen(defined().ResourceType)).toBe(true)
  })
})

const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']

describe('chrome.webRequest events', () => {
  it('defines all nine events and an inert onActionIgnored', () => {
    const api = defined()
    for (const name of EVENTS) {
      for (const method of ['addListener', 'removeListener', 'hasListener', 'hasListeners']) expect(typeof api[name][method]).toBe('function')
    }
    expect(api.onActionIgnored.hasListeners()).toBe(false)
    expect(() => api.onActionIgnored.addListener(() => {})).not.toThrow()
  })

  it('registers a listener with main under a number, passing a plain filter and the spec', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => {}, { urls: ['https://*/*'], types: ['script'], tabId: 2, extra: () => {} }, ['blocking'])
    await settle()
    expect(h.calls).toEqual([{ name: 'webRequest.addListener', args: ['onBeforeRequest', 1, { urls: ['https://*/*'], types: ['script'], tabId: 2, windowId: undefined }, ['blocking']] }])
  })

  it('numbers listeners across events, and subscribes to the dispatch event once', () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => {}, FILTER)
    h.api.onCompleted.addListener(() => {}, FILTER)
    expect(h.calls.map((call) => call.args[1])).toEqual([1, 2])
    expect(h.subscriptions()).toBe(1)
  })

  it('throws a TypeError at once for a callback or filter that is not what Chrome takes', () => {
    const h = harness()
    expect(() => h.api.onBeforeRequest.addListener('nope', FILTER)).toThrow(TypeError)
    expect(() => h.api.onBeforeRequest.addListener(() => {}, undefined)).toThrow(TypeError)
    expect(() => h.api.onBeforeRequest.addListener(() => {}, null)).toThrow(TypeError)
    expect(h.calls).toEqual([])
  })

  it('does not register the same callback twice for an event', () => {
    const h = harness()
    const callback = (): void => {}
    h.api.onCompleted.addListener(callback, FILTER)
    h.api.onCompleted.addListener(callback, FILTER)
    expect(h.calls).toHaveLength(1)
  })

  it('answers hasListener and hasListeners per event', () => {
    const h = harness()
    const callback = (): void => {}
    expect(h.api.onCompleted.hasListeners()).toBe(false)
    h.api.onCompleted.addListener(callback, FILTER)
    expect(h.api.onCompleted.hasListener(callback)).toBe(true)
    expect(h.api.onCompleted.hasListeners()).toBe(true)
    expect(h.api.onErrorOccurred.hasListener(callback)).toBe(false)
    expect(h.api.onErrorOccurred.hasListeners()).toBe(false)
  })

  it('removes a listener and tells main', async () => {
    const h = harness()
    const callback = (): void => {}
    h.api.onCompleted.addListener(callback, FILTER)
    h.api.onCompleted.removeListener(callback)
    await settle()
    expect(h.api.onCompleted.hasListener(callback)).toBe(false)
    expect(h.calls.at(-1)).toEqual({ name: 'webRequest.removeListener', args: ['onCompleted', 1] })
  })

  it('drops a listener main refused, and logs it as Chrome logs a lastError', async () => {
    const h = harness()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.failNextAdd('You do not have permission to use blocking webRequest listeners.')
      const callback = (): void => {}
      h.api.onBeforeRequest.addListener(callback, FILTER, ['blocking'])
      await settle()
      expect(h.api.onBeforeRequest.hasListener(callback)).toBe(false)
      expect(spy).toHaveBeenCalledWith('Unchecked runtime.lastError: You do not have permission to use blocking webRequest listeners.')
    } finally { spy.mockRestore() }
  })
})

describe('chrome.webRequest dispatch', () => {
  const replies = (h: Harness): unknown[][] => h.calls.filter((call) => call.name === 'webRequest.reply').map((call) => call.args)

  it('runs the listener with the details and sends no reply when none was asked for', async () => {
    const h = harness()
    const seen: unknown[] = []
    h.api.onCompleted.addListener((details: unknown) => { seen.push(details) }, FILTER)
    h.dispatch(1, 0, { url: 'https://a.example/' })
    await settle()
    expect(seen).toEqual([{ url: 'https://a.example/' }])
    expect(replies(h)).toEqual([])
  })

  it('replies with the cancel a blocking listener returns', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => ({ cancel: true, ignored: 1 }), FILTER, ['blocking'])
    h.dispatch(1, 7, {})
    await settle()
    expect(replies(h)).toEqual([[7, { cancel: true }]])
  })

  it('replies with a redirect and with header lists, keeping only name and value or binaryValue', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => ({ redirectUrl: 'https://x.example/' }), FILTER, ['blocking'])
    h.api.onHeadersReceived.addListener(() => ({ responseHeaders: [{ name: 'A', value: '1', extra: true }, { name: 'B', binaryValue: [1, 2] }] }), FILTER, ['blocking', 'responseHeaders'])
    h.dispatch(1, 1, {})
    h.dispatch(2, 2, {})
    await settle()
    expect(replies(h)).toEqual([
      [1, { redirectUrl: 'https://x.example/' }],
      [2, { responseHeaders: [{ name: 'A', value: '1' }, { name: 'B', binaryValue: [1, 2] }] }]
    ])
  })

  it('leaves out a header list with a malformed entry whole', async () => {
    const h = harness()
    h.api.onBeforeSendHeaders.addListener(() => ({ requestHeaders: [{ name: 'A', value: '1' }, { name: 'B' }] }), FILTER, ['blocking', 'requestHeaders'])
    h.dispatch(1, 3, {})
    await settle()
    expect(replies(h)).toEqual([[3, {}]])
  })

  it('replies null for a listener that returns nothing', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => undefined, FILTER, ['blocking'])
    h.dispatch(1, 4, {})
    await settle()
    expect(replies(h)).toEqual([[4, null]])
  })

  it('awaits a promise a listener returns', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(async () => ({ cancel: true }), FILTER, ['blocking'])
    h.dispatch(1, 5, {})
    await settle()
    expect(replies(h)).toEqual([[5, { cancel: true }]])
  })

  it('logs a listener that throws and replies null, so the request is not held', async () => {
    const h = harness()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.api.onBeforeRequest.addListener(() => { throw new Error('boom') }, FILTER, ['blocking'])
      h.dispatch(1, 6, {})
      await settle()
      expect(replies(h)).toEqual([[6, null]])
      expect(spy).toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('logs a rejected promise and replies null', async () => {
    const h = harness()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.api.onBeforeRequest.addListener(async () => { throw new Error('late boom') }, FILTER, ['blocking'])
      h.dispatch(1, 8, {})
      await settle()
      expect(replies(h)).toEqual([[8, null]])
    } finally { spy.mockRestore() }
  })

  it('answers a dispatch for a listener it no longer holds at once, so main does not wait', async () => {
    const h = harness()
    h.api.onBeforeRequest.addListener(() => ({ cancel: true }), FILTER, ['blocking'])
    h.dispatch(99, 9, {})
    h.dispatch(99, 0, {})
    await settle()
    expect(replies(h)).toEqual([[9, null]])
  })
})
