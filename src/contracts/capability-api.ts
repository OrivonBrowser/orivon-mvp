// Transcribed from docs/architecture/capability-api.md's "v0 surface" section.
//
// capability-api.ts - What an app can ask for
//
// THIS IS THE DURABLE ASSET (ADR-0002). Apps call orivon.net.connect; beneath
// it that is a Node net.Socket in the main process today, a Wasmtime host
// function later, Mojo IPC in a Chromium fork after that. None of those
// transitions is visible to an app already written, and that property -- not
// Electron, not Wasmtime -- is what keeps the path to a Chromium fork open.
//
// DESIGN RULES THIS FILE OBEYS:
//   2. Network is async, full stop; fs gets one narrow synchronous exception
//      (ADR-0016, narrowing this rule from "everything is async" on
//      2026-09-10 -- see docs/architecture/capability-api.md's own rule 2 for
//      the reasoning). Node constructs sockets synchronously; across an IPC
//      boundary net cannot, so every orivon.net.* entry point still returns a
//      Promise, no exception. orivon.fs.readFileSync is the one call in this
//      file that does not: a local file read is sub-millisecond, and an
//      async-only fs does not slow a ported app's startup config read down,
//      it makes the call absent (the dependency calling it has no await to
//      offer). The mechanism -- ipcRenderer.sendSync today, an
//      Atomics.wait-in-a-Worker route later -- is invisible to the app
//      either way.
//   3. Handles, not ambient authority. connect() returns a handle; later
//      operations reference it. Capability is checked ONCE, at acquisition,
//      which avoids TOCTOU and avoids re-authorising on every call.
//   4. Declare statically, grant dynamically.
//   5. No capability is implicit.

import type {
  DirectoryHandle,
  FileHandle,
  FileStat,
  IdentityHandle,
  LookupAddress,
  SecureTcpSocket,
  TcpServer,
  TcpSocket,
  UdpSocket,
  WebContext
} from './handles.js'
import type { Grant, Manifest, Pattern } from './manifest.js'

/** The root object injected into an app's page as `orivon`. */
export interface Orivon {
  readonly version: 0
  readonly app: OrivonApp
  readonly net: OrivonNet
  readonly fs: OrivonFs
  readonly id: OrivonId
  readonly web: OrivonWeb
  readonly secrets: OrivonSecrets
}

export interface OrivonApp {
  manifest(): Promise<Manifest>
  /** What was ACTUALLY granted, which is a subset of what the manifest declares. */
  grants(): Promise<readonly Grant[]>
  /** May prompt the user. Resolves false if declined or not declared. */
  requestGrant(capability: CapabilityRequest): Promise<boolean>
}

export interface CapabilityRequest {
  readonly capability: string
  readonly patterns?: readonly Pattern[]
}

/**
 * `orivon.net.connectSecure`'s argument. Every field past `port` is
 * optional and carries Node's own `tls.connect` meaning under Node's own
 * name, except `alpnProtocols` (Node's `ALPNProtocols`). PEM values are
 * strings and binary ones `Uint8Array`, and each is bounded in size: an
 * oversized or malformed option rejects the call with `'invalid'` naming it.
 * Key material serves this one connection only: it is never written to disk
 * and never logged.
 */
