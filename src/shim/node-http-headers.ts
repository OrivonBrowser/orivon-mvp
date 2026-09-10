// A case-insensitive header bag for the OUTGOING (request) side, plus the
// wire serialisation for a request head. The incoming (response) side has a
// different job -- combining duplicates per Node's rules while parsing --
// and lives in node-http-parser.ts; this file only ever sees headers an app
// set itself, one value per name until overwritten, matching what
// ClientRequest.setHeader really does.

export type HeaderValue = string | number | readonly string[]

/** A bare CR or LF in a header name/value would let a value inject a second header line or a bogus request -- Node's real setHeader throws on this too. */
const FORBIDDEN_CHARACTER = /[\r\n]/

function assertNoInjection (kind: 'header name' | 'header value' | 'request line', text: string): void {
  if (FORBIDDEN_CHARACTER.test(text)) {
    throw new TypeError(`orivon-node-shim: invalid ${kind} (contains a raw CR or LF): ${JSON.stringify(text)}`)
  }
}

export class HeaderBag {
  private readonly byLowerName = new Map<string, { name: string, value: HeaderValue }>()

  set (name: string, value: HeaderValue): void {
    assertNoInjection('header name', name)
    for (const one of Array.isArray(value) ? value : [value]) assertNoInjection('header value', String(one))
    this.byLowerName.set(name.toLowerCase(), { name, value })
  }

  get (name: string): HeaderValue | undefined {
    return this.byLowerName.get(name.toLowerCase())?.value
  }

  has (name: string): boolean {
    return this.byLowerName.has(name.toLowerCase())
  }

  remove (name: string): void {
    this.byLowerName.delete(name.toLowerCase())
  }

  /** Applies every entry of a plain options.headers object, Node's own accepted input shape. */
  setAll (headers: Record<string, HeaderValue> | undefined): void {
    if (headers === undefined) return
    for (const [name, value] of Object.entries(headers)) this.set(name, value)
  }

  entries (): ReadonlyArray<{ name: string, value: HeaderValue }> {
    return [...this.byLowerName.values()]
  }
}

const CRLF = '\r\n'

/** One request line plus every header, each on its own line, terminated by a blank line -- no body. */
export function serializeRequestHead (method: string, path: string, headers: HeaderBag): Uint8Array {
  assertNoInjection('request line', method)
  assertNoInjection('request line', path)
  const lines = [`${method} ${path} HTTP/1.1`]
  for (const { name, value } of headers.entries()) {
    const values = Array.isArray(value) ? value : [value]
    for (const one of values) lines.push(`${name}: ${String(one)}`)
  }
  lines.push('', '')
  return new TextEncoder().encode(lines.join(CRLF))
}

/** Host header value Node computes automatically: omits the port when it is the scheme's default. */
export function defaultHostHeader (host: string, port: number, defaultPort: number): string {
  return port === defaultPort ? host : `${host}:${port}`
}
