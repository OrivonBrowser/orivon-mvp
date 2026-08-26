// Origin derivation -- the isolation key.
//
// An app's origin keys its storage domain, its session partition, its grant
// ledger entry and its derived identity key (capability-api.md SSOrigin,
// ADR-0003). Changing the definition after the first grant is persisted
// invalidates every stored grant and orphans every app's data, so it is
// settled here, once, before the broker that will persist those grants exists.
//
// The definition is the WEB's -- scheme + host + port -- deliberately not a
// new one (capability-api.md). What this file adds on top of `URL.origin` is
// the rejection of everything that is not a real network origin, plus one
// host canonicalisation the URL parser does not do. Both are below, with the
// reason each exists.
//
// Pure by structural rule: no electron, no node:fs/net/dns, no I/O at all
// (src/broker/policy/README.md). `URL` is a global -- no import needed.

/**
 * Only these two schemes yield an origin.
 *
 * An ALLOWLIST, never a denylist, because `URL.origin` has two distinct
 * silent failure modes and a denylist of `file:` and `data:` misses both:
 *
 *   1. `new URL('file:///etc/passwd').origin` is the STRING `"null"`, not the
 *      value `null`. Returned unchecked it is a perfectly serviceable object
 *      key and directory name, so every `file:`, `data:`, `about:`,
 *      `javascript:` and `magnet:` URL in the browser would collapse into ONE
 *      shared storage domain holding ONE grant ledger entry. Nothing throws
 *      and nothing looks wrong (security-model.md T13b).
 *
 *   2. `new URL('blob:https://x.example/u').origin` is `"https://x.example"` --
 *      a real, entirely legitimate-looking origin, for a scheme T13b requires
 *      be rejected outright. `ws:`, `wss:` and `ftp:` do the same thing. A
 *      denylist that names `file:` and `data:` reads as complete and lets all
 *      four through.
 *
 * IPFS CIDs and ENS names key on something other than scheme+host+port and are
 * deferred until trustless resolution exists (capability-api.md). They get an
 * explicit branch here when they arrive; until then an unrecognised scheme is
 * a denial, which is the failure direction we want.
 *
 * `http:` is present on purpose. security-model.md T13c forbids PERSISTING a
 * grant for a loopback or plain-http origin -- it does not forbid deriving
 * one. The developer-mode and localhost-fixture paths both need a real origin
 * to scope a session-lifetime grant to (docs/development/testing.md).
 */
const ORIGIN_BEARING_SCHEMES = ['http:', 'https:']

/**
 * Canonicalises the host the URL parser hands back.
 *
 * The parser has already lowercased it, converted IDN to punycode, and
 * collapsed IPv4 and IPv6 literals to one spelling each -- so `EXAMPLE.com`,
 * `0177.0.0.1` and `[0:0:0:0:0:0:0:1]` need nothing here.
 *
 * It does NOT strip the trailing root label: `x.example.` and `x.example`
 * parse to different hosts and therefore different origins. That is what a
 * browser does, and it is wrong for a key that names a storage directory.
 * Both spellings are the same DNS name, served by the same operator under the
 * same certificate, and the URL parser already strips the equivalent dot from
 * `127.0.0.1.` -- so leaving it on a DNS name gives one app two storage
 * domains, two grant ledger entries and two identity keys, reachable by
 * typing a character the address bar barely renders. Strip it.
 *
 * Exactly one dot, though. A host still carrying an empty label after that --
 * `x.example..`, `.x.example`, `a..b` -- is not a valid DNS name at all, and
 * mapping an unresolvable name onto a resolvable one is the collapse this
 * function exists to prevent. Reject rather than keep stripping.
 *
 * Returns null if the host cannot be a key.
 */
function canonicalHost (hostname: string): string | null {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname

  if (host.length === 0) return null
  if (host.split('.').some((label) => label.length === 0)) return null

  return host
}

/**
 * URL to origin, or null if the URL has no origin that may key storage.
 *
 * Returns the web origin -- scheme + host + port, no trailing slash, default
 * ports omitted, so `https://x.example:443` and `https://x.example` are one
 * origin. Matches the `origin` field of a `Grant` (src/contracts/manifest.ts).
 */
export function originFromUrl (url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (!ORIGIN_BEARING_SCHEMES.includes(parsed.protocol)) return null

  const host = canonicalHost(parsed.hostname)
  if (host === null) return null

  // `parsed.port` is already '' when the port is the scheme's default -- the
  // URL parser drops it during parsing, which is what makes :443 and no port
  // the same origin here.
  const port = parsed.port === '' ? '' : `:${parsed.port}`

  return `${parsed.protocol}//${host}${port}`
}

/**
 * The shape of Electron's `WebFrameMain` that origin derivation is allowed to
 * see. Structural on purpose: the broker passes the real frame, every test
 * passes a literal, and this file stays importable without electron.
 */
export interface SenderFrameLike {
  /** The frame's committed URL. THE ONLY FIELD READ. */
  readonly url?: string | undefined
  /**
   * Present because the real `WebFrameMain` has it, and because a reader must
   * be able to see that it is deliberately NOT read. A compromised renderer
   * that controls its own frame's reported identity would otherwise
   * impersonate any app in the grant ledger (security-model.md T3).
   * Never read this. origin.test.ts fails if anyone does.
   */
  readonly origin?: string | undefined
}

/**
 * Sender frame to origin, or null if the frame has no origin to speak for.
 *
 * The caller must pass `event.senderFrame` captured SYNCHRONOUSLY at message
 * receipt, and must re-derive on every call: origin is per frame, never per
 * `WebContents`. A `WebContents` is a tab, and Electron re-injects preloads on
 * every navigation and into iframes, so a granted app that navigates itself to
 * a hostile origin would keep the grant ledger pointing at the app
 * (security-model.md T3 and its 2026-08-25 correction).
 *
 * Rejects the unbound frame in all the forms it arrives in: absent, never
 * navigated (`url` is ''), `about:blank` or `about:srcdoc` -- which inherit an
 * origin on the web platform and must not inherit a capability here -- and
 * disposed, which throws on property access rather than returning anything.
 */
export function originFromSenderFrame (frame: SenderFrameLike | null | undefined): string | null {
  if (frame == null) return null

  let url: string | undefined
  try {
    // A destroyed WebFrameMain throws here. T3's own correction notes that an
    // async handler can resolve after the frame is detached, so this is an
    // expected condition, and the answer to it is denial, not a broker crash.
    url = frame.url
  } catch {
    return null
  }

  // The value crosses from Electron at runtime; the type above is a claim, not
  // a guarantee.
  if (typeof url !== 'string') return null

  return originFromUrl(url)
}
