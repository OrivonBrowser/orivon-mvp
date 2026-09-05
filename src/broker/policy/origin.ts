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

import { classifyAddress } from './address.js'

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
 * Longest host that may become an origin: RFC 1035's limit on a DNS name.
 *
 * The URL parser imposes no bound, so without this a caller can hand back a
 * megabyte-long origin -- and the origin is not just a return value. It names
 * a session partition, keys a grant ledger entry, and is the input to the
 * sha256 that names a storage directory (security-model.md T13b). An
 * unbounded key is threaded through all three.
 *
 * 253 refuses nothing real: a name longer than this cannot resolve, so it
 * cannot serve an app. IPv6 literals are far shorter, brackets included.
 */
const MAX_HOST_LENGTH = 253

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
  if (host.length > MAX_HOST_LENGTH) return null
  if (host.split('.').some((label) => label.length === 0)) return null

  return host
}

/**
 * URL to origin, or null if the URL has no origin that may key storage.
 *
 * Returns the web origin -- scheme + host + port, no trailing slash, default
 * ports omitted, so `https://x.example:443` and `https://x.example` are one
 * origin. Matches the `origin` field of a `Grant` (src/contracts/manifest.ts).
 *
 * NOT AN AUTHENTICATION BOUNDARY. This normalises a string; it does not
 * establish who sent it. `originFromUrl(payload.url)` on anything reaching the
 * broker over IPC is T3 in one line -- the renderer picks the string, so the
 * renderer picks the origin, and the return type looks identical to the
 * authenticated one. The broker's caller identity comes from
 * `originFromSenderFrame` and from nowhere else.
 *
 * One further property the return value does NOT carry, which the caller is
 * responsible for: whether it is safe as a path segment. It is not: it
 * contains `://`. Storage directories are `sha256(origin)` (T13b), never the
 * string.
 *
 * Whether the origin may be PERSISTED is a second such property -- see
 * `isPersistableOrigin`, below, which answers it now that a real consumer
 * (A23's own "Needed by") exists.
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
 * RFC 6761 SS6.3 reserves the WHOLE `.localhost` namespace for loopback, not
 * just the bare label -- Chromium resolves the entire subtree that way
 * without consulting DNS at all, so `app.localhost` is as much loopback as
 * `localhost` is. `classifyAddress` only recognises address LITERALS, so a
 * name check is the only way to catch either; a resolver-based check would be
 * resolver-dependent where Chromium's own behaviour is not.
 *
 * Exported so a second caller checking name-based loopback outside this file
 * (`../../loader/install-origin.ts`'s T12 guard, which fetches through
 * Electron's `net.fetch` -- the same Chromium behaviour this comment
 * describes) reuses this rather than a second copy (Rule 3).
 */
