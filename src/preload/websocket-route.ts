// ADR-0017 for WebSocket: a socket to a GRANTED cross-origin host is an
// HTTP/1.1 Upgrade over `orivon.net` -- `connectSecure` for wss:, the same
// traffic an https grant already authorises, and `connect` for ws:, as a
// routed http: request dials -- then RFC 6455 framing
// (./websocket-route-frames.ts). A same-origin URL, or a host the app was
// not granted, gets the page's native WebSocket, whose events are
// re-dispatched here, so the page's own CSP applies to it as to any page.
//
// `installWebSocketRoute` is SERIALISED into the main world (see
// ./routed-wire.ts's header); README.md's Design notes have its numbers and
// its divergences from a browser.
import type { RoutedSocket } from './fetch-route-types.js'
import type { WebSocketInbound, WebSocketRouteTarget, WebSocketSlot } from './websocket-route-types.js'

type PlatformWebSocket = WebSocket

/** Mirror the literals `installWebSocketRoute` keeps inside its own body; see ./routed-wire.ts's ROUTED_MAX_HEAD_BYTES for why they exist twice. */
export const WEBSOCKET_OPENING_TIMEOUT_MS = 240_000
export const WEBSOCKET_CLOSING_TIMEOUT_MS = 60_000
export const WEBSOCKET_CLOSE_LINGER_MS = 2_000