export interface SecureConnectOptions {
  readonly host: string
  readonly port: number
  /**
   * Default true. `false` completes the handshake whatever the certificate
   * says, and the connection is then ENCRYPTED BUT UNAUTHENTICATED: anyone
   * on the network path can impersonate the server, read everything and
   * change it. That is the app's own choice, made in its own code (Electrum
   * servers, LND nodes and LAN services commonly present self-signed
   * certificates), and nothing the person granting the app was shown.
   * `SecureTcpSocket.authorized`/`authorizationError` still report what
   * verification found.
   */
  readonly rejectUnauthorized?: boolean
  /**
   * Trust anchors in PEM, one per string or several concatenated. They
   * REPLACE the runtime's built-in roots for this one connection, exactly as
   * Node's `ca` does; an app that wants both passes both.
   */
  readonly ca?: string | readonly string[]
  /** A client certificate chain in PEM, presented when the server asks for one. Paired with `key`; `pfx` is the alternative. */
  readonly cert?: string
  /** The private key for `cert`, in PEM. */
  readonly key?: string
  /** A PKCS#12 bundle holding a client certificate and its key. */
  readonly pfx?: Uint8Array
  /** Decrypts `key` or `pfx`. */
  readonly passphrase?: string
  /**
   * The name sent as SNI and verified against the certificate, when it
   * differs from `host`. Absent, it is `host` when that is a name; `''`
   * sends no SNI and verifies against `host`. Never an address literal.
   * What the connection reaches is decided by `host` alone.
   */
  readonly servername?: string
  /** Protocols offered through ALPN, most preferred first (`['h2', 'http/1.1']`). The one agreed is `SecureTcpSocket.alpnProtocol`. */
  readonly alpnProtocols?: readonly string[]
}

/**
 * Which programs may reach a listening TCP port or a bound UDP socket
 * (ADR-0034, `manifest.js`'s `BindScopes`). `'local'` is reachable only by
 * other programs on this same device; `'network'` is reachable from the
 * local network, and the internet if the port is forwarded. Each is a
 * separately declared and granted capability -- `'network'` covers
 * `'local'`, never the reverse.
 */
export type BindScope = 'local' | 'network'

