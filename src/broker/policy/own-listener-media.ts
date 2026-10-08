// What a page that holds a `tcp.listen` grant may load as media or an image from loopback: a port its
// own listener holds right now, and no other (ADR-0069). Pure, like the rest of this directory; the
// Electron half that asks it is ../../main/sessions/own-listener-media-gate.ts.
//
// T12 reads the same with this in place. `*:*` still never reaches loopback through the broker, and a
// app's page still cannot load an image or media from a loopback service it did not open itself:
// the only new reach is to a port the broker handed this origin a listener on.

import { isLoopbackHost, originFromUrl } from './origin.js'

/** The spellings the page's CSP admits (`media-src`/`img-src` in loader/serve/csp.ts), which a listener answers. */
const OWN_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/** Whether `url` names a loopback host by name or by any literal spelling; false for what is not a URL. */
export function isLoopbackUrl (url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return isLoopbackHost(host)
}

/**
 * Which document made a request: a web page (`http:`/`https:`, the only schemes an app's origin has),
 * a page of another kind (a local file, an extension, one of the shell's own pages) that no listen
 * grant can attach to, or no page that can be found.
 */
export type RequestingDocument =
  | { readonly kind: 'web', readonly origin: string }
  | { readonly kind: 'not-web' }
  | { readonly kind: 'unknown' }

/** The part of a frame `requestingDocumentOf` reads: Electron's `WebFrameMain` has it, and a test can build it. */
export interface FrameLike {
  readonly url: string
  readonly parent: FrameLike | null
}

/** A `blob:` URL carries its creator's origin after the scheme. */
function webOriginOf (url: string): string | null {
  return originFromUrl(url.startsWith('blob:') ? url.slice('blob:'.length) : url)
}

/**
 * The document a request came from. A frame with no web address of its own (`about:blank`, a
 * `srcdoc`, a `blob:` it made) belongs to the first ancestor that has one; a request whose chain
 * ends without a web page is from a page of another kind, and one with no frame at all is unknown.
 */
export function requestingDocumentOf (frame: FrameLike | null | undefined): RequestingDocument {
  if (frame === null || frame === undefined) return { kind: 'unknown' }
  try {
    for (let current: FrameLike | null = frame; current !== null; current = current.parent) {
      const origin = webOriginOf(current.url)
      if (origin !== null) return { kind: 'web', origin }
    }
  } catch {
    // A frame destroyed mid-request throws when read: it cannot be attributed.
    return { kind: 'unknown' }
  }
  return { kind: 'not-web' }
}

export interface OwnListenerMediaRequest {
  readonly document: RequestingDocument
  readonly url: string
  /** Whether that origin holds a live `tcp.listen.local` or `tcp.listen.network` grant. */
  readonly holdsListenGrant: boolean
  /** Whether that origin's own listener holds this port right now. */
  readonly holdsPort: (port: number) => boolean
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 }

/**
 * `cancel` for a loopback request the page has no right to; `allow` for every request this gate has
 * no opinion on, which is every request that is not loopback and every loopback one from a page that
 * holds no listen grant (its CSP never admitted loopback, so nothing changed for it).
 *
 * A loopback request that cannot be attributed to any document is cancelled: it cannot be shown to
 * belong to a page that holds the port.
 */
export function ownListenerMediaVerdict (request: OwnListenerMediaRequest): 'allow' | 'cancel' {
  if (!isLoopbackUrl(request.url)) return 'allow'
  if (request.document.kind === 'unknown') return 'cancel'
  if (request.document.kind === 'not-web') return 'allow'
  // A page loading from its own loopback origin is same-origin, which no listener grant decides.
  if (originFromUrl(request.url) === request.document.origin) return 'allow'
  if (!request.holdsListenGrant) return 'allow'
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return 'cancel'
  }
  if (!OWN_HOSTS.has(parsed.hostname)) return 'cancel'
  const port = parsed.port === '' ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port)
  return port !== undefined && request.holdsPort(port) ? 'allow' : 'cancel'
}
