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
import type { Loader } from '../loader/index.js'

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
   * race -- your subsystem must be listed AFTER `brokerIpcSubsystem` in
   * `subsystems.ts` to see it (that file's own header says so too).
   *
   * `readonly` here is not just documentation: `createSubsystemContext`
   * below returns an object whose `broker` is a get-only accessor backed by
   * a module-private slot, so `ctx.broker = x` is a TypeError at runtime, not
   * only a type error at compile time. `publishBroker` is the only way in.
   */
  readonly broker: Broker | undefined
  /**
   * The running app's one `Loader`, same guarantee as `broker` and for the
   * same reason: two independently-constructed Loaders would disagree about
   * what is installed for one running app. Undefined until the loader
   * subsystem's `afterReady` runs; a subsystem reading this must be listed
   * after `loaderSubsystem` in `subsystems.ts`.
   */
  readonly loader: Loader | undefined
}

/**
 * One field on `SubsystemContext` that may be published exactly once.
 * `broker` and `loader` both need this guarantee for the same reason (Rule
 * 3): a second published value means two independently-constructed
 * instances disagreeing about one running app's state. Keyed by context
 * rather than stored as an ordinary field so the value can be exposed as a
 * get-only accessor -- an early version of this file left `broker` a plain
 * mutable field and relied on every caller going through `publishBroker` by
 * convention alone, and nothing stopped `ctx.broker = x` from compiling.
 */
function createPublishedSlot<T> (label: string, hazard: string): {
  get: (ctx: SubsystemContext) => T | undefined
  publish: (ctx: SubsystemContext, value: T) => void
} {
  const byContext = new WeakMap<SubsystemContext, T>()
  return {
    get: (ctx) => byContext.get(ctx),
    publish: (ctx, value) => {
      if (byContext.has(ctx)) throw new Error(`ctx.${label} is already published; ${hazard}`)
      byContext.set(ctx, value)
    }
  }
}

const brokerSlot = createPublishedSlot<Broker>('broker', 'a second Broker would create two disagreeing grant ledgers for one running app')
const loaderSlot = createPublishedSlot<Loader>('loader', 'a second Loader would create two disagreeing ideas of what is installed for one running app')

class SubsystemContextImpl implements SubsystemContext {
  readonly app: App

  constructor (app: App) {
    this.app = app
  }

  get broker (): Broker | undefined {
    return brokerSlot.get(this)
  }

  get loader (): Loader | undefined {
    return loaderSlot.get(this)
  }
}

/**
 * The one way to build a `SubsystemContext`. `main/index.ts` calls this
 * once, at startup, and threads the result through `runAfterReady`.
 */
export function createSubsystemContext (app: App): SubsystemContext {
  return new SubsystemContextImpl(app)
}

/**
 * The one sanctioned way to set `ctx.broker`. Throws if a broker has
 * already been published, so an accidental second `Broker` -- built by a
 * subsystem that should have read `ctx.broker` instead of constructing its
 * own -- fails loudly right away rather than silently overwriting the first
 * one and splitting the grant ledger (`SubsystemContext.broker`'s own doc
 * comment). This matches `runBeforeReady`'s own "must never be quiet"
 * philosophy above, applied to a different failure.
 */
export function publishBroker (ctx: SubsystemContext, broker: Broker): void {
  brokerSlot.publish(ctx, broker)
}

/** The one sanctioned way to set `ctx.loader` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishLoader (ctx: SubsystemContext, loader: Loader): void {
  loaderSlot.publish(ctx, loader)
}

export interface Subsystem {
  /** Used in failure reports. Keep it short and stream-shaped, e.g. 'broker'. */
  readonly name: string
  /**
   * True if this subsystem failing means the browser is not safe to run,
   * not just degraded -- reserved for a subsystem whose failure leaves a
   * capability meant to be enforced enforcing nothing (handle-contracts.md
   * SSWhat the shim must do, rule 2; `brokerIpcSubsystem` is the first and,
   * for now, only example). Defaults to `false`: most subsystems (today,
   * telemetry) can fail and leave the browser otherwise usable.
   *
   * `main/index.ts` reads this, via `criticalFailureMessage` below, to
   * decide whether it may still open a shell window. Logging alone is not
   * enough for a critical failure -- see that function's own doc.
   */
  readonly critical?: boolean
  /** Runs before app ready, for registrations Electron requires that early. */
  beforeReady?: () => void
  /** Runs after app ready, before the shell window is created. */
  afterReady?: (ctx: SubsystemContext) => void | Promise<void>
}

export interface SubsystemFailure {
  readonly name: string
  readonly phase: 'beforeReady' | 'afterReady'
  readonly error: unknown
  /** Copied from the failing `Subsystem.critical` at the moment it threw. */
  readonly critical: boolean
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
      failures.push({ name: subsystem.name, phase: 'beforeReady', error, critical: subsystem.critical === true })
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
      failures.push({ name: subsystem.name, phase: 'afterReady', error, critical: subsystem.critical === true })
    }
  }
  return failures
}

/**
 * A human-readable message naming every CRITICAL failure in `failures`, or
 * `null` if none of them were critical.
 *
 * Why this exists: PR #49 made the broker reachable via `publishBroker`, but
 * a throw there was still only `console.error`'d by `runAfterReady`'s own
 * failure collection -- the app booted a completely normal-looking window
 * with every `orivon.*` call from every app silently unroutable
 * (open-questions.md A51). A subsystem marked `critical` failing is exactly
 * the case `runBeforeReady`'s doc above calls "must never be quiet", and
 * logging it is not loud enough: nobody reads a packaged app's main-process
 * console. `main/index.ts` calls this after each phase and, if it returns
 * non-null, fails startup instead of opening that window.
 */
export function criticalFailureMessage (failures: SubsystemFailure[]): string | null {
  const critical = failures.filter((failure) => failure.critical)
  if (critical.length === 0) return null
  const lines = critical.map((failure) => `${failure.name} (${failure.phase}): ${String(failure.error)}`)
  return `Orivon cannot start safely -- a critical subsystem failed:\n${lines.join('\n')}`
}
