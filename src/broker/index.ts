// The capability broker. Everything under ./policy/ is a decision function;
// this file is what MAKES the decisions and HOLDS the state -- the piece
// build-plan.md's "Structural decision, day 1" (SSWeek 0) was written for.
//
// `createBroker({ dial, resolve, now, fs, keychain })` -- EXACTLY that shape.
// It is fixed on purpose (build-plan.md, policy/README.md): every capability
// test then runs against stubs, with no Electron and no network, which is
// what makes the six security-critical unit tests in
// docs/development/testing.md cheap enough to actually exist. Do not widen
// it -- a dependency this function reaches for itself is a dependency no
// stub can intercept.
//
// NO ELECTRON, NO IPC, NO MessagePortMain. Wiring this to a renderer over IPC
// is a separate task (see the PR). This file is constructible and fully
// testable in a plain Node test with stub dependencies -- if it needs
// `electron`, it has crossed into that task.
//
// THE FIRST JOB, AND THE POINT OF THIS FILE: hold the grant ledger per
// origin (GrantLedger, below) and consult IT, never the manifest, when
// checking a capability. `checkConnect` (./policy/connect.ts) takes the
// GRANTED pattern list precisely because open-questions.md A18 decided the
// narrowing from "declared" to "granted" has to happen somewhere, and this is
// the only layer that has both the manifest and the grant ledger in hand to
// do it.
//
// GrantLedger (the per-origin state -- manifest and grants, kept apart on
// purpose) split out to ./grant-ledger.ts once this file crossed
// docs/development/code-guidelines.md's 500-line limit (Rule 2: split by
// concern -- this was the seam the file's own header had already earmarked).
// This file keeps the dependency shape and the five capability entry points
// that consult that ledger.

