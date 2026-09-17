// The broker's own vocabulary -- pure type and interface declarations with no
// runtime behaviour, split out of ./index.ts so that file could stay under
// the 500-line guideline (docs/development/code-guidelines.md Rule 2). No
// state lives here.
//
// See ./index.ts's header for what createBroker actually does, why its
// dependency shape is fixed, and what `Broker` is for.

import type { PersistedApp } from './grants/ledger-storage.js'
import type { DestroyResource, FailableTcpServer, FailableTcpSocket, FailableUdpSocket } from './handles/handle-contracts.js'
import type { LedgerStorage } from './grants/ledger-storage.js'
import type { PortRange } from './policy/bind.js'
import type { Resolver } from './policy/connect.js'
import type { BrokerFs, BrokerFsMethods } from './fs-contracts.js'
import type { PickedPath } from './grants/picked-path-ledger.js'
import type {
  CapabilityKind,
  Datagram,
  Grant,
  GrantId,
  Handle,
  LookupAddress,
  Manifest,
  OrivonErrorCode,
  Pattern,
  TcpSocket
} from '../contracts/index.js'

// RawFileStat, OpenedFile and BrokerFs itself live in ./fs-contracts.js now
// (split out once `open`'s types pushed this file past Rule 2's 500 lines)
// -- re-exported so no existing `from '../broker-contracts.js'` import site
// needs to change.
export type { BrokerFs, BrokerFsMethods, OpenedFile, RawFileStat } from './fs-contracts.js'
export type { PickedPath } from './grants/picked-path-ledger.js'

/**
 * Opens the real OS picker -- `orivon.fs.userSelected`'s own dependency,
 * the `Dial`/`Bind`/`Listen` pattern applied to a native dialog instead of a
 * socket. `directory: true` asks for the folder-picker chrome; `multiple`
 * is meaningless (and MUST be ignored) when `directory` is true, mirroring
 * `capability-api.ts`'s own `userSelected` overload split -- there is no
 * signal to pass it through as, so the injected implementation decides at
 * this boundary, not one layer up.
 *
 * NO `signal` PARAMETER, unlike `Dial`/`Bind`/`Listen` -- there is no grant
 * in flight for this to race (capability-api.ts: the picker choice IS the
 * authorisation, minted fresh the moment it resolves), so nothing can
 * revoke an acquisition that has not happened yet.
 *
 * `appName` is the requesting origin's own declared `manifest.name`
 * (`GrantLedger.manifestFor`, read by `user-selected-capability.ts` before
 * calling this), `undefined` only if no manifest was ever registered for
 * the origin. An implementation may use it to name the app in the dialog's
 * own chrome (d-0032) -- `transport/ipc.ts`'s `describePickerDialog` is the
 * real one that does.
 */
export type PickPath = (opts: { directory: boolean, multiple: boolean, appName: string | undefined }) => Promise<PickPathResult>

/**
 * `canceled: true` for a dismissed dialog -- capability-api.ts is explicit
 * that declining a picker is never a rejected promise, so this is a plain
 * value the caller branches on, not an error `PickPath` throws. `paths` are
 * real host OS paths, exactly what a native `dialog.showOpenDialog` hands
 * back; `userSelected` in ./user-selected-capability.ts is what turns them
 * into confined, revocable handles.
 */
