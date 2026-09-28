// ADR-0017 for EventSource: a stream from a GRANTED cross-origin host runs
// over the routed exchange (./core.ts), parsed and reconnected as the
// HTML spec's server-sent events require (event/data/id/retry fields,
// Last-Event-ID on reconnect). A same-origin or non-http(s) URL, or a host
// the app was not granted, gets the page's native EventSource, whose events
// are re-dispatched here -- including any named event type the page listens
// for.
//
// `installEventSourceRoute` is SERIALISED into the main world (see
// ./wire.ts's header).
import type { FetchRouteTarget, RoutedSlot } from './types.js'

export function installEventSourceRoute (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  const NativeOrNot = target.EventSource as (new (url: string, init?: EventSourceInit) => EventSource) | undefined
  if (slot?.core === undefined || slot.events === undefined || typeof NativeOrNot !== 'function') return
  // Fresh bindings, so the narrowing above holds inside every nested function.
  const core = slot.core
  const events = slot.events
  const NativeEventSource = NativeOrNot

  const CONNECTING = 0
  const OPEN = 1
  const CLOSED = 2
  // What Chromium waits before reconnecting, until the stream sends `retry:`.
  const DEFAULT_RETRY_MS = 3000

  interface State {
    readyState: number
    readonly url: URL
    readonly withCredentials: boolean
    retryMs: number
    lastEventId: string
    controller: AbortController | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    native: EventSource | undefined
    /** Every event type the page listens for, forwarded from a native delegate. */
    readonly types: Set<string>
    forwarded: Set<string>
  }

  const states = new WeakMap<object, State>()

  function state (source: object): State {
    const s = states.get(source)
    if (s === undefined) throw new TypeError('Illegal invocation')
    return s
  }

  function forwardType (source: EventTarget, s: State, type: string): void {
    s.types.add(type)
    if (s.native === undefined || s.forwarded.has(type)) return
    s.forwarded.add(type)
    events.forward(s.native, source, [type])
  }

  function goNative (source: EventTarget, s: State): void {
    s.native = new NativeEventSource(s.url.href, { withCredentials: s.withCredentials })
    for (const type of ['open', 'message', 'error', ...s.types]) forwardType(source, s, type)
  }

  /** Reconnects after the retry delay, announcing it with an error event, as the spec's "reestablish the connection" does. */
  function reestablish (source: EventTarget, s: State): void {
    if (s.readyState === CLOSED) return
    s.readyState = CONNECTING
    source.dispatchEvent(new Event('error'))
    if (s.readyState === CLOSED) return
    s.timer = setTimeout(() => { if (s.readyState === CONNECTING) void connect(source, s) }, s.retryMs)
  }

  function failConnection (source: EventTarget, s: State): void {
    s.readyState = CLOSED
    source.dispatchEvent(new Event('error'))
  }

  /** The spec's line-by-line parser, fed decoded text as it arrives; CR, LF and CRLF all end a line, even split across chunks. */
  function parser (source: EventTarget, s: State, origin: string): (text: string) => void {
    let buffer = ''
    let afterCr = false
    let data = ''
    let type = ''
    let id = s.lastEventId

    function dispatch (): void {
      s.lastEventId = id
      if (data === '') { type = ''; return }
      const event = new MessageEvent(type === '' ? 'message' : type, { data: data.slice(0, -1), origin, lastEventId: s.lastEventId })
      data = ''
      type = ''
      if (s.readyState !== CLOSED) source.dispatchEvent(event)
    }

    function line (text: string): void {
      if (text === '') { dispatch(); return }
      if (text.startsWith(':')) return
      const colon = text.indexOf(':')
      const field = colon === -1 ? text : text.slice(0, colon)
      let value = colon === -1 ? '' : text.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') type = value
      else if (field === 'data') data += `${value}\n`
      else if (field === 'id') { if (!value.includes('\0')) id = value }
      else if (field === 'retry') { if (/^\d+$/.test(value)) s.retryMs = Number(value) }
    }

    return (text) => {
      let start = 0
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (afterCr && c === 10) { afterCr = false; start = i + 1; continue }
        afterCr = false
        if (c !== 10 && c !== 13) continue
        line(buffer + text.slice(start, i))
        buffer = ''
        afterCr = c === 13
        start = i + 1
      }
      buffer += text.slice(start)
    }
  }

  async function connect (source: EventTarget, s: State): Promise<void> {
    const controller = new AbortController()
    s.controller = controller
    const headers: Array<[string, string]> = [['Accept', 'text/event-stream'], ['Cache-Control', 'no-cache']]
    if (s.lastEventId !== '') headers.push(['Last-Event-ID', s.lastEventId])
    let response: Response | undefined
    try {
      response = await core.request({ url: s.url, method: 'GET', headers, body: undefined, signal: controller.signal, redirect: 'follow', idle: true })
    } catch {
      if (!controller.signal.aborted) reestablish(source, s)
      return
    }
    if (controller.signal.aborted) { void response?.body?.cancel().catch(() => {}); return }
    if (response === undefined) { goNative(source, s); return }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    if (response.status !== 200 || type !== 'text/event-stream' || response.body === null) {
      void response.body?.cancel().catch(() => {})
      failConnection(source, s)
      return
    }
    s.readyState = OPEN
    source.dispatchEvent(new Event('open'))
    const feed = parser(source, s, new URL(response.url !== '' ? response.url : s.url.href).origin)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        feed(value)
      }
    } catch { /* a dropped stream reconnects below, the same as one the server ended */ }
    if (!controller.signal.aborted) reestablish(source, s)
  }

  class EventSource extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2

    constructor (url: string | URL, init?: EventSourceInit) {
      super()
      let parsed: URL
      try {
        parsed = new URL(String(url), target.document?.baseURI ?? target.location?.href)
      } catch {
        throw new DOMException(`Failed to construct 'EventSource': The URL '${String(url)}' is invalid.`, 'SyntaxError')
      }
      const s: State = {
        readyState: CONNECTING, url: parsed, withCredentials: init?.withCredentials === true, retryMs: DEFAULT_RETRY_MS,
        lastEventId: '', controller: undefined, timer: undefined, native: undefined, types: new Set(), forwarded: new Set()
      }
      states.set(this, s)
      if (core.routes(parsed)) void connect(this, s)
      else goNative(this, s)
    }

    get CONNECTING (): number { return CONNECTING }
    get OPEN (): number { return OPEN }
    get CLOSED (): number { return CLOSED }
    get [Symbol.toStringTag] (): string { return 'EventSource' }
    get url (): string { const s = state(this); return s.native?.url ?? s.url.href }
    get withCredentials (): boolean { return state(this).withCredentials }
    get readyState (): number { const s = state(this); return s.native?.readyState ?? s.readyState }

    close (): void {
      const s = state(this)
      s.native?.close()
      s.readyState = CLOSED
      s.controller?.abort()
      if (s.timer !== undefined) clearTimeout(s.timer)
    }

    override addEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
      super.addEventListener(type, listener, options)
      forwardType(this, state(this), String(type))
    }

    get onopen (): unknown { return events.getHandler(this, 'open') }
    set onopen (v: unknown) { events.setHandler(this, 'open', v) }
    get onmessage (): unknown { return events.getHandler(this, 'message') }
    set onmessage (v: unknown) { events.setHandler(this, 'message', v) }
    get onerror (): unknown { return events.getHandler(this, 'error') }
    set onerror (v: unknown) { events.setHandler(this, 'error', v) }
  }

  // An interface object's own descriptor: replaceable, and not enumerable (ADR-0021).
  Object.defineProperty(target, 'EventSource', { value: EventSource, writable: true, configurable: true, enumerable: false })
}
