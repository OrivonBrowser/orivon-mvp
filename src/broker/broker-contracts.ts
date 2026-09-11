// The broker's own vocabulary -- pure type and interface declarations with no
// runtime behaviour, split out of ./index.ts so that file could stay under
// the 500-line guideline (docs/development/code-guidelines.md Rule 2). No
// state lives here.
//
// See ./index.ts's header for what createBroker actually does, why its
// dependency shape is fixed, and what `Broker` is for.

import type { DestroyResource, FailableTcpServer, FailableTcpSocket, FailableUdpSocket } from './handles/handle-contracts.js'
import type { LedgerStorage } from './grants/ledger-storage.js'
import type { PortRange } from './policy/bind.js'
import type { Resolver } from './policy/connect.js'
import type {
  CapabilityKind,
  Datagram,
  Grant,
  GrantId,
  Handle,
  Manifest,
  OrivonErrorCode,
  Pattern,
  TcpSocket
} from '../contracts/index.js'

/**
 * What `orivon.net.connect` needs from a live TCP connection, minus the
 * handle-table bookkeeping (`id`/`closed`/`close()`) that `createBroker`
 * supplies once the connection is registered.
 *
 * Built from `Omit<TcpSocket, keyof Handle>` rather than redeclaring
 * readable/writable/remoteAddress/... a second time -- one definition of what
 * a connected socket looks like (docs/development/code-guidelines.md Rule 3),
 * the same argument policy/paths.ts and policy/canonical-path.ts make for
 * sharing the Windows-device-name table instead of each keeping a copy.
 */
export interface DialedSocket extends Omit<TcpSocket, keyof Handle> {
  /** Matches HandleTable's DestroyResource exactly -- `acquire()` below uses it directly as the handle's destroy callback. */
  readonly destroy: DestroyResource
}

/**
 * Opens a TCP connection to one of `addresses` -- every element already
 * validated by `checkConnect` (policy/connect.ts's header: resolve once,
 * check every answer, dial the literal that was checked, never the hostname
 * again). More than one address is handed over on purpose: Node 24 defaults
 * `autoSelectFamily: true`, and narrowing to a single address here would
 * quietly undo that. `dial` owns the happy-eyeballs / fallback strategy
 * across them, not this file.
 *
 * `signal` fires the instant the grant authorising this connection is
 * revoked while the dial is still in flight. A `dial` that ignores it leaves
 * a socket connecting for a capability the app no longer holds -- see
 * `HandleTable.run`'s own note, in ./handles/handles.ts, to whoever writes this path.
 */
export type Dial = (addresses: readonly string[], port: number, signal: AbortSignal) => Promise<DialedSocket>

/**
 * Opens a TLS-secured connection to `host`:`port` -- the handshake,
 * certificate chain validation and hostname verification all happen inside
 * this call, on the trusted side (ADR-0017, ../adapters/tls-adapter.ts).
 *
 * TAKES THE HOSTNAME DIRECTLY, unlike `Dial`'s pre-resolved `addresses`
 * array, and that difference is the point: `checkConnectSecure`
 * (policy/connect-secure.ts) authorises by hostname, never by resolved
 * address, because THIS call's own certificate/hostname check is what binds
 * the hostname to whoever answered -- there is no separate resolve-then-
 * check step upstream to hand this a validated address list. `host` is
 * exactly `ConnectSecureAllowed.host` -- already normalised, already
 * checked against the grant -- and is used for both the DNS lookup and the
 * certificate/SNI hostname check, so nothing here can dial one name while
 * verifying another.
 *
 * `signal` fires the instant the grant authorising this connection is
 * revoked while the handshake is still in flight, exactly as `Dial`'s does.
 */
export type DialSecure = (host: string, port: number, signal: AbortSignal) => Promise<DialedSocket>

/**
 * One outbound datagram's fate.
 *
 * NEVER A REJECTION, and that is the point of it being a value. A caller's
 * only way to report a rejected send is to error the app's
 * `WritableStream<Datagram>`, which errors it PERMANENTLY -- and a denied
 * destination is ordinary traffic for a P2P app, so the first DHT peer outside
 * the granted patterns would tear down a working swarm
 * (docs/open-questions.md A87). The send is absorbed, the datagram is
 * discarded, and the caller counts it.
 */
export type SendOutcome =
  | { readonly sent: true }
  | { readonly sent: false, readonly code: OrivonErrorCode, readonly platformCode?: string }