export type PickPathResult =
  | { readonly canceled: true }
  | { readonly canceled: false, readonly paths: readonly string[] }

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
  /** `orivon.net.lookup`'s real DNS call (d-0030) -- ../adapters/node-adapters.ts's `resolveLookup`. */
  readonly resolveLookup: (hostname: string) => Promise<readonly LookupAddress[]>
  /** Clock, read once per grant -- `Grant.grantedAt`. Injected so a test can freeze it. */
  readonly now: () => number
  readonly fs: BrokerFs
  readonly keychain: Keychain
  /** `orivon.fs.userSelected`'s real OS picker (see `PickPath`'s own doc). */
  readonly pickPath: PickPath
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
     * Does `origin` hold at least one live grant? SYNCHRONOUS for the same
     * reason `isRegisteredSync` is, and used for the same kind of decision
     * that cannot wait: which Electron session a tab is built in.
     *
     * Separate from `isRegisteredSync` because installing and consenting are
     * different things (owner, 2026-09-16). An app can be loaded this session
     * with nothing granted to it, and an origin can hold grants restored from
     * disk before anything registers a manifest for it this run -- A158's
     * hydration seam exists precisely to make that second case true.
     */
    hasGrantsSync(origin: string): boolean
    /** Every origin the broker has an app loaded for this session. Synchronous
     * for the same reason `isRegisteredSync` is: it reads the in-memory ledger
     * and cannot fail. */
    registeredOriginsSync(): readonly string[]
    /**
     * The settings permissions list for apps NOT loaded this session, read off
     * disk. DISPLAY ONLY -- nothing here is a live grant, and no capability
     * call can be served from it (docs/open-questions.md A137). The app name
     * arrives as a plain string rather than a manifest, so there is nothing a
     * caller could mistake for an authority declaration.
     */
    persistedAppsSync(): readonly PersistedApp[]
    /**
     * A158's early-hydration seam: makes `origin`'s persisted grants live
     * BEFORE `registerApp` ever runs for it this session, so a restored
     * app's first served document (and its first real capability call) sees
     * its real, already-consented grants rather than an empty ledger.
     *
     * `manifest` MUST already be proven a leaf of a hash-pinned bundle
     * (`src/loader/serve.ts`'s `verifiedManifestFor`) -- NEVER a manifest
     * merely read off disk. This is what tells this call apart from the
     * withdrawn attempt A137 rejected: that one hydrated from an unverified
     * disk copy, which could gain authority a fresh request would not have;
     * this one hydrates from bytes already proven, by the same hash tree
     * that gates whether this origin's code runs AT ALL, to be exactly what
     * the person consented to. See `GrantLedger.hydrateFromPinnedManifest`'s
     * own doc for the full reasoning and what happens once the real,
     * freshly fetched manifest later arrives via `registerApp`.
     */
    hydrateFromPinnedManifest(origin: string, manifest: Manifest): Promise<void>
    /**
     * Every `orivon.fs.userSelected` pick this origin holds, for a LOADED
     * app -- the live counterpart to `grants` above, and D-0007's other
     * half of the settings surface. `revokeUserSelectedPath` below is how
     * one of these is withdrawn.
     */
    pickedPaths(origin: string): Promise<readonly PickedPath[]>
    /** A200: `GrantLedger.socketAllowance`, exposed read-only -- same category as `hasGrantsSync` above, never throws. Full reasoning: `src/loader/README.md` Design notes. */
    socketAllowanceSync(origin: string): number
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
    /** `orivon.net.lookup` (d-0030) -- bounded by the origin's tcp.connect/https.connect/udp.send grants; see capability-api.ts's own OrivonNet.lookup doc for the full spec. */
    lookup(origin: string, opts: { hostname: string }): Promise<readonly LookupAddress[]>
  }
  /** `BrokerFsMethods` -- ./fs-contracts.js, alongside the types it is built from. */
  readonly fs: BrokerFsMethods
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
   * The capability set `origin`'s install-consent dialog was most recently
   * DECLINED for (A145), or undefined -- never declined, or a later visit
   * accepted and cleared it (`clearDeclinedConsent` below). ADVISORY ONLY:
   * consulted before showing that dialog again, never by anything that
   * grants a capability -- see `src/broker/grants/declined-consent.ts`.
   * Same category as `versionFloorFor`: no `orivon.*` counterpart, an app
   * can never read it.
   */
  declinedCapabilitiesFor(origin: string): Promise<readonly CapabilityKind[] | undefined>
  /**
   * Remembers that `origin`'s install-consent dialog was just declined for
   * exactly `capabilities` -- `requestInstallConsent`'s own decline branch
   * is the only caller. Never rejects on a failed persist: this value can
   * never become or imply a grant, so the worst a lost write costs is one
   * avoidable re-prompt next restart, never a security regression.
   */
  recordDeclinedConsent(origin: string, capabilities: readonly CapabilityKind[]): Promise<void>
  /**
   * Clears whatever declined-consent record `origin` holds -- called once a
   * later visit's dialog is ACCEPTED, so an old "no" cannot outlive a "yes"
   * for the same-or-narrower question. Same never-rejects contract as
   * `recordDeclinedConsent`.
   */
  clearDeclinedConsent(origin: string): Promise<void>
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
  /**
   * Revokes one capability from an app that may not be loaded, addressed by
   * `(origin, capability)` because a not-yet-loaded app has no live GrantId.
   * Resolves to whether anything was actually removed. See
   * `GrantLedger.revokePersisted`.
   */
  revokePersisted(origin: string, capability: CapabilityKind): Promise<boolean>
  /**
   * Withdraws one `orivon.fs.userSelected` pick, by the id `app.pickedPaths`
   * (or the settings list, reading a persisted-but-not-loaded app) named --
   * `revokePersisted`'s own picked-path counterpart, and NOT the same
   * mechanism: a pick holds no GrantId (`fs`'s own revoke cannot reach it,
   * handle-contracts.md's "FileHandle" exception), so this addresses the
   * handle table's `byPickedPath` index directly
   * (`HandleTable.revokeUserSelected`) rather than going through `revoke`.
   * WITHOUT THIS CASCADE THE REVOKE BUTTON LIES, the same principle
   * `revokePersisted`'s own comment states -- see ../index.ts's
   * implementation. Resolves to whether anything was actually removed.
   */
  revokeUserSelectedPath(origin: string, pickId: string): Promise<boolean>
}
