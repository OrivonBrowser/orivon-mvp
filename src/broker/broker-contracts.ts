// The broker's own vocabulary -- pure type and interface declarations with no
// runtime behaviour, split out of ./index.ts so that file could stay under
// the 500-line guideline (docs/development/code-guidelines.md Rule 2). No
// state lives here.
//
// See ./index.ts's header for what createBroker actually does, why its
// dependency shape is fixed, and what `Broker` is for.

import type { DestroyResource, FailableTcpSocket } from './handle-contracts.js'
import type { LedgerStorage } from './ledger-storage.js'
import type { Resolver } from './policy/connect.js'
import type {
  CapabilityKind,
  Grant,
  GrantId,
  Handle,
  Manifest,
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
 * `HandleTable.run`'s own note, in ./handles.ts, to whoever writes this path.
 */
export type Dial = (addresses: readonly string[], port: number, signal: AbortSignal) => Promise<DialedSocket>

/**
 * What `orivon.fs` needs from the real filesystem. `policy/paths.ts` stays
 * pure; this is the one seam where confinement's decision touches disk.
 */
export interface BrokerFs {
  /**
   * The absolute directory `origin`'s files are confined to. Computed by the
   * INJECTED implementation, not here: security-model.md T13b makes it
   * `sha256(canonical origin)` under the app data directory, and that
   * directory lives outside anything this pure-orchestration layer knows --
   * there is no `electron`, and no user-data path, in createBroker's fixed
   * dependency shape. Flagged as an AI recommendation in the PR body: nothing
   * in the corpus specifies which side of this seam computes the root.
   */
  rootFor(origin: string): string
  /** `confinePath`'s `realpath` parameter (policy/paths.ts). Synchronous, matching node:fs's `realpathSync`. */
  realpathSync(path: string): string
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
}

/**
 * Backs `orivon.id` -- key derivation from a locked seed (ADR-0010,
 * policy/derive.ts). OUT OF SCOPE for this task (see the PR body):
 * `createBroker` accepts it only because build-plan.md fixes the
 * constructor's shape once, for every capability that eventually needs a
 * piece of it. Nothing below calls it yet.
 */
export interface Keychain {
  getSeed(): Promise<Uint8Array>
}

export interface CreateBrokerOptions {
  readonly dial: Dial
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
  }
  readonly net: {
    /** Returns a `FailableTcpSocket` -- a `TcpSocket` plus one broker-internal
     * escape hatch, see handle-contracts.ts. */
    connect(origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket>
  }
  readonly fs: {
    readFile(origin: string, path: string): Promise<Uint8Array>
    writeFile(origin: string, path: string, data: Uint8Array): Promise<void>
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
   * (d-0017) -- meant to be called once, at the point a future UI-wiring PR
   * (per PR #72's `rollbackAcknowledged` field and PR #75's
   * `installFromHint`) determines the user actually chose to accept that
   * specific below-floor version. This broker never calls it on its own
   * initiative, the same way it never grants a capability on its own
   * initiative.
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
   * (handle-contracts.md SSRevocation) -- rather than reimplementing it: every
   * handle the grant authorised closes at once, abruptly, and every promise
   * the app is awaiting on one of them rejects with 'revoked'.
   */
  revoke(origin: string, grantId: GrantId): Promise<void>
}