/**
 * What `orivon.net.udpBind` needs from a bound UDP socket, minus the handle
 * bookkeeping (`id`/`closed`/`close()`) `createBroker` supplies.
 *
 * NOT `Omit<UdpSocket, keyof Handle>`, unlike DialedSocket above, and the
 * difference is deliberate rather than an oversight: the contract's
 * `writable: WritableStream<Datagram>` CANNOT express the specified behaviour
 * on this side of the boundary, because a WritableStream sink reports a single
 * failed write only by rejecting, and that errors the stream. `send` returning
 * a SendOutcome is what lets a refusal be counted instead. The app still gets
 * a real `WritableStream<Datagram>`; it is built in the main world over the
 * port (src/preload/), the same way its TCP counterpart is.
 */
export interface BoundUdpSocket {
  readonly readable: ReadableStream<Datagram>
  readonly send: (datagram: Datagram) => Promise<SendOutcome>
  readonly localAddress: string
  /** Resolved BEFORE this object exists -- handle-contracts.md SSUdpSocket. */
  readonly localPort: number
  /** Live, not a snapshot: implementations expose it as a getter. */
  readonly droppedInbound: number
  readonly destroy: DestroyResource
}

/**
 * Binds a UDP socket to a free port inside `ranges` -- every range already
 * returned by `checkBind` (policy/bind.ts), which is what makes "an ephemeral
 * port still lands inside what the user approved" structural rather than
 * remembered. An implementation MUST NOT bind outside them, and MUST fail with
 * 'limit' rather than widening when every port in them is taken.
 *
 * `signal` fires the instant the grant authorising this bind is revoked while
 * the bind is still in flight, exactly as `Dial`'s does.
 */
export type Bind = (ranges: readonly PortRange[], signal: AbortSignal) => Promise<BoundUdpSocket>

/**
 * A listening TCP server's own side of the `Listen` contract below: what
 * `orivon.net.listen` needs beyond the handle bookkeeping `createBroker`
 * supplies once the server is registered.
 *
 * `accept()` IS THE PULL. handle-contracts.md's "TcpServer" section specifies
 * `connections` as a stream created with `highWaterMark: 0` so the broker
 * never pre-accepts a connection the app has not asked for by reading --
 * `../index.ts`'s `listen` calls this exactly once per `ReadableStream`
 * `pull()`, which is exactly once per app `read()`.
 *
 * RESOLVES null ONLY FOR A GRACEFUL END ('closed'/'sessionEnded' --
 * ../handles/handle-contracts.ts's CloseReason), matching `connections`'
 * own `controller.close()`. It REJECTS for an abrupt one ('revoked'/
 * 'aborted'/'failed'): a pending `accept()` is exactly the "promise the app
 * is awaiting on this handle" the "Revocation" section requires to reject,
 * and the generic handle-table cascade (`HandleTable.revoke`) has no
 * reference to this bespoke `ReadableStream`'s own pull promise -- only to
 * `ListenedServer.destroy` below, which is what settles it either way.
 */
export interface ListenedServer {
  readonly localAddress: string
  /** Resolved BEFORE this object exists -- handle-contracts.md SSTcpServer, same rule as UdpSocket's localPort. */
  readonly localPort: number
  accept(): Promise<DialedSocket | null>
  readonly destroy: DestroyResource
}

/**
 * Opens a TCP listening socket inside `ranges` -- every range already
 * returned by `checkBind` (policy/bind.ts, shared with `Bind` above: its own
 * header has always anticipated this second caller). An implementation MUST
 * NOT listen outside them, and MUST fail with 'limit' rather than widening
 * when every port in them is taken.
 *
 * `signal` fires the instant the grant authorising this listen is revoked
 * while the bind is still in flight, exactly as `Dial`'s and `Bind`'s do.
 */
export type Listen = (ranges: readonly PortRange[], signal: AbortSignal) => Promise<ListenedServer>

/** What `fs.stat` reports. Mirrors `contracts/handles.ts`'s `FileStat` exactly -- one shape, not redeclared. */
export interface RawFileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

/**
 * What `orivon.fs` needs from the real filesystem. `policy/paths.ts` stays
 * pure; this is the one seam where confinement's decision touches disk.
 *
 * Every method below receives an ALREADY-CONFINED absolute path (or two, for
 * `rename`) -- `./fs-capability.ts` is the only caller, and it never hands
 * this interface anything that has not already passed `confinePath`. This
 * layer's job is raw I/O, nothing else.
 */
