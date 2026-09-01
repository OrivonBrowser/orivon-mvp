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
// One file. GrantLedger (the per-origin state -- manifest and grants, kept
// apart on purpose) and createBroker (the dependency shape and the five
// capability entry points that consult it) together stay under
// docs/development/code-guidelines.md's 500-line limit, so there is no seam
// to split on yet (Rule 2: split by concern, never pre-emptively).

import { HandleTable } from './handles.js'
import type { DestroyResource } from './handle-contracts.js'
import { fail } from './errors.js'
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
    connect(origin: string, opts: { host: string, port: number }): Promise<TcpSocket>
  }
  readonly fs: {
    readFile(origin: string, path: string): Promise<Uint8Array>
    writeFile(origin: string, path: string, data: Uint8Array): Promise<void>
  }
  /**
   * Registers -- or replaces -- an origin's manifest. Called once per app
   * session, before any capability call for that origin. Existing grants are
   * left untouched (GrantLedger, below).
   */
  registerApp(origin: string, manifest: Manifest): void
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

/**
 * 128 bits from the platform CSPRNG, as hex -- the same construction
 * handle-store.ts's private `newHandleId()` uses, for the same reason
 * (unguessability is defence in depth; the boundary is the per-origin
 * lookup, not the id's secrecy).
 *
 * NOT DEDUPLICATED with that function, or with policy/bundle-hash.ts's
 * private `toLowercaseHex`. Both live in files this task may not touch --
 * policy/ is off limits by the task brief, and handle-store.ts is not one of
 * the two files it may create -- so reusing either would need an edit outside
 * this PR's scope. code-guidelines.md Rule 3's open point 3 already tracks
 * one such pair as a deliberate, left-for-a-follow-up duplicate; this is the
 * same shape of trade-off, not a new kind of one. Flagged in the PR body as
 * an AI recommendation, not a silent shortcut.
 */
function newGrantId (): GrantId {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface OriginRecord {
  manifest: Manifest | undefined
  /**
   * At most one LIVE grant per capability kind. Granting again replaces it --
   * see `createBroker`'s `grant()` on why the replacement mints a fresh
   * GrantId rather than reusing the old one (open-questions.md A21).
   */
  readonly grants: Map<CapabilityKind, Grant>
}

/**
 * The grant ledger: what each origin has declared (its manifest) and what it
 * has actually been granted, kept apart on purpose -- see the file header.
 *
 * DOES NOT ENFORCE that a grant is a subset of what the manifest declares.
 * That check belongs to whoever ISSUES the grant (the permission-prompt UI, a
 * later build step) and to policy/update.ts's re-consent decision. This class
 * only remembers what it is told, the same way HandleTable trusts the
 * ownership its caller asserts rather than re-deriving it.
 *
 * BROKER-INTERNAL, the same way OriginTable (./handle-store.ts) is private to
 * HandleTable. Nothing outside `createBroker` should hold a bare
 * GrantLedger; `canonical()` below is the boundary that normalises an origin
 * before this class ever sees one.
 */
class GrantLedger {
  readonly #origins = new Map<string, OriginRecord>()

  #record (origin: string): OriginRecord {
    const existing = this.#origins.get(origin)
    if (existing !== undefined) return existing
    const created: OriginRecord = { manifest: undefined, grants: new Map() }
    this.#origins.set(origin, created)
    return created
  }

  /**
   * Registers -- or replaces -- an origin's manifest. Existing grants are
   * left untouched: a page reload re-declares the same manifest and must not
   * silently revoke what the user already granted it.
   */
  registerApp (origin: string, manifest: Manifest): void {
    this.#record(origin).manifest = manifest
  }

  manifestFor (origin: string): Manifest | undefined {
    return this.#origins.get(origin)?.manifest
  }

  /** What was ACTUALLY granted. Empty for an origin the ledger has no record of. */
  grantsFor (origin: string): readonly Grant[] {
    const record = this.#origins.get(origin)
    return record === undefined ? [] : Array.from(record.grants.values())
  }

  /** The live grant for one capability kind, or undefined if none was ever issued or it was revoked. */
  currentGrant (origin: string, capability: CapabilityKind): Grant | undefined {
    return this.#origins.get(origin)?.grants.get(capability)
  }

  /**
   * Records a capability as granted, replacing any earlier grant of the same
   * kind. Returns the replaced record too -- the ledger is the only thing
   * that ever held it, so a caller that needs to revoke it (createBroker's
   * `grant`, below) has no other way to find it once this returns.
   */
  grant (origin: string, capability: CapabilityKind, patterns: readonly Pattern[], grantedAt: number): { record: Grant, replaced: Grant | undefined } {
    const record: Grant = { id: newGrantId(), origin, capability, patterns, grantedAt }
    const originRecord = this.#record(origin)
    const replaced = originRecord.grants.get(capability)
    originRecord.grants.set(capability, record)
    return { record, replaced }
  }

  /**
   * Removes one grant, by id, from whichever capability slot holds it.
   *
   * A NO-OP, never a throw, for an origin or id the ledger does not hold --
   * revoking twice, or revoking an id that already lapsed, must behave the
   * same as HandleTable.release's idempotence, not surface a distinguishable
   * error an app-adjacent caller could probe with.
   */
  revoke (origin: string, grantId: GrantId): void {
    const record = this.#origins.get(origin)
    if (record === undefined) return
    for (const [capability, grant] of record.grants) {
      if (grant.id === grantId) {
        record.grants.delete(capability)
        return
      }
    }
  }
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
   */
  function confineForOrigin (key: string, path: string): string {
    if (ledger.currentGrant(key, 'fs') === undefined) {
      throw fail('denied', 'fs is not granted to this origin')
    }
    const root = deps.fs.rootFor(key)
    const confined = confinePath(root, path, deps.fs.realpathSync)
    if (!confined.ok) throw fail(CONFINEMENT_ERROR_CODE, "the path is outside this app's files directory")
    return confined.resolved
  }

  async function connect (origin: string, opts: { host: string, port: number }): Promise<TcpSocket> {
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
      const decision = await checkConnect(current.patterns, opts.host, opts.port, deps.resolve)
      if (!decision.allowed) throw fail('denied', 'the connection was not authorised')

      const dialed = await deps.dial(decision.addresses, opts.port, signal)

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

      return {
        id: entry.id,
        closed: entry.closed,
        close: async (): Promise<void> => { await handleTable.release(key, entry.id) },
        ...socketFields
      }
    })
  }

  async function readFile (origin: string, path: string): Promise<Uint8Array> {
    const key = canonical(origin)
    return await deps.fs.readFile(confineForOrigin(key, path))
  }

  async function writeFile (origin: string, path: string, data: Uint8Array): Promise<void> {
    const key = canonical(origin)
    await deps.fs.writeFile(confineForOrigin(key, path), data)
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

  function registerApp (origin: string, appManifest: Manifest): void {
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
