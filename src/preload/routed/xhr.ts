// ADR-0017 for XMLHttpRequest: axios, superagent, jQuery.ajax and
// cross-fetch's fallback reach a GRANTED cross-origin host through the same
// routed exchange as fetch() (./core.ts), with the XHR spec's events,
// states and response views. Everything else -- a same-origin or non-http(s)
// URL, a synchronous request, a host the app was not granted -- is handed to
// the page's native XMLHttpRequest, whose events are re-dispatched here, so
// it behaves exactly as on an ordinary page. Routed or native is decided at
// send(), once the grant has answered.
//
// `installXhrRoute` is SERIALISED into the main world (see ./wire.ts's
// header); the response views are ./xhr-response.ts's, the handler
// attributes ./events.ts's.
import type { FetchRouteTarget, RoutedSlot, XhrBody } from './types.js'

export function installXhrRoute (
  isAppTab: boolean,
  target: FetchRouteTarget = typeof window === 'undefined' ? {} : window as unknown as FetchRouteTarget
): void {
  if (!isAppTab) return
  const slot = (target as Record<symbol, RoutedSlot | undefined>)[Symbol.for('orivon.routed-network')]
  const NativeXhrOrNot = target.XMLHttpRequest as (new () => XMLHttpRequest) | undefined
  if (slot?.core === undefined || slot.events === undefined || slot.xhrBodies === undefined || typeof NativeXhrOrNot !== 'function') return
  // Fresh bindings, so the narrowing above holds inside every nested function.
  const core = slot.core
  const events = slot.events
  const bodies = slot.xhrBodies
  const NativeXhr = NativeXhrOrNot

  const UNSENT = 0
  const OPENED = 1
  const HEADERS_RECEIVED = 2
  const LOADING = 3
  const DONE = 4
  // The XHR spec's pace for progress and readystatechange during a body.
  const PROGRESS_INTERVAL_MS = 50
  const XHR_EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']
  const UPLOAD_EVENTS = ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']
  const RESPONSE_TYPES = ['', 'arraybuffer', 'blob', 'document', 'json', 'text']

  interface State {
    readyState: number
    method: string
    url: URL | undefined
    user: string | undefined
    password: string | undefined
    headers: Array<[string, string]>
    responseType: string
    timeout: number
    withCredentials: boolean
    overrideMime: string | undefined
    sending: boolean
    uploadDone: boolean
    uploadEvents: boolean
    status: number
    statusText: string
    responseURL: string
    responseHeaders: Array<[string, string]>
    body: XhrBody | undefined
    controller: AbortController | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    sentAt: number
    generation: number
    native: XMLHttpRequest | undefined
    detach: Array<() => void>
    /** Native events the routed send() already fired itself, dropped once when the native echo arrives. */
    echo: Set<string>
  }

  const states = new WeakMap<object, State>()
  const uploads = new WeakMap<object, EventTarget>()
  const listenedUploads = new WeakSet<EventTarget>()

  function state (xhr: object): State {
    const s = states.get(xhr)
    if (s === undefined) throw new TypeError('Illegal invocation')
    return s
  }

  function domError (name: string, message: string): DOMException {
    return new DOMException(`Failed to execute on 'XMLHttpRequest': ${message}`, name)
  }

  function progress (type: string, loaded: number, total: number): Event {
    return new ProgressEvent(type, { lengthComputable: total > 0, loaded, total })
  }

  /** Dispatches, then reports whether the request this generation belongs to is still the current one -- a listener may call abort() or open(). */
  function fire (on: EventTarget, event: Event, s: State, generation: number): boolean {
    on.dispatchEvent(event)
    return s.generation === generation
  }

  function clearTimer (s: State): void {
    if (s.timer !== undefined) { clearTimeout(s.timer); s.timer = undefined }
  }

  function armTimer (xhr: XMLHttpRequest, s: State): void {
    clearTimer(s)
    if (s.timeout <= 0 || !s.sending || s.native !== undefined) return
    const generation = s.generation
    s.timer = setTimeout(() => { if (s.generation === generation) requestError(xhr, s, 'timeout') }, Math.max(0, s.timeout - (Date.now() - s.sentAt)))
  }

  /** The XHR spec's "request error steps": done, then the upload's events, then the request's. */
  function requestError (xhr: XMLHttpRequest, s: State, type: 'error' | 'abort' | 'timeout'): void {
    const generation = ++s.generation
    clearTimer(s)
    s.controller?.abort()
    s.controller = undefined
    Object.assign(s, { readyState: DONE, sending: false, status: 0, statusText: '', responseHeaders: [], body: undefined })
    if (!fire(xhr, new Event('readystatechange'), s, generation)) return
    const upload = uploads.get(xhr)!
    if (!s.uploadDone) {
      s.uploadDone = true
      if (s.uploadEvents && (!fire(upload, progress(type, 0, 0), s, generation) || !fire(upload, progress('loadend', 0, 0), s, generation))) return
    }
    if (fire(xhr, progress(type, 0, 0), s, generation)) fire(xhr, progress('loadend', 0, 0), s, generation)
  }

  function finishUpload (xhr: XMLHttpRequest, s: State, generation: number, loaded: number, total: number): boolean {
    if (s.uploadDone) return true
    s.uploadDone = true
    if (!s.uploadEvents) return true
    const upload = uploads.get(xhr)!
    return fire(upload, progress('progress', loaded, total), s, generation) &&
      fire(upload, progress('load', loaded, total), s, generation) &&
      fire(upload, progress('loadend', loaded, total), s, generation)
  }

  /**
   * Hands the request to the page's native XMLHttpRequest, re-dispatching its
   * events here. `replayed`: routed send() already ran -- it fired loadstart
   * and the page's headers are recorded -- so the native request is opened
   * and sent here, and its own echo of those events is dropped.
   */
  function goNative (xhr: XMLHttpRequest, s: State, replayed: boolean): XMLHttpRequest {
    const native = new NativeXhr()
    if (s.responseType !== '') native.responseType = s.responseType as XMLHttpRequestResponseType
    if (s.timeout > 0) native.timeout = replayed ? Math.max(1, s.timeout - (Date.now() - s.sentAt)) : s.timeout
    if (s.overrideMime !== undefined) native.overrideMimeType(s.overrideMime)
    native.withCredentials = s.withCredentials
    s.native = native
    s.echo = new Set(replayed ? ['loadstart', 'upload-loadstart'] : [])
    let quiet = replayed
    s.detach.push(events.forward(native, xhr, XHR_EVENTS, (event) => !quiet && !s.echo.delete(event.type)))
    if (replayed) {
      native.open(s.method, s.url!.href, true, s.user, s.password)
      quiet = false
      for (const [name, value] of s.headers) {
        try { native.setRequestHeader(name, value) } catch { /* a header the native path forbids is dropped there, as on any page */ }
      }
    }
    return native
  }

  /** Upload events are forwarded only if the page listens for them by send(): a native upload listener makes a cross-origin request preflighted. */
  function sendNative (xhr: XMLHttpRequest, s: State, body: unknown): void {
    const upload = uploads.get(xhr)!
    if (listenedUploads.has(upload)) s.detach.push(events.forward(s.native!.upload, upload, UPLOAD_EVENTS, (event) => !s.echo.delete(`upload-${event.type}`)))
    s.native!.send(body as XMLHttpRequestBodyInit | null)
  }

  function combinedHeaders (pairs: ReadonlyArray<readonly [string, string]>): Map<string, string> {
    const map = new Map<string, string>()
    for (const [name, value] of pairs) map.set(name, map.has(name) ? `${map.get(name)!}, ${value}` : value)
    return map
  }

  function authorised (s: State): Array<[string, string]> {
    const user = s.user ?? (s.url!.username !== '' ? decodeURIComponent(s.url!.username) : undefined)
    const password = s.password ?? decodeURIComponent(s.url!.password)
    if (user === undefined || s.headers.some(([k]) => k.toLowerCase() === 'authorization')) return s.headers
    const raw = new TextEncoder().encode(`${user}:${password}`)
    return [...s.headers, ['Authorization', `Basic ${btoa(String.fromCharCode(...raw))}`]]
  }

  async function run (xhr: XMLHttpRequest, s: State, generation: number, payload: unknown, original: unknown): Promise<void> {
    let response: Response | undefined
    const sent = { loaded: 0, total: 0 }
    try {
      response = await core.request({
        url: s.url!,
        method: s.method,
        headers: authorised(s),
        body: payload,
        signal: s.controller!.signal,
        redirect: 'follow',
        idle: s.timeout === 0,
        onUploadProgress: (loaded, total) => {
          Object.assign(sent, { loaded, total })
          if (s.generation === generation && s.uploadEvents && loaded < total) uploads.get(xhr)!.dispatchEvent(progress('progress', loaded, total))
        }
      })
    } catch {
      if (s.generation === generation) requestError(xhr, s, 'error')
      return
    }
    if (s.generation !== generation) { void response?.body?.cancel().catch(() => {}); return }
    if (response === undefined) {
      clearTimer(s)
      s.controller = undefined
      goNative(xhr, s, true)
      sendNative(xhr, s, original)
      return
    }
    if (!finishUpload(xhr, s, generation, sent.loaded, sent.total)) return
    const contentType = response.headers.get('content-type') ?? ''
    Object.assign(s, {
      status: response.status,
      statusText: response.statusText,
      responseURL: response.url,
      responseHeaders: [...response.headers],
      body: bodies.create(s.overrideMime ?? contentType),
      readyState: HEADERS_RECEIVED
    })
    if (!fire(xhr, new Event('readystatechange'), s, generation)) return
    const declared = Number(response.headers.get('content-length') ?? '0')
    const total = response.headers.has('content-encoding') || !Number.isFinite(declared) ? 0 : declared
    if (response.body !== null) {
      const reader = response.body.getReader()
      let last = -Infinity
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (s.generation !== generation) { void reader.cancel().catch(() => {}); return }
          if (done) break
          s.body!.push(value)
          if (Date.now() - last < PROGRESS_INTERVAL_MS) continue
          last = Date.now()
          s.readyState = LOADING
          if (!fire(xhr, new Event('readystatechange'), s, generation) || !fire(xhr, progress('progress', s.body!.received, total), s, generation)) return
        }
      } catch {
        if (s.generation === generation) requestError(xhr, s, 'error')
        return
      }
    }
    clearTimer(s)
    const received = s.body!.received
    if (!fire(xhr, progress('progress', received, total), s, generation)) return
    s.readyState = DONE
    s.sending = false
    s.controller = undefined
    if (fire(xhr, new Event('readystatechange'), s, generation) && fire(xhr, progress('load', received, total), s, generation)) {
      fire(xhr, progress('loadend', received, total), s, generation)
    }
  }

  // `constructing` gates the upload constructor: the page reaches an upload
  // object only through `xhr.upload`, as with the platform's own.
  let constructing = false

  class XMLHttpRequestUpload extends EventTarget {
    constructor () {
      if (!constructing) throw new TypeError('Illegal constructor')
      super()
    }

    override addEventListener (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
      listenedUploads.add(this)
      super.addEventListener(type, listener, options)
    }

    get [Symbol.toStringTag] (): string { return 'XMLHttpRequestUpload' }
    get onloadstart (): unknown { return events.getHandler(this, 'loadstart') }
    set onloadstart (v: unknown) { events.setHandler(this, 'loadstart', v) }
    get onprogress (): unknown { return events.getHandler(this, 'progress') }
    set onprogress (v: unknown) { events.setHandler(this, 'progress', v) }
    get onload (): unknown { return events.getHandler(this, 'load') }
    set onload (v: unknown) { events.setHandler(this, 'load', v) }
    get onerror (): unknown { return events.getHandler(this, 'error') }
    set onerror (v: unknown) { events.setHandler(this, 'error', v) }
    get onabort (): unknown { return events.getHandler(this, 'abort') }
    set onabort (v: unknown) { events.setHandler(this, 'abort', v) }
    get ontimeout (): unknown { return events.getHandler(this, 'timeout') }
    set ontimeout (v: unknown) { events.setHandler(this, 'timeout', v) }
    get onloadend (): unknown { return events.getHandler(this, 'loadend') }
    set onloadend (v: unknown) { events.setHandler(this, 'loadend', v) }
  }

  class XMLHttpRequest extends EventTarget {
    static readonly UNSENT = 0
    static readonly OPENED = 1
    static readonly HEADERS_RECEIVED = 2
    static readonly LOADING = 3
    static readonly DONE = 4

    constructor () {
      super()
      states.set(this, {
        readyState: UNSENT, method: 'GET', url: undefined, user: undefined, password: undefined, headers: [],
        responseType: '', timeout: 0, withCredentials: false, overrideMime: undefined,
        sending: false, uploadDone: true, uploadEvents: false,
        status: 0, statusText: '', responseURL: '', responseHeaders: [], body: undefined,
        controller: undefined, timer: undefined, sentAt: 0, generation: 0, native: undefined, detach: [], echo: new Set()
      })
      constructing = true
      try { uploads.set(this, new XMLHttpRequestUpload()) } finally { constructing = false }
    }

    get UNSENT (): number { return UNSENT }
    get OPENED (): number { return OPENED }
    get HEADERS_RECEIVED (): number { return HEADERS_RECEIVED }
    get LOADING (): number { return LOADING }
    get DONE (): number { return DONE }
    get [Symbol.toStringTag] (): string { return 'XMLHttpRequest' }

    open (method: string, url: string | URL, ...rest: unknown[]): void {
      const s = state(this)
      const async = rest.length === 0 ? true : Boolean(rest[0])
      const user = rest[1] === undefined || rest[1] === null ? undefined : String(rest[1])
      const password = rest[2] === undefined || rest[2] === null ? undefined : String(rest[2])
      const name = String(method)
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw domError('SyntaxError', `'${name}' is not a valid HTTP method.`)
      const upper = name.toUpperCase()
      if (['CONNECT', 'TRACE', 'TRACK'].includes(upper)) throw domError('SecurityError', `'${name}' HTTP method is unsupported.`)
      let parsed: URL
      try { parsed = new URL(String(url), target.document?.baseURI ?? target.location?.href) } catch { throw domError('SyntaxError', 'Invalid URL') }

      s.generation++
      clearTimer(s)
      s.controller?.abort()
      for (const detach of s.detach.splice(0)) detach()
      const previous = s.native
      Object.assign(s, {
        method: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(upper) ? upper : name,
        url: parsed, user, password, headers: [], sending: false, uploadDone: true, uploadEvents: false,
        status: 0, statusText: '', responseURL: '', responseHeaders: [], body: undefined, controller: undefined, native: undefined
      })
      previous?.abort()
      if (!async || !core.routes(parsed)) {
        goNative(this, s, false).open(s.method, parsed.href, async, user, password)
        return
      }
      if (s.readyState !== OPENED) {
        s.readyState = OPENED
        this.dispatchEvent(new Event('readystatechange'))
      }
    }

    setRequestHeader (name: string, value: string): void {
      const s = state(this)
      if (s.native !== undefined) { s.native.setRequestHeader(name, value); return }
      if (s.readyState !== OPENED || s.sending) throw domError('InvalidStateError', "The object's state must be OPENED.")
      const header = String(name)
      const text = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '')
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) throw domError('SyntaxError', `'${header}' is not a valid HTTP header field name.`)
      if (/[\0\r\n]/.test(text)) throw domError('SyntaxError', `'${text}' is not a valid HTTP header field value.`)
      const existing = s.headers.find(([k]) => k.toLowerCase() === header.toLowerCase())
      if (existing !== undefined) existing[1] = `${existing[1]}, ${text}`
      else s.headers.push([header, text])
    }

    send (body: unknown = null): void {
      const s = state(this)
      const upload = uploads.get(this)!
      if (s.native !== undefined) { sendNative(this, s, body); return }
      if (s.readyState !== OPENED || s.sending) throw domError('InvalidStateError', "The object's state must be OPENED.")
      const bodyless = s.method === 'GET' || s.method === 'HEAD' || body === null || body === undefined
      const payload = bodyless
        ? undefined
        : typeof Document === 'function' && body instanceof Document ? new XMLSerializer().serializeToString(body) : body
      const generation = ++s.generation
      Object.assign(s, { sending: true, uploadDone: payload === undefined, uploadEvents: payload !== undefined && listenedUploads.has(upload), sentAt: Date.now(), controller: new AbortController() })
      if (!fire(this, progress('loadstart', 0, 0), s, generation)) return
      if (s.uploadEvents && !fire(upload, progress('loadstart', 0, 0), s, generation)) return
      armTimer(this, s)
      void run(this, s, generation, payload, bodyless ? null : body)
    }

    abort (): void {
      const s = state(this)
      if (s.native !== undefined) { s.native.abort(); return }
      if ((s.readyState === OPENED && s.sending) || s.readyState === HEADERS_RECEIVED || s.readyState === LOADING) requestError(this, s, 'abort')
      if (s.readyState === DONE) Object.assign(s, { readyState: UNSENT, status: 0, statusText: '', responseHeaders: [], body: undefined })
    }

    getResponseHeader (name: string): string | null {
      const s = state(this)
      if (s.native !== undefined) return s.native.getResponseHeader(name)
      if (s.readyState < HEADERS_RECEIVED) return null
      return combinedHeaders(s.responseHeaders).get(String(name).toLowerCase()) ?? null
    }

    getAllResponseHeaders (): string {
      const s = state(this)
      if (s.native !== undefined) return s.native.getAllResponseHeaders()
      if (s.readyState < HEADERS_RECEIVED) return ''
      return [...combinedHeaders(s.responseHeaders)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    }

    overrideMimeType (mime: string): void {
      const s = state(this)
      if (s.native !== undefined) { s.native.overrideMimeType(mime); return }
      if (s.readyState === LOADING || s.readyState === DONE) throw domError('InvalidStateError', "The object's state must not be LOADING or DONE.")
      s.overrideMime = String(mime)
    }

    get readyState (): number { const s = state(this); return s.native?.readyState ?? s.readyState }
    get status (): number { const s = state(this); return s.native?.status ?? s.status }
    get statusText (): string { const s = state(this); return s.native?.statusText ?? s.statusText }
    get responseURL (): string { const s = state(this); return s.native?.responseURL ?? s.responseURL }
    get upload (): EventTarget { return uploads.get(this)! }

    get responseType (): string { const s = state(this); return s.native?.responseType ?? s.responseType }
    set responseType (value: string) {
      const s = state(this)
      if (!RESPONSE_TYPES.includes(value)) return
      if (s.native !== undefined) s.native.responseType = value as XMLHttpRequestResponseType
      else if (s.readyState === LOADING || s.readyState === DONE) throw domError('InvalidStateError', "The response type cannot be set if the object's state is LOADING or DONE.")
      s.responseType = value
    }

    get timeout (): number { const s = state(this); return s.native?.timeout ?? s.timeout }
    set timeout (value: number) {
      const s = state(this)
      if (s.native !== undefined) s.native.timeout = value
      s.timeout = Math.max(0, Math.floor(Number(value)) || 0)
      armTimer(this, s)
    }

    get withCredentials (): boolean { const s = state(this); return s.native?.withCredentials ?? s.withCredentials }
    set withCredentials (value: boolean) {
      const s = state(this)
      if (s.native !== undefined) s.native.withCredentials = value
      else if (s.readyState !== UNSENT && s.readyState !== OPENED) throw domError('InvalidStateError', 'The value may only be set if the object\'s state is UNSENT or OPENED.')
      s.withCredentials = Boolean(value)
    }

    get response (): unknown {
      const s = state(this)
      if (s.native !== undefined) return s.native.response
      if (s.responseType === '' || s.responseType === 'text') return this.responseText
      return s.readyState === DONE && s.body !== undefined ? s.body.value(s.responseType) : null
    }

    get responseText (): string {
      const s = state(this)
      if (s.native !== undefined) return s.native.responseText
      if (s.responseType !== '' && s.responseType !== 'text') throw domError('InvalidStateError', `The value is only accessible if the object's 'responseType' is '' or 'text' (was '${s.responseType}').`)
      if (s.body === undefined || (s.readyState !== LOADING && s.readyState !== DONE)) return ''
      return s.readyState === DONE ? s.body.value('text') as string : s.body.text()
    }

    get responseXML (): unknown {
      const s = state(this)
      if (s.native !== undefined) return s.native.responseXML
      if (s.responseType !== '' && s.responseType !== 'document') throw domError('InvalidStateError', `The value is only accessible if the object's 'responseType' is '' or 'document' (was '${s.responseType}').`)
      return s.readyState === DONE && s.body !== undefined ? s.body.document(s.responseType === '') : null
    }

    get onreadystatechange (): unknown { return events.getHandler(this, 'readystatechange') }
    set onreadystatechange (v: unknown) { events.setHandler(this, 'readystatechange', v) }
    get onloadstart (): unknown { return events.getHandler(this, 'loadstart') }
    set onloadstart (v: unknown) { events.setHandler(this, 'loadstart', v) }
    get onprogress (): unknown { return events.getHandler(this, 'progress') }
    set onprogress (v: unknown) { events.setHandler(this, 'progress', v) }
    get onload (): unknown { return events.getHandler(this, 'load') }
    set onload (v: unknown) { events.setHandler(this, 'load', v) }
    get onerror (): unknown { return events.getHandler(this, 'error') }
    set onerror (v: unknown) { events.setHandler(this, 'error', v) }
    get onabort (): unknown { return events.getHandler(this, 'abort') }
    set onabort (v: unknown) { events.setHandler(this, 'abort', v) }
    get ontimeout (): unknown { return events.getHandler(this, 'timeout') }
    set ontimeout (v: unknown) { events.setHandler(this, 'timeout', v) }
    get onloadend (): unknown { return events.getHandler(this, 'loadend') }
    set onloadend (v: unknown) { events.setHandler(this, 'loadend', v) }
  }

  // An interface object's own descriptor: replaceable, and not enumerable (ADR-0021).
  Object.defineProperty(target, 'XMLHttpRequest', { value: XMLHttpRequest, writable: true, configurable: true, enumerable: false })
}