export interface OrivonNet {
  /**
   * Opens an outbound TCP connection. `host` may be a hostname or an address
   * literal; it is checked against the app's granted `tcp.connect` patterns
   * by the RESOLVED address, never by this string (security-model.md T12).
   * Rejects with `'denied'` if no granted pattern authorises the result.
   */
  connect(opts: { host: string, port: number }): Promise<TcpSocket>
  /**
   * Opens an outbound TCP connection and performs the TLS handshake IN THE
   * BROKER, on the trusted side, using the encryption stack already in the
   * shipped runtime (ADR-0017) -- no new dependency, so Rule 8 is
   * unaffected. The app never handles ciphertext: the returned handle
   * carries plaintext bytes on `readable`/`writable`, exactly as
   * `connect()`'s does, plus what the handshake established
   * (`SecureTcpSocket`, ./handles.js).
   *
   * BY DEFAULT the broker validates the certificate chain against the
   * runtime's built-in roots and the certificate against `host`, and a
   * failure rejects the call. `SecureConnectOptions` below carries Node's
   * own `tls.connect` options for changing that -- trust anchors, skipping
   * verification, a client certificate, SNI, ALPN -- and each is honoured
   * as Node honours it: that choice is the app's own, made in its own code.
   *
   * `host` is checked against the app's granted `https.connect` patterns
   * BY THE HOSTNAME ITSELF, not the resolved address -- the one deliberate
   * departure from `connect()`'s matching rule, and safe rather than a
   * regression of T12 ONLY WHILE the handshake verifies the peer's
   * certificate for `host` against the built-in roots: that verification is
   * what binds the name to whoever answered, cryptographically, which is
   * exactly the binding a resolved-address match exists to approximate for
   * plain TCP. An option that removes that binding (`rejectUnauthorized:
   * false`, the app's own `ca`, or a `servername` other than `host`) makes
   * the broker ALSO resolve `host` once, require every address to pass the
   * rule `connect()` applies (security-model.md T12), and dial the address
   * it checked. So an option can only ever narrow what a grant reaches,
   * never widen it, and `servername` never takes part in the grant check.
   *
   * This is a capability distinct from `tcp.connect` (`manifest.js`'s
   * `HttpsCapability`) -- granting one never grants the other, and the raw
   * `connect()` path above is unchanged by this method's existence.
   *
   * Rejects with `'denied'` if no granted pattern authorises `host`, and
   * with `'invalid'` for an option of the wrong type, an oversized one, or
   * credentials the runtime cannot load. A failed handshake or a
   * certificate/hostname mismatch rejects with `'unreachable'` and a real
   * `platformCode` -- the attempt was one the app was permitted to make, so
   * it gets the true, specific reason (handle-contracts.md's Errors-section
   * owner decision, 2026-08-26), not a generic denial.
   */
  connectSecure(opts: SecureConnectOptions): Promise<SecureTcpSocket>
  /**
   * Opens a TCP listening socket on `port`, checked against the app's
   * granted `tcp.listen.local` or `tcp.listen.network` patterns depending
   * on `scope` (ADR-0034). Omitted `scope` means `'local'`: reachable only
   * by other programs on this device. `'network'` binds every interface,
   * reachable from the local network and the internet if forwarded, and
   * needs the `network` grant specifically -- a `local` grant does not
   * cover it. `port: 0` asks the OS to pick; the real port is on the
   * returned `TcpServer.localPort` before this promise resolves (Handle
   * rule 3, ./handles.js). `TcpServer.localAddress` reports which
   * interface was actually bound (`127.0.0.1` for `'local'`, `0.0.0.0` for
   * `'network'`).
   */
  listen(opts: { port: number, scope?: BindScope }): Promise<TcpServer>
  /**
   * Binds a UDP socket on `port`, checked against `udp.bind.local` or
   * `udp.bind.network` depending on `scope` (ADR-0034). Same `scope`
   * default, grant relationship and `port: 0` behaviour as `listen`.
   */
  udpBind(opts: { port: number, scope?: BindScope }): Promise<UdpSocket>
  /**
   * Resolves `hostname` on the app's behalf -- DNS resolution happens IN
   * THE BROKER (D-0006), because a sandboxed renderer has no resolver of
   * its own and no pure-JS polyfill can answer one (A107): a ported
   * dependency that calls `dns.lookup` directly is a real, confirmed case
   * (`k-rpc-socket`, resolving a DHT bootstrap peer named by hostname), not
   * a hypothetical one.
   *
   * BOUNDED BY THE APP'S OWN NETWORK GRANT, NOT A SEPARATE CAPABILITY
   * (d-0030) -- there is no `dns` grant to request or revoke; this rides
   * whatever `tcp.connect`, `https.connect` and `udp.send` patterns
   * (manifest.js) the app already holds. Resolving a name is an
   * exfiltration channel in its own right: `what-i-stole.attacker.example`
   * carries data out through the resolution itself, even for a host the
   * app could never actually connect to. An unbounded resolver would hand
   * every network-capable app a covert channel to anywhere, so `hostname`
   * is checked against the HOST portion of the app's held outbound
   * patterns -- the same patterns `connect`, `connectSecure` and a
   * `UdpSocket`'s own `writable` (./handles.js) already check their own
   * resolved or requested addresses against. An
   * app holding a `"*:*"` pattern on any of those (unlimited network) gets
   * unlimited lookups, because it can already reach anywhere this opens
   * nothing new; an app holding only specific hosts may resolve only
   * those. Rejects with 'denied', uniform and detail-free like every other
   * 'denied' in this file (errors.ts), when no held pattern's host
   * authorises `hostname`.
   *
   * Rejects with 'unreachable' -- errors.ts already lists a DNS failure
   * under that code -- and a real `platformCode` (e.g. Node's own
   * `ENOTFOUND`) when `hostname` was one the app was permitted to resolve
   * but resolution itself found nothing, the same "true reason for a
   * permitted attempt" rule `connect`'s own errors already follow.
   *
   * Returns every address the resolver gave, IN THE ORDER IT GAVE THEM --
   * never re-sorted, never reduced to one, so `orivon-node-shim`'s own
   * `dns.lookup` can present Node's `{ all: true }` shape directly and its
   * default single-result shape by taking this array's first entry, with
   * no second round trip either way.
   */
  lookup(opts: { hostname: string }): Promise<readonly LookupAddress[]>
}

