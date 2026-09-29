// An origin granted without installing (./grant-without-install.ts) gets the
// same Content-Security-Policy on its documents that an installed app's
// responses carry, built by the same builder from the same live grants. See
// README.md's Design notes.
//
// Such an origin is served by its own server, never through protocol.handle,
// so session.webRequest.onHeadersReceived does fire for it (A110 is about
// protocol.handle responses only).

import { session } from 'electron'
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import { ISOLATION_HEADERS } from '../../loader/serve/csp.js'

/**
 * A dedicated or shared worker's top-level script response, alongside
 * `mainFrame`/`subFrame` below -- Electron's `OnHeadersReceivedListener
 * DetailsResourceType` has no dedicated "worker" member at all (its full
 * union is `mainFrame`/`subFrame`/`stylesheet`/`script`/`image`/`font`/
 * `object`/`xhr`/`ping`/`cspReport`/`media`/`webSocket`/`other`), and a
 * worker's own script fetch is classified as `'script'`, or `'other'` on
 * some platform/version combinations -- both covered here rather than
 * assuming one. The installed path (`granted-origin-csp.ts`'s own header)
 * covers every served asset regardless of type; this listener sees only
 * network responses, so it names exactly the ones a document's CSP still
 * has to reach.
 *
 * A CSP header on any OTHER resource type here (an image, a stylesheet)
 * is inert -- Chromium enforces `Content-Security-Policy` only from a
 * document or a worker global scope's own response -- so covering `script`/
 * `other` too broadly costs nothing beyond one extra `cspFor()` read for a
 * same-origin script response that turns out not to be a worker.
 */
const WORKER_SCRIPT_TYPES: ReadonlySet<string> = new Set(['script', 'other'])

type HeadersListener = (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void

/**
 * `headers` plus `csp` as one more Content-Security-Policy value. The
 * server's own policy stays: the browser enforces every policy it is sent,
 * so the result is their intersection, never a relaxation of either.
 */
export function withAppendedCsp (headers: Record<string, string[]> | undefined, csp: string): Record<string, string[]> {
  const result: Record<string, string[]> = { ...headers }
  const existing = Object.keys(result).find((name) => name.toLowerCase() === 'content-security-policy')
  const name = existing ?? 'Content-Security-Policy'
  result[name] = [...(result[name] ?? []), csp]
  return result
}

/**
 * True for a mainFrame/subFrame document, or a worker script, actually FROM
 * `origin` -- compared through the same canonicalisation as everywhere else
 * a document is matched against its grants (`originFromUrl`,
 * `partitionFor`), never a bare `new URL(...).origin`. `http://localhost.`
 * (a trailing dot -- the same host under DNS's own rules) and `http://
 * localhost` parse to two DIFFERENT `URL.origin` strings but the SAME
 * `originFromUrl`; a plain `.origin` comparison denied the dotted spelling
 * its CSP while the broker and `tab-view.ts`'s `partitionForTarget` both
 * still keyed it to this same origin's grants and partition.
 */
function isDocumentFrom (details: OnHeadersReceivedListenerDetails, origin: string): boolean {
  const isRelevantType = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame' || WORKER_SCRIPT_TYPES.has(details.resourceType)
  if (!isRelevantType) return false
  return originFromUrl(details.url) === origin
}

/** `headers` plus the two cross-origin isolation headers, replacing the server's own if it sent any: the manifest asked for isolation, and a weaker server value would silently deny it. */
export function withIsolationHeaders (headers: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const replaced = new Set(Object.keys(ISOLATION_HEADERS))
  for (const [name, value] of Object.entries(headers)) {
    if (!replaced.has(name.toLowerCase())) result[name] = value
  }
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) result[name] = [value]
  return result
}

/**
 * The `onHeadersReceived` listener for one granted origin. `cspFor` is read
 * per response, so a grant or revoke reaches the next document load;
 * `isolatedFor` (the manifest's `crossOriginIsolated`) the same way, so a
 * manifest change reaches the next load too.
 *
 * The CSP itself now reaches a worker script response too (`isDocumentFrom`'s
 * own doc) -- but the two ISOLATION headers stay mainFrame/subFrame only,
 * unlike the installed path (which sets them on every served asset): unlike
 * a CSP, COOP/COEP on the WRONG response can actively break an otherwise
 * working page (COEP on a same-origin sub-resource the page does not itself
 * mark `crossOriginEmbedderPolicy`-aware fails to load it), so widening
 * their reach here is a separate decision from this fix, not a side effect
 * of it. A worker script the server sends without them is that server's own
 * to fix, same as before.
 */
export function grantedOriginCspListener (origin: string, cspFor: () => Promise<string>, isolatedFor: () => Promise<boolean> = async () => false): HeadersListener {
  return (details, callback) => {
    if (!isDocumentFrom(details, origin)) {
      callback({})
      return
    }
    const isFrame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
    // A manifest that cannot be read means "not isolated", never a document
    // without its policy.
    Promise.all([cspFor(), isFrame ? isolatedFor().catch(() => false) : Promise.resolve(false)]).then(
      ([csp, isolated]) => {
        const withCsp = withAppendedCsp(details.responseHeaders, csp)
        callback({ responseHeaders: isolated ? withIsolationHeaders(withCsp) : withCsp })
      },
      // The callback must always run, or the response hangs.
      () => { callback({}) }
    )
  }
}

/**
 * Installs the listener on `origin`'s app partition, the session its app tab
 * runs in once granted. Electron keeps one `onHeadersReceived` listener per
 * session, so calling this again for the same origin replaces it; nothing
 * else in src/ listens on an app partition's `webRequest`.
 */
export function installGrantedOriginCsp (broker: Broker, origin: string): void {
  session.fromPartition(partitionFor(origin)).webRequest.onHeadersReceived(
    grantedOriginCspListener(
      origin,
      async () => await liveCspHeaderFor(broker, origin),
      async () => (await broker.app.manifest(origin)).crossOriginIsolated === true
    )
  )
}