export function isLocalhostName (host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

/**
 * True only if `origin` (already in `originFromUrl`'s canonical shape) may
 * ever be written to disk -- T13c: "Never persist grants for loopback,
 * `file:` or plain-`http` origins" (security-model.md). Session-scoped,
 * re-prompted every launch, is the answer for everything this returns false
 * for.
 *
 * `file:` never reaches here at all: `ORIGIN_BEARING_SCHEMES` above already
 * refuses it a derivable origin in the first place. That leaves scheme and
 * host to check:
 *   - `http:` is refused outright, regardless of host -- the "plain-http"
 *     half of T13c.
 *   - The whole `.localhost` NAMESPACE is refused by name, not just the bare
 *     label: RFC 6761 SS6.3 reserves every name ending in `.localhost` for
 *     loopback, and Chromium resolves the subtree that way, so
 *     `app.localhost` is as much loopback as `localhost` is.
 *     `classifyAddress` below only recognises address LITERALS, so a name
 *     check is the only way to catch either.
 *   - Every other host is classified via `./address.ts`'s `classifyAddress`,
 *     the ONE place this codebase decides what counts as loopback (T12's own
 *     table). Both 'loopback' AND 'unspecified' are refused: `0.0.0.0` and
 *     `[::]` are a separate AddressClass there, but connecting to either
 *     reaches 127.0.0.1 on Linux and macOS, which is exactly the reachability
 *     T13c is about. An ordinary DNS name classifies as 'unparseable', which
 *     is correctly neither -- this function does not (and must not) reject
 *     every address `classifyAddress` would flag; T13c names loopback
 *     specifically, not the wider private/link-local/reserved ranges T12
 *     blocks for a different reason (outbound `net.connect`, not what may be
 *     written to disk).
 *
 * Takes an already-canonical origin, same as `canonicalHost`. It runs the
 * host through `canonicalHost` anyway rather than trusting that: a caller
 * that skipped the step would otherwise spell its way past the name checks
 * above with a trailing root label (`localhost.`), and failing closed on a
 * host that cannot be canonicalised at all is free here.
 */
export function isPersistableOrigin (origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (parsed.protocol !== 'https:') return false

  const host = canonicalHost(parsed.hostname)
  if (host === null) return false
  if (isLocalhostName(host)) return false

  const cls = classifyAddress(host)
  return cls !== 'loopback' && cls !== 'unspecified'
}

/**
 * The shape of Electron's `WebFrameMain` that origin derivation reads.
 * Structural on purpose: the broker passes the real frame, every test passes a
 * literal, and this file stays importable without electron.
 *
 * NEITHER FIELD IS RENDERER-SUPPLIED. Electron computes both in the browser
 * process -- `url` from `GetLastCommittedURL()`, `origin` from the RFC 6454
 * serialisation of `GetLastCommittedOrigin()`. A compromised renderer can set
 * neither. What security-model.md T3 forbids trusting is an origin the
 * renderer puts in the IPC PAYLOAD; this function never sees one and must
 * never be handed one (see `originFromUrl`'s warning).
 */
export interface SenderFrameLike {
  /** The frame's committed URL. */
  readonly url?: string | undefined
  /**
   * The frame's origin as Chromium computes it, serialised per RFC 6454.
   * The four-character string `'null'` for an opaque origin.
   */
  readonly origin?: string | undefined
}

/**
 * Sender frame to origin, or null if the frame has no origin to speak for.
 *
 * BOTH FIELDS ARE READ, AND THEY MUST AGREE. Neither is sufficient alone, and
 * each covers the other's blind spot:
 *
 *   - `url` alone cannot see an OPAQUE origin. A top-level document served
 *     with `Content-Security-Policy: sandbox`, or a sandboxed iframe, keeps
 *     its ordinary https URL while Chromium gives it no origin at all.
 *     Verified against real Electron 44: url `http://127.0.0.1:PORT/sandboxed`
 *     with origin `'null'`. T13b requires opaque origins -- and it names
 *     sandboxed frames explicitly -- be rejected OUTRIGHT, and the URL simply
 *     does not carry the fact. Deriving from the URL alone hands such a frame
 *     the embedding app's entire grant set.
 *   - `origin` alone cannot see a BORROWED origin. `blob:https://x.example/u`
 *     serialises to the real `https://x.example`, and an `about:blank` child
 *     frame inherits its parent's origin while its url stays `about:blank`.
 *     T13b wants both refused; the origin field reports both as ordinary.
 *
 * So: derive from the url, and require Chromium to independently agree. A
 * disagreement means an opaque origin, a borrowed one, or an assumption of
 * ours that has broken. Every one of those answers is denial.
 *
 * Both are compared AFTER canonicalisation, because A14 (owner, 2026-08-26)
 * strips the trailing root label and Chromium does not -- comparing raw
 * strings would deny every trailing-dot app by way of our own deviation.
 *
 * The caller must pass `event.senderFrame` captured SYNCHRONOUSLY at message
 * receipt, and must re-derive on every call: origin is per frame, never per
 * `WebContents`. A `WebContents` is a tab, and Electron re-injects the preload
 * on every navigation, so a granted app that navigates itself to a hostile
 * origin would keep the grant ledger pointing at the app (security-model.md T3
 * and its 2026-08-25 correction).
 *
 * Rejects the unbound frame in all the forms it arrives in: absent, never
 * navigated (`url` is ''), `about:blank` or `about:srcdoc`, and disposed --
 * which throws on property access rather than returning anything.
 */
export function originFromSenderFrame (frame: SenderFrameLike | null | undefined): string | null {
  if (frame == null) return null

  let url: string | undefined
  let claimed: string | undefined
  try {
    // A destroyed WebFrameMain throws on either access. T3's own correction
    // notes that an async handler can resolve after the frame is detached, so
    // this is an expected condition, and the answer is denial, not a crash
    // that takes the IPC handler with it.
    url = frame.url
    claimed = frame.origin
  } catch {
    return null
  }

  // Both values cross from Electron at runtime; the types above are a claim,
  // not a guarantee. A frame that cannot state its own origin is not one we
  // will speak for.
  if (typeof url !== 'string' || typeof claimed !== 'string') return null

  const derived = originFromUrl(url)
  if (derived === null) return null

  // `originFromUrl('null')` is null, which is how the opaque case is caught:
  // no serialised opaque origin can equal a real one.
  if (originFromUrl(claimed) !== derived) return null

  return derived
}