/**
 * Rooted at the app's files directory. `..` traversal is rejected, resolved
 * and confined IN THE BROKER, never trusted from the renderer. Outside access
 * exists only through userSelected.
 *
 * The app's CODE CACHE is read-only to the app (ADR-0003): an app that could
 * rewrite its own code would escape the manifest its grants were issued
 * against.
 *
 * BYTE-ORIENTED, SETTLED (owner decision, 2026-09-09, `open-questions.md`
 * A12). No encoding option anywhere on this interface -- text decoding is
 * `orivon-node-shim`'s job, one layer up, alongside the file cursor it
 * already owns (`handle-contracts.md`'s FileHandle section). This confirms the
 * reading these signatures already carried; nothing here changed shape to
 * reach this status, only the PROVISIONAL marker it used to carry is gone.
 */
export interface OrivonFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  /**
   * Synchronous read (ADR-0016). The renderer genuinely blocks until this
   * returns, over the runtime's synchronous renderer-to-main channel today
   * -- an `Atomics.wait`-in-a-Worker route is deferred, not rejected, as a
   * future swap for the same mechanism, and both present this exact
   * signature, so no app can tell which one answered it.
   *
   * The one exception design rule 2 grants (see this file's header comment)
   * and it is narrow on purpose: permitted because `readFileSync`-shaped
   * calls are how a ported Node dependency reads its own configuration
   * before anything else runs, usually from code the porting developer does
   * not control, and an async-only `fs` did not make that call slow -- it
   * made it absent, throwing the app before it ever renders.
   *
   * Same confinement and the same closed error set as `readFile`, but
   * THROWN rather than rejected -- a synchronous call has no Promise to
   * reject. A chatty caller freezes the renderer for the duration of every
   * call; that cost is the app's own and is visible, not a reason to widen
   * this exception to any other `fs` method.
   */
  readFileSync(path: string): Uint8Array
  open(path: string, flags: string): Promise<FileHandle>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  stat(path: string): Promise<FileStat>
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  /**
   * The OS picker -- files, or (`directory: true`) a single folder. The
   * app declares which it needs; native chrome shows the matching dialog.
   * The user's choice IS the consent for either shape -- no separate
   * grant.
   *
   * FOLDERS ARE NOT FILES, by design, not oversight (d-0029): a picked
   * folder becomes a `DirectoryHandle` (./handles.js), never a `FileHandle`
   * wearing a directory's clothes -- see that interface's own doc comment
   * for what operations it offers and how its confinement works, and
   * `FileHandle`'s own doc comment for what persists across a restart and
   * how to revoke it (both handles share the same D-0007 answer).
   *
   * OVERLOADED ON THE LITERAL `directory` VALUE, so the return type is
   * honest for both shapes with no union and no cast at the call site:
   * pass `directory: true` and the result is already typed
   * `DirectoryHandle | null`. `multiple` applies only to the file shape -- a
   * native folder picker offers one folder per pick, so pairing it with
   * `directory: true` would be an option that silently does nothing,
   * which is the same "no implicit capability" spirit design rule 5 states
   * for grants, applied here to an option rather than a permission.
   *
   * A picked folder resolves `DirectoryHandle | null` -- null on
   * cancellation, matching the true cardinality (at most one folder, never
   * a list of them) rather than forcing an empty array the way the file
   * shape below does. Cancelling the file picker resolves an empty array;
   * declining either dialog is never a rejected promise, because declining
   * a picker is not a failure.
   */
  userSelected(opts: { directory: true }): Promise<DirectoryHandle | null>
  userSelected(opts?: { directory?: false, multiple?: boolean }): Promise<readonly FileHandle[]>
}

/**
 * TWO KINDS OF IDENTITY, and conflating them is a recorded past error
 * (capability-api.md's "Two kinds of identity" section).
 *
 * APP KEYS -- publicKey/sign -- are per-origin and silent. They need no
 * consent because they cannot link users across apps.
 *
 * NAMED IDENTITIES -- requestIdentity -- are cross-origin BY DESIGN, behind an
 * explicit connect prompt per site. Nostr requires this: an npub must be the
 * SAME across every client, or follows, posts and identity fragment per
 * client. The original draft said `id` yields per-origin keys only, which
 * cannot support Nostr at all.
 *
 * The seed is never exposed and raw key export is not a capability at any
 * tier. Derive a distinct secret per (label, curve) with length-prefixed
 * HKDF -- one scalar reused across two schemes voids the security argument
 * for both.
 */