export function installWebSocketRoute (
  isAppTab: boolean,
  target: WebSocketRouteTarget = typeof window === 'undefined' ? {} : window as unknown as WebSocketRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, WebSocketSlot | undefined>)[Symbol.for('orivon.routed-network')]
  const NativeOrNot = target.WebSocket as (new (url: string, protocols?: string | string[]) => PlatformWebSocket) | undefined
  if (slot?.wire === undefined || slot.dial === undefined || slot.core === undefined || slot.events === undefined ||
    slot.webSocketFrames === undefined || typeof NativeOrNot !== 'function') return
  // Fresh bindings, so the narrowing above holds inside every nested function.
  const wire = slot.wire
  const dial = slot.dial
  const core = slot.core
  const events = slot.events
  const frames = slot.webSocketFrames
  const NativeWebSocket = NativeOrNot

  const CONNECTING = 0
  const OPEN = 1
  const CLOSING = 2
  const CLOSED = 3
  // Chromium's own bounds: the whole opening handshake, the wait for the
  // peer's close frame, and the wait for the peer to drop TCP after it.
  const OPENING_TIMEOUT_MS = 240_000
  const CLOSING_TIMEOUT_MS = 60_000
  const CLOSE_LINGER_MS = 2_000
  // A control frame carries at most 125 bytes, two of them the close code.
  const MAX_REASON_BYTES = 123
  const NO_STATUS = 1005
  const ABNORMAL_CLOSURE = 1006
  const SUBPROTOCOL = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

  interface State {
    readyState: number
    readonly url: URL
    /** `url` as the http(s) URL the upgrade request is made to. */
    readonly httpUrl: URL
    readonly protocols: string[]
    binaryType: BinaryType
    protocol: string
    bufferedAmount: number
    native: PlatformWebSocket | undefined
    socket: RoutedSocket | undefined
    readonly controller: AbortController
    /** Every outbound frame goes through this chain, so frames never interleave on the wire. */
    sending: Promise<void>
    queued: number
    closeSent: boolean
    closeReceived: { code: number, reason: string } | undefined
    failed: boolean
    timer: ReturnType<typeof setTimeout> | undefined
  }

  const states = new WeakMap<object, State>()

  function state (ws: object): State {
    const s = states.get(ws)
    if (s === undefined) throw new TypeError('Illegal invocation')
    return s
  }

  function syntaxError (message: string): DOMException {
    return new DOMException(`Failed to construct 'WebSocket': ${message}`, 'SyntaxError')
  }

  function parseUrl (raw: unknown): URL {
    let url: URL
    try {
      url = new URL(String(raw), target.document?.baseURI ?? target.location?.href)
    } catch {
      throw syntaxError(`The URL '${String(raw)}' is invalid.`)
    }
    if (url.protocol === 'http:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw syntaxError(`The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${url.protocol.slice(0, -1)}' is not allowed.`)
    }
    if (url.href.includes('#')) throw syntaxError(`The URL contains a fragment identifier ('${url.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`)
    return url
  }

  function protocolList (raw: unknown): string[] {
    if (raw === undefined) return []
    const iterable = typeof raw === 'object' && raw !== null && typeof (raw as Iterable<unknown>)[Symbol.iterator] === 'function'
    const list = iterable ? Array.from(raw as Iterable<unknown>, String) : [String(raw)]
    const seen = new Set<string>()
    for (const protocol of list) {
      if (!SUBPROTOCOL.test(protocol)) throw syntaxError(`The subprotocol '${protocol}' is invalid.`)
      if (seen.has(protocol)) throw syntaxError(`The subprotocol '${protocol}' is duplicated.`)
      seen.add(protocol)
    }
    return list
  }

  /** WebIDL's [Clamp] unsigned short: clamped to range, rounded half to even. */
  function clampCode (raw: unknown): number {
    const n = Number(raw)
    const c = Number.isNaN(n) ? 0 : Math.min(65535, Math.max(0, n))
    const floor = Math.floor(c)
    const fraction = c - floor
    return fraction > 0.5 || (fraction === 0.5 && floor % 2 === 1) ? floor + 1 : floor
  }

  function detail (error: unknown): string {
    const cause = error instanceof Error ? error.cause : undefined
    if (cause instanceof Error) return cause.message
    // A protocol error from the frame parser is a plain `{ closeCode, message }`.
    const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined
    return typeof message === 'string' ? message : String(error)
  }

  function closeEvent (code: number, reason: string, wasClean: boolean): Event {
    if (typeof CloseEvent === 'function') return new CloseEvent('close', { code, reason, wasClean })
    return Object.assign(new Event('close'), { code, reason, wasClean })
  }

  function clearTimer (s: State): void {
    if (s.timer !== undefined) { clearTimeout(s.timer); s.timer = undefined }
  }

  function armTimer (s: State, ms: number, onExpiry: () => void): void {
    clearTimer(s)
    s.timer = setTimeout(() => { s.timer = undefined; onExpiry() }, ms)
  }

  function finish (ws: EventTarget, s: State, code: number, reason: string, wasClean: boolean, error: boolean): void {
    if (s.readyState === CLOSED) return
    s.readyState = CLOSED
    clearTimer(s)
    if (error) ws.dispatchEvent(new Event('error'))
    ws.dispatchEvent(closeEvent(code, reason, wasClean))
  }

  function enqueue (s: State, frame: () => Uint8Array[] | Promise<Uint8Array[]>, counted: number): void {
    s.queued++
    s.sending = s.sending.then(async () => {
      try {
        const pieces = await frame()
        for (const piece of pieces) {
          if (s.socket === undefined || s.failed) break
          await s.socket.write(piece)
        }
      } catch { /* a dead socket ends the read loop, which reports the closure */ } finally {
        s.bufferedAmount -= counted
        s.queued--
      }
    })
  }

  function sendClose (s: State, code: number | undefined, reason: Uint8Array): void {
    s.closeSent = true
    enqueue(s, () => frames.encode(frames.opcodes.close, frames.closePayload(code, reason)), 0)
  }

  /** The spec's "fail the WebSocket connection": error, then close 1006, whatever the peer does. */
  function fail (ws: EventTarget, s: State, why: string, closeCode?: number): void {
    if (s.failed || s.readyState === CLOSED) return
    s.failed = true
    if (s.readyState === OPEN) s.readyState = CLOSING
    console.error(`WebSocket connection to '${s.url.href}' failed: ${why}`)
    s.controller.abort()
    clearTimer(s)
    const socket = s.socket
    // A close frame is written only between messages: one cut into a half-written frame would corrupt it.
    if (socket !== undefined && closeCode !== undefined && !s.closeSent && s.queued === 0) {
      s.closeSent = true
      const [frame] = frames.encode(frames.opcodes.close, frames.closePayload(closeCode, new Uint8Array(0)))
      void socket.write(frame!).catch(() => {}).finally(() => { void socket.close() })
    } else {
      void socket?.close()
    }
    setTimeout(() => { finish(ws, s, ABNORMAL_CLOSURE, '', false, true) }, 0)
  }

  function attachNative (ws: EventTarget, s: State, native: PlatformWebSocket): void {
    native.binaryType = s.binaryType
    s.native = native
    events.forward(native, ws, ['open', 'message', 'error'])
    native.addEventListener('close', (event) => { ws.dispatchEvent(closeEvent(event.code, event.reason, event.wasClean)) })
  }

  function goNative (ws: EventTarget, s: State): void {
    clearTimer(s)
    let native: PlatformWebSocket
    try {
      native = new NativeWebSocket(s.url.href, s.protocols)
    } catch (error) {
      fail(ws, s, detail(error))
      return
    }
    attachNative(ws, s, native)
  }

  function handshakeHeaders (s: State, key: string): Array<[string, string]> {
    const headers: Array<[string, string]> = [['Connection', 'Upgrade'], ['Pragma', 'no-cache'], ['Cache-Control', 'no-cache']]
    const agent = target.navigator?.userAgent
    if (typeof agent === 'string') headers.push(['User-Agent', agent])
    headers.push(['Upgrade', 'websocket'], ['Origin', target.location?.origin ?? 'null'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', key])
    if (s.protocols.length > 0) headers.push(['Sec-WebSocket-Protocol', s.protocols.join(', ')])
    return headers
  }

  function deliver (ws: EventTarget, s: State, item: WebSocketInbound): void {
    if (s.closeReceived !== undefined) return
    if (item.kind === 'text' || item.kind === 'binary') {
      if (s.readyState !== OPEN) return
      const data = item.kind === 'text' ? item.data : s.binaryType === 'arraybuffer' ? item.data.buffer : new Blob([item.data as Uint8Array<ArrayBuffer>])
      ws.dispatchEvent(new MessageEvent('message', { data, origin: s.url.origin }))
    } else if (item.kind === 'ping') {
      if (!s.closeSent) enqueue(s, () => frames.encode(frames.opcodes.pong, item.data), 0)
    } else if (item.kind === 'close') {
      s.closeReceived = { code: item.code, reason: item.reason }
      if (!s.closeSent) {
        s.readyState = CLOSING
        sendClose(s, item.code === NO_STATUS ? undefined : item.code, new Uint8Array(0))
      }
      // RFC 6455: the server drops TCP first; a peer that never does is dropped here.
      armTimer(s, CLOSE_LINGER_MS, () => { void s.socket?.close() })
    }
  }

  async function receive (ws: EventTarget, s: State, socket: RoutedSocket, rest: Uint8Array): Promise<void> {
    const parser = frames.parser()
    let chunk: Uint8Array | undefined = rest.byteLength > 0 ? rest : undefined
    try {
      for (;;) {
        if (chunk === undefined) {
          const { done, value } = await socket.reader.read()
          if (done) break
          chunk = value
        }
        const inbound = parser.feed(chunk)
        chunk = undefined
        for (const item of inbound) deliver(ws, s, item)
        if (s.failed || s.readyState === CLOSED) return
      }
    } catch (error) {
      const closeCode = typeof error === 'object' && error !== null ? (error as { closeCode?: unknown }).closeCode : undefined
      if (typeof closeCode === 'number') { fail(ws, s, detail(error), closeCode); return }
      // Anything else is the transport dropping: an abnormal closure, reported below.
    }
    void socket.close()
    if (s.failed) return
    if (s.closeReceived !== undefined && s.closeSent) finish(ws, s, s.closeReceived.code, s.closeReceived.reason, true, false)
    else finish(ws, s, ABNORMAL_CLOSURE, '', false, false)
  }

  async function connect (ws: EventTarget, s: State): Promise<void> {
    let socket: RoutedSocket | undefined
    try {
      socket = await dial.open(s.httpUrl, s.controller.signal, true)
    } catch (error) {
      fail(ws, s, detail(error))
      return
    }
    if (s.readyState !== CONNECTING || s.failed) { void socket?.close(); return }
    if (socket === undefined) { goNative(ws, s); return }
    s.socket = socket
    const key = frames.key()
    let rest: Uint8Array
    try {
      await socket.write(wire.requestHead('GET', s.httpUrl, handshakeHeaders(s, key), undefined))
      const head = await wire.readHead(async () => {
        const { done, value } = await socket.reader.read()
        return done ? undefined : value
      }, new Uint8Array(0))
      s.protocol = await frames.checkHandshake(head, key, s.protocols)
      rest = head.rest
    } catch (error) {
      fail(ws, s, `Error during WebSocket handshake: ${detail(error)}`)
      return
    }
    if (s.readyState !== CONNECTING || s.failed) return
    clearTimer(s)
    s.readyState = OPEN
    ws.dispatchEvent(new Event('open'))
    void receive(ws, s, socket, rest)
  }

  /** What `send()` puts on the wire, masked now, so a buffer the page changes afterwards is sent as it was. */
  function outbound (data: unknown): { size: number, frame: () => Uint8Array[] | Promise<Uint8Array[]> } {
    if (typeof Blob === 'function' && data instanceof Blob) {
      return { size: data.size, frame: async () => frames.encode(frames.opcodes.binary, new Uint8Array(await data.arrayBuffer())) }
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
      const pieces = frames.encode(frames.opcodes.binary, view)
      return { size: view.byteLength, frame: () => pieces }
    }
    const text = new TextEncoder().encode(String(data))
    const pieces = frames.encode(frames.opcodes.text, text)
    return { size: text.byteLength, frame: () => pieces }
  }

  class WebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3

    constructor (url: string | URL, protocols?: string | string[]) {
      super()
      const parsed = parseUrl(url)
      const list = protocolList(protocols)
      const httpUrl = new URL(parsed.href)
      httpUrl.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      const s: State = {
        readyState: CONNECTING, url: parsed, httpUrl, protocols: list, binaryType: 'blob', protocol: '', bufferedAmount: 0,
        native: undefined, socket: undefined, controller: new AbortController(), sending: Promise.resolve(), queued: 0,
        closeSent: false, closeReceived: undefined, failed: false, timer: undefined
      }
      states.set(this, s)
      if (!core.routes(httpUrl)) {
        attachNative(this, s, new NativeWebSocket(parsed.href, list))
        return
      }
      armTimer(s, OPENING_TIMEOUT_MS, () => { fail(this, s, 'WebSocket opening handshake timed out') })
      void connect(this, s)
    }

    get CONNECTING (): number { return CONNECTING }
    get OPEN (): number { return OPEN }
    get CLOSING (): number { return CLOSING }
    get CLOSED (): number { return CLOSED }
    get [Symbol.toStringTag] (): string { return 'WebSocket' }
    get url (): string { return state(this).url.href }
    get readyState (): number { const s = state(this); return s.native?.readyState ?? s.readyState }
    get bufferedAmount (): number { const s = state(this); return s.native?.bufferedAmount ?? s.bufferedAmount }
    get protocol (): string { const s = state(this); return s.native?.protocol ?? s.protocol }
    get extensions (): string { return state(this).native?.extensions ?? '' }
    get binaryType (): BinaryType { return state(this).binaryType }
    set binaryType (value: BinaryType) {
      if (value !== 'blob' && value !== 'arraybuffer') return
      const s = state(this)
      s.binaryType = value
      if (s.native !== undefined) s.native.binaryType = value
    }

    send (data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      const s = state(this)
      if (s.native !== undefined) { s.native.send(data as Parameters<PlatformWebSocket['send']>[0]); return }
      if (s.readyState === CONNECTING) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError')
      const { size, frame } = outbound(data)
      s.bufferedAmount += size
      // Past close, the spec counts the bytes and sends nothing.
      if (s.readyState !== OPEN || s.closeSent) return
      enqueue(s, frame, size)
    }

    close (code?: number, reason?: string): void {
      const s = state(this)
      let status = code === undefined ? undefined : clampCode(code)
      if (status !== undefined && status !== 1000 && (status < 3000 || status > 4999)) {
        throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${status} is neither.`, 'InvalidAccessError')
      }
      const reasonBytes = reason === undefined ? new Uint8Array(0) : new TextEncoder().encode(String(reason))
      if (reasonBytes.byteLength > MAX_REASON_BYTES) {
        throw new DOMException(`Failed to execute 'close' on 'WebSocket': The close reason must not be greater than ${MAX_REASON_BYTES} UTF-8 bytes.`, 'SyntaxError')
      }
      if (s.native !== undefined) { s.native.close(status, reason); return }
      if (s.readyState === CLOSING || s.readyState === CLOSED) return
      if (s.readyState === CONNECTING) {
        fail(this, s, 'WebSocket is closed before the connection is established.')
        s.readyState = CLOSING
        return
      }
      s.readyState = CLOSING
      if (status === undefined && reasonBytes.byteLength > 0) status = 1000
      sendClose(s, status, reasonBytes)
      armTimer(s, CLOSING_TIMEOUT_MS, () => { void s.socket?.close() })
    }

    get onopen (): unknown { return events.getHandler(this, 'open') }
    set onopen (v: unknown) { events.setHandler(this, 'open', v) }
    get onmessage (): unknown { return events.getHandler(this, 'message') }
    set onmessage (v: unknown) { events.setHandler(this, 'message', v) }
    get onerror (): unknown { return events.getHandler(this, 'error') }
    set onerror (v: unknown) { events.setHandler(this, 'error', v) }
    get onclose (): unknown { return events.getHandler(this, 'close') }
    set onclose (v: unknown) { events.setHandler(this, 'close', v) }
  }

  // An interface object's own descriptor: replaceable, and not enumerable (ADR-0021).
  Object.defineProperty(target, 'WebSocket', { value: WebSocket, writable: true, configurable: true, enumerable: false })
}
