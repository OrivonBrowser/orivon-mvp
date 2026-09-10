// Transcribed from docs/architecture/capability-api.md's "v0 surface" section.
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
  FileHandle,
  FileStat,
  IdentityHandle,
  TcpServer,
  TcpSocket,
  UdpSocket
} from './handles.js'
import type { Grant, Manifest, Pattern } from './manifest.js'

/** The root object injected into an app's page as `orivon`. */
export interface Orivon {
  readonly version: 0
  readonly app: OrivonApp
  readonly net: OrivonNet
  readonly fs: OrivonFs
  readonly id: OrivonId
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

export interface OrivonNet {
  /**
   * Opens an outbound TCP connection. `host` may be a hostname or an address
   * literal; it is checked against the app's granted `tcp.connect` patterns
   * by the RESOLVED address, never by this string (security-model.md T12).
   * Rejects with `'denied'` if no granted pattern authorises the result.
   */
  connect(opts: { host: string, port: number }): Promise<TcpSocket>
  /**
   * Opens an outbound TCP connection and performs the TLS handshake,
   * certificate chain validation and hostname verification IN THE BROKER,
   * on the trusted side, using the encryption stack already in the shipped
   * runtime (ADR-0017) -- no new dependency, so Rule 8 is unaffected. The
   * app never sees ciphertext or certificate material: the returned handle
   * is the same `TcpSocket` shape `connect()` returns, carrying plaintext
   * bytes on `readable`/`writable` (handle-contracts.md's own TcpSocket section
   * defines that shape; nothing new is defined for this method).
   *
   * `host` is checked against the app's granted `https.connect` patterns
   * BY THE HOSTNAME ITSELF, not the resolved address -- the one deliberate
   * departure from `connect()`'s matching rule, and safe rather than a
   * regression of T12: the broker's own certificate/hostname verification
   * already binds that hostname to whoever answered, cryptographically,
   * which is exactly the binding a resolved-address match exists to
   * approximate for plain TCP. This is a capability distinct from
   * `tcp.connect` (`manifest.js`'s `HttpsCapability`) -- granting one never
   * grants the other, and the raw `connect()` path above is unchanged by
   * this method's existence.
   *
   * Rejects with `'denied'` if no granted pattern authorises `host`. A
   * failed handshake or a certificate/hostname mismatch rejects with
   * `'unreachable'` and a real `platformCode` -- the attempt was one the
   * app was permitted to make, so it gets the true, specific reason
   * (handle-contracts.md's Errors-section owner decision, 2026-08-26), not a
   * generic denial.
   */
  connectSecure(opts: { host: string, port: number }): Promise<TcpSocket>
  /**
   * Opens a TCP listening socket on `port`, checked against the app's
   * granted `tcp.listen` patterns. `port: 0` asks the OS to pick; the real
   * port is on the returned `TcpServer.localPort` before this promise
   * resolves (Handle rule 3, ./handles.js).
   */
  listen(opts: { port: number }): Promise<TcpServer>
  /** Binds a UDP socket on `port`, checked against `udp.bind`. Same `port: 0` behaviour as `listen`. */
  udpBind(opts: { port: number }): Promise<UdpSocket>
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
  /** The OS file picker. The user's choice IS the consent -- no separate grant. */
  userSelected(opts?: { multiple?: boolean }): Promise<readonly FileHandle[]>
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