export interface BrokerFs {
  /**
   * The absolute directory `origin`'s files are confined to. Computed by the
   * INJECTED implementation, not here: security-model.md T13b makes it
   * `sha256(canonical origin)` under the app data directory, and that
   * directory lives outside anything this pure-orchestration layer knows --
   * there is no `electron`, and no user-data path, in createBroker's fixed
   * dependency shape. AI recommendation, not an owner decision: nothing in
   * the corpus specifies which side of this seam computes the root.
   */
  rootFor(origin: string): string
  /** `confinePath`'s `realpath` parameter (policy/paths.ts). Synchronous, matching node:fs's `realpathSync`. */
  realpathSync(path: string): string
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  stat(path: string): Promise<RawFileStat>
  /** `force` is never exposed above this layer -- a missing path surfaces ENOENT, mapped to `notFound`, the same as every other fs call. */
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

/**
 * Backs `orivon.id` -- key derivation from a locked seed (ADR-0010,
 * policy/derive.ts). Not yet used: `createBroker` accepts it because
 * build-plan.md fixes the constructor's shape once, for every capability
 * that eventually needs a piece of it. Nothing below calls it yet.
 */
export interface Keychain {
  getSeed(): Promise<Uint8Array>
}

export interface CreateBrokerOptions {
  readonly dial: Dial
  readonly dialSecure: DialSecure
  readonly bind: Bind
  readonly listen: Listen
  readonly resolve: Resolver
  /** Clock, read once per grant -- `Grant.grantedAt`. Injected so a test can freeze it. */
  readonly now: () => number
  readonly fs: BrokerFs
  readonly keychain: Keychain
  /**
   * Where `GrantLedger`'s version floor survives a restart (A57,
   * `docs/open-questions.md`). Optional so every existing caller of this
   * function -- every test in this codebase constructs `createBroker`
   * with no persistence in mind -- keeps working unchanged: omitting it is
   * exactly today's in-memory-only behaviour, not a degraded mode.
   */
  readonly ledgerStorage?: LedgerStorage
}

/**
 * The broker's own surface, distinct from `Orivon` (src/contracts/
 * capability-api.ts). `Orivon` is origin-IMPLICIT -- it is constructed once
 * per renderer by the (not-yet-built) IPC layer, which already knows which
 * app is asking. A single broker instance serves every origin at once, so
 * every method here takes `origin` explicitly; the IPC layer's job is to
 * derive it from `event.senderFrame` (T3) and never trust one in a payload.
 *
 * `registerApp`, `grant` and `revoke` have no `orivon.*` counterpart at all --
 * they are the seams the app loader and the permission-prompt UI (both later
 * build steps) call. An app can reach `app`/`net`/`fs`; it can never reach
 * these three, because nothing wires `orivon.*` to them.
 */
export interface Broker {
  readonly app: {
    manifest(origin: string): Promise<Manifest>
    /** What was ACTUALLY granted -- read from the ledger, never the manifest. */
    grants(origin: string): Promise<readonly Grant[]>
    /**
     * SYNCHRONOUS -- see `../index.ts`'s own doc on `isRegisteredSync` for
     * why this one method on this interface is not async: an in-process
     * main-process caller (tab construction) needs an answer before
     * `WebContentsView` exists, with no IPC round trip to await. Never
     * throws; an unparseable `origin` is simply "not registered".
     */
    isRegisteredSync(origin: string): boolean
    /**
     * Every origin the broker currently knows an app for, including those
     * brought back from disk at startup -- what the settings permissions
     * list enumerates so it is populated before any app is opened.
     * SYNCHRONOUS for the same reason `isRegisteredSync` is: it reads the
     * in-memory ledger and cannot fail.
     */
    registeredOriginsSync(): readonly string[]
  }
  readonly net: {
    /** Returns a `FailableTcpSocket` -- a `TcpSocket` plus one broker-internal
     * escape hatch, see handle-contracts.ts. */
    connect(origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket>
    /**
     * TLS terminated on the trusted side (ADR-0017) -- checked against
     * `https.connect`, a SEPARATE grant from `tcp.connect` above, matched by
     * the hostname itself rather than a resolved address (policy/connect-
     * secure.ts's own header explains why that is safe here). Returns the
     * same `FailableTcpSocket` shape `connect` does; nothing about the
     * connection being TLS is visible on the handle itself.
     */
    connectSecure(origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket>
    /**
     * `port: 0` means "any free port", and it still binds only inside the
     * granted ranges (policy/bind.ts, docs/open-questions.md A88).
     *
     * The returned socket's `send` is ALREADY AUTHORISED PER DATAGRAM against
     * this origin's live `udp.send` grant -- the caller cannot reach an
     * unchecked send path, because there is not one. Re-read live rather than
     * captured at bind, so a revoke stops the next datagram rather than the
     * next bind (the lesson A70 recorded for `net.close`).
     */
    udpBind(origin: string, opts: { port: number }): Promise<FailableUdpSocket>
    /**
     * Opens a TCP listening socket on `port`, checked against `tcp.listen`.
     * `port: 0` asks the OS to pick, same rule as `udpBind`'s (A88).
     *
     * Returns a `FailableTcpServer` -- a `TcpServer` plus the broker-internal
     * escape hatch every handle type gets, see handle-contracts.ts. Each
     * connection its `connections` stream yields is itself a
     * `FailableTcpSocket`, a DERIVED handle inheriting this server's grant
     * (handle-contracts.md's "Revocation" section): closing or revoking the
     * server tears down every socket it produced that is still open.
     */
    listen(origin: string, opts: { port: number }): Promise<FailableTcpServer>
  }
  readonly fs: {
    readFile(origin: string, path: string): Promise<Uint8Array>
    writeFile(origin: string, path: string, data: Uint8Array): Promise<void>
    /**
     * ADR-0016's synchronous entry point: the SAME grant check and path
     * confinement `readFile`/`writeFile` use (`../index.ts`'s
     * `confineForOrigin`), exposed synchronously for `orivon.fs.
     * readFileSync`'s main-process handler (`../transport/sync-fs.ts`),
     * which cannot await a Promise on this path. Returns the confined
     * absolute path; throws an OrivonError ('denied') on refusal. Does NOT
     * run under the per-origin in-flight budget `readFile`/`writeFile` do
     * -- see `../index.ts`'s own doc on `confineSync` for why that budget
     * is `async`-shaped and this call, by ADR-0016's own design, is not.
     */
    confineSync(origin: string, path: string): string
    /**
     * Confined the same way `readFile`/`writeFile` are (`../fs-capability.ts`'s
     * `confineForOrigin`) and run under the same per-origin in-flight budget
     * (`runFsIo`). `recursive: true` matches `node:fs/promises.mkdir`'s own
     * flag; omitted or `false`, a missing parent yields `notFound` (mapped
     * ENOENT), the same failure shape every other fs call already produces.
     */
    mkdir(origin: string, path: string, opts?: { recursive?: boolean }): Promise<void>
    /** Confined and budgeted like `readFile`. Entry NAMES only, never full paths -- matching `contracts/capability-api.ts`'s `Promise<readonly string[]>`. */
    readdir(origin: string, path: string): Promise<readonly string[]>
    /** Confined and budgeted like `readFile`. Mirrors `contracts/handles.ts`'s `FileStat` shape exactly. */
    stat(origin: string, path: string): Promise<RawFileStat>
    /**
     * Confined and budgeted like `writeFile`, but reserves no quota: quota
     * tracks bytes WRITTEN (`fs.writeFile`'s own doc), and deleting is never
     * a write. `recursive: true` matches `node:fs/promises.rm`; `force` is
     * never exposed -- a missing path yields `notFound`, same as every other
     * fs call.
     */
    rm(origin: string, path: string, opts?: { recursive?: boolean }): Promise<void>
    /**
     * BOTH `from` AND `to` are independently confined before anything on
     * disk moves -- see `../fs-capability.ts`'s own doc for why a check on
     * `from` alone would turn this into an arbitrary-write primitive. Runs
     * under `from`'s in-flight budget slot (the same grant authorises both
     * paths, so either would do).
     */
    rename(origin: string, from: string, to: string): Promise<void>
  }
  /**
   * The APP KEYS half of capability-api.ts's "Two kinds of identity" --
   * per-origin, silent, checked against a live `id` grant whose `patterns`
   * are the curves that grant actually names (manifest.ts's
   * `IdCapability.curves`). NOT `requestIdentity` (the NAMED IDENTITIES
   * half): that one needs the connect-prompt UI, which does not exist yet,
   * and has no `Broker` entry point here for the same reason
   * `preload/README.md` gives for leaving a method off `window.orivon`
   * entirely rather than wiring one that can only ever fail.
   */
  readonly id: {
    /** Silent, no prompt -- checked against the `id` grant only. 'invalid' for an unrecognised curve, 'internal' for a recognised one this policy layer cannot serve yet (id-capability.ts, policy/derive-p256.ts). */
    publicKey(origin: string, opts: { curve: string }): Promise<Uint8Array>
    /** Same per-origin key `publicKey` returns for this `curve`. Same error shape as `publicKey`. */
    sign(origin: string, opts: { curve: string, payload: Uint8Array }): Promise<Uint8Array>
  }
  /**
   * Registers -- or replaces -- an origin's manifest. Called once per app
   * session, before any capability call for that origin. Existing grants are
   * left untouched (GrantLedger, below).
   *
   * `async` for the same reason `grant` is: `canonical()` throws
   * synchronously on a malformed origin, and every other Broker method
   * already rejects rather than throwing. A caller wrapping the whole
   * surface in one uniform `.catch()` must not have to special-case this one.
   *
   * REJECTS ONLY ON A BROKER FAULT, never on anything the app did. The
   * version floor is raised in memory before this can reject, so a rejection
   * means the raise was not written to disk -- not that the registration was
   * refused (`GrantLedger.registerApp`).
   */
  registerApp(origin: string, manifest: Manifest): Promise<void>
  /**
   * T19's version floor: the highest version `registerApp` has ever recorded
   * for this origin, `'0.0.0'` for one never registered. The app loader's
   * seam, same category as `registerApp`/`grant`/`revoke` -- no `orivon.*`
   * counterpart, an app can never read its own floor.
   */
  versionFloorFor(origin: string): Promise<string>
  /**
   * d-0017 (owner decision): the SPECIFIC below-floor version this origin's
   * rollback was last acknowledged for, or `undefined` if never
   * acknowledged (or if the persisted record was corrupt --
   * `LedgerStorage.readAcknowledgedRollbackVersion`'s own doc explains why
   * that collapse is the only safe one). NOT a boolean: a flag would let
   * accepting one real rollback silently cover any other below-floor
   * version the same origin later serves -- see `GrantLedger`'s own doc for
   * the finding that drove this. The caller compares this against whatever
   * below-floor version is being offered and prompts fresh on anything but
   * an exact match. Same category as `versionFloorFor`: the app loader's
   * seam, no `orivon.*` counterpart.
   */
  rollbackAcknowledgedVersionFor(origin: string): Promise<string | undefined>
  /**
   * Records that `origin`'s rollback to `version` has been acknowledged
   * (d-0017) -- meant to be called once, at the point a future UI
   * determines the user actually chose to accept that specific below-floor
   * version. This broker never calls it on its own initiative, the same
   * way it never grants a capability on its own initiative.
   */
  acknowledgeRollback(origin: string, version: string): Promise<void>
  /**
   * Records a capability the user actually granted. The broker never grants
   * on its own initiative; this is the permission-prompt UI's seam, never an
   * app's. Replaces any earlier grant of the same capability kind, under a
   * freshly minted GrantId (open-questions.md A21 -- `HandleTable.grantIssued`
   * is called either way, so a future GrantId-reuse decision costs nothing
   * here).
   *
   * A replaced grant is revoked in the handle table SYNCHRONOUSLY inside this
   * call, before it returns -- not lazily, not on the next operation. Without
   * that, a capability the user just replaced stays live, permanently
   * unrevocable (nothing keeps its old GrantId once app.grants() drops it),
   * and invisible to every future caller. `async` here is that revoke, not a
   * cosmetic change -- see GrantLedger.grant's own doc.
   */
  grant(origin: string, capability: CapabilityKind, patterns: readonly Pattern[]): Promise<Grant>
  /**
   * Withdraws one grant. Delegates the cascade to the handle table --
   * (handle-contracts.md's "Revocation" section) -- rather than reimplementing it: every
   * handle the grant authorised closes at once, abruptly, and every promise
   * the app is awaiting on one of them rejects with 'revoked'.
   */
  revoke(origin: string, grantId: GrantId): Promise<void>
}
