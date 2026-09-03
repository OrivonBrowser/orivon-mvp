// The composition root's mechanism.
//
// Each subsystem -- broker, shim, loader, trust indicator, Nostr, telemetry --
// registers itself in src/main/subsystems.ts rather than editing app lifecycle
// code, so adding one is an APPEND (two lines: an import and a list entry) and
// never an edit to shared logic. Git merges appends at different positions of
// a list cleanly; it does not merge two edits to the same conditional.
//
// Without this, src/main/index.ts is the file every future stream must edit to
// wire itself in, which makes it the repository's worst merge surface at
// exactly the moment several streams are running at once. See
// docs/development/parallel-work.md.
//
// TWO PHASES, because Electron forces it: protocol.registerSchemesAsPrivileged
// must be called BEFORE the app is ready, and build step 5's range-capable
// custom media scheme needs it (build-plan.md SS5). A single phase would make
// that stream restructure index.ts -- exactly what this exists to prevent.
//
// This module imports nothing from electron at runtime: `App` is a type-only
// import, erased by verbatimModuleSyntax. That erasure is what makes the two
// functions below unit testable without launching Electron.
import type { App } from 'electron'
import type { Broker } from '../broker/index.js'

export interface SubsystemContext {
  readonly app: App
  /**
   * The running app's one `Broker`. Nothing else in the process may
   * construct a second one: two independently-constructed brokers mean two
   * disagreeing grant ledgers for one running app, so every subsystem that
   * needs a `Broker` -- the app loader, the trust indicator, whatever
   * eventually issues a real grant -- must read this SAME instance rather
   * than build its own.
   *
   * Undefined until the broker subsystem's `afterReady` runs; `runAfterReady`
   * is sequential (this file's own doc above), which is what makes "the
   * broker subsystem writes it, a later one reads it" reliable rather than a
   * race. Set this only via `publishBroker` below, never by direct
   * assignment -- that is the one thing standing between an accidental
   * second broker and a silent ledger split.
   */
  broker?: Broker
}

/**
 * The one sanctioned way to set `ctx.broker`. Throws if a broker has
 * already been published, so an accidental second `Broker` -- built by a
 * subsystem that should have read `ctx.broker` instead of constructing its
 * own -- fails loudly right away rather than silently overwriting the first
 * one and splitting the grant ledger (`SubsystemContext.broker`'s own doc
 * comment). This matches `runBeforeReady`'s own "must never be quiet"
 * philosophy above, applied to a different failure.
 *
 * `broker` stays a plain, mutable field rather than `readonly`: TypeScript
 * cannot express "settable exactly once" without either a cast at the one
 * legitimate call site (which would just hide the same mutation from the
 * type checker instead of preventing it) or replacing the field with a
 * getter, which would complicate every later subsystem's read. The runtime
 * guard here is the actual guarantee; the type stays honest about that.
 */
export function publishBroker (ctx: SubsystemContext, broker: Broker): void {
  if (ctx.broker !== undefined) {
    throw new Error('ctx.broker is already published; a second Broker would create two disagreeing grant ledgers for one running app')
  }
  ctx.broker = broker
}

export interface Subsystem {
  /** Used in failure reports. Keep it short and stream-shaped, e.g. 'broker'. */
  readonly name: string
  /** Runs before app ready, for registrations Electron requires that early. */
  beforeReady?: () => void
  /** Runs after app ready, before the shell window is created. */
  afterReady?: (ctx: SubsystemContext) => void | Promise<void>
}

export interface SubsystemFailure {
  readonly name: string
  readonly phase: 'beforeReady' | 'afterReady'
  readonly error: unknown
}

/**
 * Failures are collected and returned, never swallowed and never propagated.
 *
 * A subsystem that throws must not take down the browser, and must not
 * silently prevent the ones after it from registering. The caller reports
 * them loudly -- a subsystem that failed to start may be a capability
 * enforcing nothing, which is the one class of failure that must never be
 * quiet (handle-contracts.md SSWhat the shim must do, rule 2).
 */
export function runBeforeReady (list: Subsystem[]): SubsystemFailure[] {
  const failures: SubsystemFailure[] = []
  for (const subsystem of list) {
    if (subsystem.beforeReady === undefined) continue
    try {
      subsystem.beforeReady()
    } catch (error) {
      failures.push({ name: subsystem.name, phase: 'beforeReady', error })
    }
  }
  return failures
}

/**
 * Sequential, not concurrent: a later subsystem may depend on an earlier one
 * having registered its IPC handlers or session partition.
 *
 * The try/catch covers a synchronous throw as well as a rejection, because
 * `afterReady` is typed to allow either.
 */
export async function runAfterReady (
  list: Subsystem[],
  ctx: SubsystemContext
): Promise<SubsystemFailure[]> {
  const failures: SubsystemFailure[] = []
  for (const subsystem of list) {
    if (subsystem.afterReady === undefined) continue
    try {
      await subsystem.afterReady(ctx)
    } catch (error) {
      failures.push({ name: subsystem.name, phase: 'afterReady', error })
    }
  }
  return failures
}