import { HandleTable } from './handles.js'
import type { DestroyResource, FailableTcpSocket } from './handle-contracts.js'
import { errnoOf, fail } from './errors.js'
import { GrantLedger } from './grant-ledger.js'
import { checkConnect } from './policy/connect.js'
import type { Resolver } from './policy/connect.js'
import { CONFINEMENT_ERROR_CODE, confinePath } from './policy/paths.js'
import { originFromUrl } from './policy/origin.js'
import type {
  CapabilityKind,
  Grant,
  GrantId,
  Handle,
  Manifest,
  OrivonError,
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
   */
  registerApp(origin: string, manifest: Manifest): Promise<void>
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

/** Every value OrivonErrorCode actually has -- see contracts/errors.ts. Used to recognise an error this broker already produced, not one still raw from an injected dependency. */
const ORIVON_ERROR_CODES: ReadonlySet<OrivonErrorCode> = new Set<OrivonErrorCode>([
  'denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal'
])

function isOrivonError (error: unknown): error is OrivonError {
  return error instanceof Error && error.name === 'OrivonError' &&
    ORIVON_ERROR_CODES.has((error as { code?: OrivonErrorCode }).code as OrivonErrorCode)
}

/** Node errno -> OrivonErrorCode. Anything not listed here fails closed as 'internal'. */
const ERRNO_TO_CODE: Readonly<Record<string, OrivonErrorCode>> = {
  ENOENT: 'notFound',
  EEXIST: 'exists',
  ECONNREFUSED: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENOTFOUND: 'unreachable',
  EAI_AGAIN: 'unreachable',
  ETIMEDOUT: 'timeout',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  EMFILE: 'limit',
  ENFILE: 'limit',
  ENOSPC: 'limit',
  EDQUOT: 'limit',
  EACCES: 'denied',
  EPERM: 'denied'
}

/**
 * Maps a raw rejection from an injected dependency -- `deps.resolve`,
 * `deps.dial`, `deps.fs.readFile`, `deps.fs.writeFile` -- onto the closed
 * OrivonErrorCode enum. Before this fix none of the four was wrapped: an app
 * switching exhaustively on `err.code`, exactly as contracts/errors.ts's own
 * doc says it may, would see a raw Node errno such as 'ENOENT' -- a value
 * that same doc calls a bug to receive.
 *
 * An error this broker already threw (via `fail`, e.g. 'denied' from a
 * failed policy check) passes through unchanged -- mapping it a second time
 * would be a no-op at best and a lie at worst if two enum members ever
 * collided as strings.
 *
 * WRITES A FRESH MESSAGE, NEVER FORWARDS THE ORIGINAL. A raw fs error
 * message carries the confined absolute path (e.g. "ENOENT: ... open
 * '/apps/<sha256>/missing.txt'") -- handing that to the app tells it exactly
 * where its own confinement root sits (security-model.md T13b), the first
 * thing anything attacking policy/paths.ts wants to know. Only the errno
 * itself survives, as `platformCode` -- and errors.ts's own BrokerError
 * constructor already strips that for 'denied', so it does not need
 * repeating here.
 */
function mapIoError (error: unknown, kind: 'net' | 'fs'): OrivonError {
  if (isOrivonError(error)) return error
  const errno = errnoOf(error)
  const code = errno === undefined ? 'internal' : (ERRNO_TO_CODE[errno] ?? 'internal')
  const message = kind === 'net' ? 'the network operation failed' : 'the filesystem operation failed'
  return fail(code, message, undefined, errno)
}

export function createBroker (deps: CreateBrokerOptions): Broker {
  const handleTable = new HandleTable()
  const ledger = new GrantLedger()

  /**
   * The isolation key, through the one definition of it (policy/origin.ts) --
   * mirrors HandleTable's own private `#key()` exactly, because this
   * ledger's map is a SEPARATE table keyed on the same string and has to
   * agree with it. `https://app.example:443` and `https://app.example` must
   * land on one grant record, not two with half the capabilities each.
   *
   * Reported as 'internal', matching errors.ts: this is a broker fault --
   * every caller is expected to have already derived a real origin via
   * `originFromSenderFrame` (T3) before reaching here -- never an app-visible
   * denial.
   */
  function canonical (origin: string): string {
    const key = originFromUrl(origin)
    if (key === null) throw fail('internal', 'broker method called with a string that is not an origin')
    return key
  }

  /**
   * The `fs` capability check plus path confinement, shared by readFile and
   * writeFile (Rule 3 -- the two were byte-for-byte the same logic before
   * this was pulled out).
   *
   * `fs` carries no patterns (manifest.ts's FsCapability), so the capability
   * check here is presence-only: does this origin hold ANY live `fs` grant.
   * Returns the `Grant` itself, not only the confined path -- the caller
   * needs its id to scope the actual I/O under `handleTable.run`, the same
   * way `connect` already scopes under `current.id`.
   *
   * Synchronous, and stays that way: `confinePath`'s `realpath` parameter is
   * `policy/paths.ts`'s, declared synchronous, and that file is out of this
   * PR's scope to change (filed as A28 -- an origin on a slow filesystem can
   * still block other origins' pending calls through this exact function;
   * making `realpath` async is the fix, not this one).
   */
  function confineForOrigin (key: string, path: string): { resolved: string, grant: Grant } {
    const grant = ledger.currentGrant(key, 'fs')
    if (grant === undefined) throw fail('denied', 'fs is not granted to this origin')
    const root = deps.fs.rootFor(key)
    const confined = confinePath(root, path, deps.fs.realpathSync)
    if (!confined.ok) throw fail(CONFINEMENT_ERROR_CODE, "the path is outside this app's files directory")
    return { resolved: confined.resolved, grant }
  }

  async function connect (origin: string, opts: { host: string, port: number }): Promise<FailableTcpSocket> {
    const key = canonical(origin)

    // THE NARROWING. `current.patterns` is what the user granted; nothing
    // below ever reads `manifest.capabilities.net.tcp.connect`, which is what
    // the app DECLARED and may be far wider (open-questions.md A18). An empty
    // grant answers exactly like no grant at all -- checkConnect's own
    // `patterns.length === 0` case -- so there is nothing else to special-case
    // here for "never granted".
    const current = ledger.currentGrant(key, 'tcp.connect')
    if (current === undefined) throw fail('denied', 'tcp.connect is not granted to this origin')

    return await handleTable.run(key, { on: 'grant', grantId: current.id }, async (signal) => {
      // `checkConnect` calls `deps.resolve` internally and does not catch
      // its rejection (policy/connect.ts is pure, and mapping I/O errors is
      // not its job), so a raw DNS failure reaches here unmapped. `deps.dial`
      // rejects raw too. Both need mapIoError; nothing else in this
      // callback throws anything but an OrivonError already, and mapIoError
      // passes those through unchanged.
      let decision: Awaited<ReturnType<typeof checkConnect>>
      let dialed: DialedSocket
      try {
        decision = await checkConnect(current.patterns, opts.host, opts.port, deps.resolve)
        if (!decision.allowed) throw fail('denied', 'the connection was not authorised')
        // Checked here too, not only after `dial` resolves below: without
        // this, a grant revoked while resolve was still pending would still
        // reach `deps.dial`, and correctness would depend entirely on the
        // INJECTED dial implementation independently honouring an
        // already-aborted signal rather than on the broker itself.
        if (signal.aborted) throw fail('revoked', 'the grant authorising this connection was withdrawn')
        dialed = await deps.dial(decision.addresses, opts.port, signal)
      } catch (error) {
        throw mapIoError(error, 'net')
      }

      if (signal.aborted) {
        // The grant was withdrawn while `dial` was in flight. `acquire`
        // below would still refuse to register this socket, but its own
        // cleanup path releases it with reason 'failed' -- silent fd
        // release, the right answer for a registration that never got a
        // resource, and the WRONG one here: `dialed` is a live, connected
        // socket that needs a proper revoked-style teardown, not silence.
        // Handling it here rather than leaning on `acquire`'s refusal is
        // exactly what HandleTable.run's own note asks the connect path to
        // do (./handles.ts).
        await dialed.destroy('revoked')
        throw fail('revoked', 'the grant authorising this connection was withdrawn')
      }

      const { destroy, ...socketFields } = dialed
      const entry = handleTable.acquire({
        origin: key,
        kind: 'tcpSocket',
        authorisedBy: { by: 'grant', grantId: current.id },
        destroy
      })

      // Spread FIRST, then the broker-assigned fields -- not the other way
      // round. `socketFields` came from `dialed`, and DialedSocket's own
      // type forbids it carrying id/closed/close today, but a future dial()
      // whose result happens to carry same-named fields must not be able to
      // silently override the broker's own handle identity and close
      // behaviour by landing later in the spread.
      return {
        ...socketFields,
        id: entry.id,
        closed: entry.closed,
        close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
        fail: (code, platformCode) => { handleTable.fail(key, entry.id, code, platformCode) }
      }
    })
  }

  /**
   * `fs.readFile` and `fs.writeFile` share this shape: confine the path (see
   * `confineForOrigin`), then run the actual I/O under the same per-origin
   * in-flight budget `connect` uses (`{ on: 'grant' }` -- handle-contracts.ts
   * on that scope: "without it those calls would escape the in-flight cap
   * entirely, which is the cap that keeps the broker responsive"). Before
   * this, `fs` called `deps.fs.*` directly and was subject to no cap at all
   * -- T11b by name, and a second, distinct T11b path through the confined
   * path leaving no room for cancellation either.
   *
   * `signal.aborted` is checked on both sides of the raw call: before, in
   * case the grant was already gone by the time a slot freed up; after,
   * because revoking mid-write must not let the app receive confirmation for
   * an operation performed after its grant was withdrawn -- the write can
   * already be on disk by then, but the app is never told it succeeded.
   */
  async function runFsIo<T> (key: string, grant: Grant, io: () => Promise<T>): Promise<T> {
    return await handleTable.run(key, { on: 'grant', grantId: grant.id }, async (signal) => {
      if (signal.aborted) throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      let result: T
      try {
        result = await io()
      } catch (error) {
        throw mapIoError(error, 'fs')
      }
      if (signal.aborted) throw fail('revoked', 'the grant authorising this fs operation was withdrawn')
      return result
    })
  }

  async function readFile (origin: string, path: string): Promise<Uint8Array> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    return await runFsIo(key, grant, async () => await deps.fs.readFile(resolved))
  }

  /**
   * manifest.ts's FsCapability.quotaBytes: "ENFORCED, not advisory ... The
   * broker maintains a running per-origin byte counter, checks it on write,
   * and yields 'limit' when exceeded." `ledger.reserveFsBytes` checks AND
   * reserves in one synchronous step, before this function's first `await`
   * -- concurrent callers cannot all read the same pre-write counter and
   * all pass (see that method's own doc). Undeclared quota means unlimited.
   * `started` below distinguishes "never touched disk" (refund) from
   * "touched disk, then told 'revoked' anyway" (do not); session-lifetime
   * only, A29 tracks reconciling against disk on startup.
   */
  async function writeFile (origin: string, path: string, data: Uint8Array): Promise<void> {
    const key = canonical(origin)
    const { resolved, grant } = confineForOrigin(key, path)
    if (!ledger.reserveFsBytes(key, data.length)) {
      throw fail('limit', "this write would exceed the app's declared storage quota")
    }
    let started = false
    try {
      await runFsIo(key, grant, async () => {
        started = true
        try {
          await deps.fs.writeFile(resolved, data)
        } catch (error) {
          ledger.releaseFsBytes(key, data.length) // nothing landed -- unmapped, runFsIo maps it below
          throw error
        }
      })
    } catch (error) {
      // False only when deps.fs.writeFile was never called (in-flight cap,
      // or an already-revoked grant) -- refund there too. deps.fs.writeFile
      // takes no AbortSignal, so once called it lands regardless of
      // revocation -- only the catch above may refund after that point.
      if (!started) ledger.releaseFsBytes(key, data.length)
      throw error
    }
  }

  async function manifest (origin: string): Promise<Manifest> {
    const found = ledger.manifestFor(canonical(origin))
    // A broker fault, not a denial: every real caller registers a manifest
    // before wiring an origin's IPC at all (see Broker.registerApp's doc).
    // An app asking its own broker "what is my manifest" and getting nothing
    // back means something upstream never registered it.
    if (found === undefined) throw fail('internal', 'no manifest registered for this origin')
    return found
  }

  async function grants (origin: string): Promise<readonly Grant[]> {
    return ledger.grantsFor(canonical(origin))
  }

  async function registerApp (origin: string, appManifest: Manifest): Promise<void> {
    ledger.registerApp(canonical(origin), appManifest)
  }

  async function grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[]): Promise<Grant> {
    const key = canonical(origin)
    const { record, replaced } = ledger.grant(key, capability, patterns, deps.now())
    // Clears a stale revoked-tombstone under THIS id. A freshly minted id
    // makes this a no-op today, but the handle table is correct either way,
    // and open-questions.md A21 says the ledger must call it regardless of
    // how GrantId reuse across a revoke-then-re-grant is eventually decided.
    handleTable.grantIssued(key, record.id)
    // The ledger has already dropped `replaced` (GrantLedger.grant's Map.set
    // above), so this is the only remaining place anything still knows its
    // id. Revoking it here, before returning, is what stops a superseded
    // grant staying live forever -- see the interface doc on `grant`.
    if (replaced !== undefined) await handleTable.revoke(key, replaced.id)
    return record
  }

  async function revoke (origin: string, grantId: GrantId): Promise<void> {
    const key = canonical(origin)
    // Ledger first, synchronously: a grants()/connect() call racing the
    // cascade must never observe a grant whose handles are already mid-
    // teardown. Mirrors HandleTable.revoke's own "tell the app before any
    // teardown runs" ordering, one layer up.
    ledger.revoke(key, grantId)
    await handleTable.revoke(key, grantId)
  }

  return {
    app: { manifest, grants },
    net: { connect },
    fs: { readFile, writeFile },
    registerApp,
    grant,
    revoke
  }
}
