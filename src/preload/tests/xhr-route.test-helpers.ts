// Stand-ins for the platform pieces Node lacks, for the routed XHR suites.
// Not *.test.ts, so vitest does not collect it as its own suite.

/** Node has no ProgressEvent; the routed XHR constructs them by the global name, as a page does. */
export function installProgressEvent (): void {
  if (typeof (globalThis as { ProgressEvent?: unknown }).ProgressEvent === 'function') return
  class ProgressEvent extends Event {
    readonly lengthComputable: boolean
    readonly loaded: number
    readonly total: number
    constructor (type: string, init: { lengthComputable?: boolean, loaded?: number, total?: number } = {}) {
      super(type)
      this.lengthComputable = init.lengthComputable ?? false
      this.loaded = init.loaded ?? 0
      this.total = init.total ?? 0
    }
  }
  ;(globalThis as { ProgressEvent?: unknown }).ProgressEvent = ProgressEvent
}

/** A recording stand-in for the page's native XMLHttpRequest; the test drives its outcome with `finish`. */
export class FakeNativeXhr extends EventTarget {
  static last: FakeNativeXhr | undefined
  readonly calls: unknown[][] = []
  readonly upload = new EventTarget()
  readyState = 0
  status = 0
  statusText = ''
  responseText = ''
  responseType = ''
  responseURL = ''
  timeout = 0
  withCredentials = false
  get response (): string { return this.responseText }
  responseXML = null

  constructor () {
    super()
    FakeNativeXhr.last = this
  }

  open (method: string, url: string, async = true): void {
    this.calls.push(['open', method, url, async])
    this.readyState = 1
    this.dispatchEvent(new Event('readystatechange'))
  }

  setRequestHeader (name: string, value: string): void { this.calls.push(['setRequestHeader', name, value]) }
  overrideMimeType (mime: string): void { this.calls.push(['overrideMimeType', mime]) }
  getResponseHeader (): string | null { return null }
  getAllResponseHeaders (): string { return '' }
  abort (): void { this.calls.push(['abort']) }

  send (body: unknown): void {
    this.calls.push(['send', body])
    this.dispatchEvent(new ProgressEvent('loadstart'))
  }

  finish (status: number, text: string): void {
    Object.assign(this, { status, responseText: text, readyState: 4 })
    this.dispatchEvent(new Event('readystatechange'))
    this.dispatchEvent(new ProgressEvent('load'))
    this.dispatchEvent(new ProgressEvent('loadend'))
  }
}