export interface OrivonId {
  /** derive(seed, "app", origin). Silent, no prompt. */
  publicKey(opts: { curve: string }): Promise<Uint8Array>
  /** Signs `payload` with the same per-origin key `publicKey` returns for this `curve`. Silent, no prompt. */
  sign(opts: { curve: string, payload: Uint8Array }): Promise<Uint8Array>
  /** derive(seed, "identity", identityId). Triggers the connect prompt. */
  requestIdentity(opts: { kind: string }): Promise<IdentityHandle | null>
}

/**
 * ADR-0019. What this adds over `https.connect` is exactly one thing: a script
 * environment whose `location.origin` is a site the person named at consent.
 * An app holding `https.connect` for that host can already send it any request
 * and read any response (ADR-0017); it cannot, without this, run a script AS
 * that site -- which is what a site's own origin-bound bot-check requires.
 */
export interface OrivonWeb {
  /**
   * Opens an isolated context: an empty document whose origin is `origin`, in
   * a storage partition that holds nothing when it opens and is cleared when
   * it closes.
   *
   * THE CONTEXT HAS NO `orivon.*`, NO COOKIES, AND IS NEVER DISPLAYED. It
   * cannot navigate, open windows, download, or be granted any web
   * permission. It has no network of its own: every request it makes is
   * authorised against THIS app's `https.connect` grant, exactly as if the
   * app had made it, so a host the app may not reach, the context may not
   * reach either.
   *
   * Rejects 'invalid' unless `origin` is an exact https origin; 'denied'
   * unless a live `web.context` grant names it exactly (never saying which of
   * the two failed); 'limit' past `LIMITS.webContexts` open at once.
   */
  openContext(origin: string, options?: WebContextOptions): Promise<WebContext>
}

export interface WebContextOptions {
  /** The viewport the document reports, in CSS pixels. Default 1920 x 1080; each clamped to 1..7680. */
  readonly width?: number
  readonly height?: number
}

/**
 * ADR-0033. An origin-bound encrypt/decrypt pair, backed by the OS keyring
 * through Electron `safeStorage` -- what lets an app hold a secret across
 * restarts without ever holding, or being able to derive, the identity seed
 * itself. `ADR-0003`'s "no app, ever" still governs the seed; this is a
 * SEPARATE, derived secret, one per origin, the same relationship `id`'s app
 * keys already have to the seed they come from.
 *
 * BYTES ONLY, like every other capability here (`OrivonFs`'s A12 precedent):
 * an app decides its own encoding one layer up.
 *
 * `decrypt` rejects `'invalid'` for bytes this origin's key did not
 * produce -- there is no cross-origin decrypt, by construction, not by a
 * check that could be bypassed: the key itself is derived per origin.
 */
export interface OrivonSecrets {
  /**
   * Whether `encrypt` can succeed right now. `false` when the person holds
   * no live `secrets` grant, OR when the seed this origin's key derives from
   * is session-only (no OS keyring reachable) -- ciphertext made from a
   * session-only seed cannot be decrypted after a restart, so an app that
   * checks first can choose not to rely on it rather than lose data
   * silently. Never throws for "no grant"; that is exactly the `false` case.
   */
  available(): Promise<boolean>
  /**
   * Encrypts `plaintext` with a key derived for this origin alone.
   *
   * Rejects `'denied'` with no live `secrets` grant; `'unavailable'` when
   * the seed is session-only (see `available()`); `'limit'` past
   * `LIMITS.secretBytes`.
   */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>
  /**
   * Reverses `encrypt`. Rejects `'denied'` with no live `secrets` grant;
   * `'invalid'` for bytes this origin's key did not produce, including
   * another origin's ciphertext or anything hand-edited.
   */
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>
}
