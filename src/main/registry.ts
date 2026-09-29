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
// must be called BEFORE the app is ready, and a range-capable streaming
// scheme, such as a torrent app's media path would use, needs it. A single
// phase would make whichever stream adds one restructure index.ts --
// exactly what this exists to prevent.
//
// This module imports nothing from electron at runtime: `App` is a type-only
// import, erased by verbatimModuleSyntax. That erasure is what makes the two
// functions below unit testable without launching Electron.
import type { App, BaseWindow, WebContents } from 'electron'
import type { Broker } from '../broker/broker-contracts.js'
import type { Loader, LoadResult } from '../loader/index.js'
import type { GrantedWithoutInstall } from './install/grant-without-install.js'
import type { DialogCaller } from './consent/request-grant.js'
import type { CapabilityRequest } from '../contracts/index.js'
import type { ExtensionsApi } from './extensions/extensions-subsystem.js'

export interface SubsystemContext {
  readonly app: App
  /**
   * This process is a private session: it keeps nothing after it ends, so a subsystem that would
   * persist something about the person, or report it, must not. Fixed for the life of the process.
   */
  readonly privateSession: boolean
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
  /**
   * OrivonApp.requestGrant's mechanism (`../request-grant.js`'s `requestGrant`,
   * closed over this process's one `Broker` and its consent surface) --
   * queue item 4.1's "whatever eventually issues a real grant" that
   * `broker`'s own doc comment above already anticipated. Published here
   * rather than constructed ad hoc by whichever caller eventually needs it
   * (a future control-channel case in `../broker/transport/ipc.ts`), for the
   * same one-instance reason `broker`/`loader` are: it must close over THIS
   * process's one `Broker`, never a second one built for convenience.
   * Undefined until `requestGrantSubsystem`'s `afterReady` runs; a subsystem
   * reading this must be listed after it in `subsystems.ts`, which itself
   * must be listed after `brokerIpcSubsystem`.
   *
   * `caller` (`./consent/request-grant.js`'s `DialogCaller`) is built by
   * whoever calls this -- `../broker/transport/ipc.ts`'s CONTROL handler,
   * from the real sending `WebContents` -- so the dialog this may show can
   * be parented to the calling tab's window and skipped or discounted once
   * that tab is gone or has moved on (`docs/architecture/security-model.md`).
   */
  readonly requestGrant: ((origin: string, request: CapabilityRequest, caller?: DialogCaller, abandoned?: AbortSignal) => Promise<boolean>) | undefined
  /**
   * `../app-install.js`'s `installFromHint`, closed over this process's one
   * `Broker`/`Loader` and the real install-time consent dialog (d-0025,
   * S4-4) -- `app-install.ts` itself stays free of any Electron import, the
   * same reason `requestGrant`'s own mechanism does, so this is where the
   * three come together. Same one-instance guarantee as `broker`/`loader`/
   * `requestGrant`, for the same reason: whoever wires the discovery
   * trigger (S4-2) must read this, never construct a second one. Undefined
   * until this subsystem's `afterReady` runs; a subsystem reading this must
   * be listed after it, which itself must be listed after both
   * `brokerIpcSubsystem` and `loaderSubsystem`.
   *
   * `caller` is the same `DialogCaller` `requestGrant` above takes, built by
   * `./install/manifest-hint.ts` from the frame that reported the hint.
   */
  readonly installApp: ((hintingOrigin: string, hintedUrl: string, caller?: DialogCaller) => Promise<LoadResult | GrantedWithoutInstall>) | undefined
  /**
   * Resolves the window CURRENTLY holding a tab's `WebContents`, or
   * undefined if none can be found (the tab closed, or moved somewhere this
   * process lost track of) -- the one piece of the shell's own state
   * (`./shell/window-registry.js`'s `WindowRegistry`) a consent dialog needs,
   * to parent itself to the tab that asked rather than floating free of
   * every window on screen.
   *
   * Published in `main/index.ts` itself, once the shell's `WindowRegistry`
   * exists -- NOT a subsystem: every subsystem's `afterReady` runs during
   * `runAfterReady`, before `createShellServices` ever builds one, so
   * nothing here could publish it any earlier. A reader must therefore treat
   * `undefined` as routine even late in startup, and always call THROUGH
   * this accessor rather than capture its value -- see
   * `requestGrantSubsystem`'s and `manifestHintSubsystem`'s own wiring for
   * the lazy-thunk shape that makes that safe.
   */
  readonly windowForSender: ((sender: WebContents) => BaseWindow | undefined) | undefined
  /**
   * Whether the WebContents making a call is attributed to the origin it
   * claims -- `isAttributedSession`'s (`../broker/policy/origin.js`)
   * injected other half. Every renderer-reachable broker channel
   * (`../broker/transport/ipc.ts`'s CONTROL_CHANNEL and SYNC_CONTROL_CHANNEL,
   * `./install/manifest-hint.ts`'s MANIFEST_HINT) reads this to refuse a
   * call from a WebContents that never committed this origin in the session
   * it belongs in.
   *
   * Published here, not built inside `../broker/transport/ipc.ts` itself,
   * because answering it needs facts this policy layer never reaches for
   * itself: the loader's cache state (`isOriginServedFromCacheSync`, and
   * `src/broker/` must never import `src/loader/`, `../broker/README.md`),
   * and a per-document commit record only Electron's own `did-navigate`
   * event can produce. `./sessions/session-attribution.ts` is the one place
   * that builds it; it must be listed before `brokerIpcSubsystem` in
   * `subsystems.ts` so this is already published by the time the broker
   * channels wire themselves up.
   */
  readonly senderAttributed: ((sender: unknown, origin: string) => boolean) | undefined
  /**
   * `./extensions/extensions-subsystem.js`'s install/uninstall/enable/list
   * surface, closed over this process's one `session.defaultSession` and
   * `userData` path -- same one-instance guarantee as `broker`/`loader`/
   * `requestGrant`/`installApp`: a second one could load extensions into a
   * different session than the one every extension actually runs in later
   * packages read. Undefined until `extensionsSubsystem`'s `afterReady`
   * runs; a subsystem reading this must be listed after it in
   * `subsystems.ts`.
   */
  readonly extensions: ExtensionsApi | undefined
}

/**
 * One field on `SubsystemContext` that may be published exactly once.
 * `broker` and `loader` both need this guarantee for the same reason (Rule
 * 3): a second published value means two independently-constructed
 * instances disagreeing about one running app's state. Keyed by context
 * rather than stored as an ordinary field so the value can be exposed as a
 * get-only accessor -- a plain mutable field would let `ctx.broker = x`
 * compile, relying on every caller going through `publishBroker` by
 * convention alone.
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
const requestGrantSlot = createPublishedSlot<(origin: string, request: CapabilityRequest, caller?: DialogCaller, abandoned?: AbortSignal) => Promise<boolean>>('requestGrant', 'a second one could close over a different Broker instance than the one every other subsystem reads')
const installAppSlot = createPublishedSlot<(hintingOrigin: string, hintedUrl: string, caller?: DialogCaller) => Promise<LoadResult | GrantedWithoutInstall>>('installApp', 'a second one could close over a different Broker or Loader instance than the one every other subsystem reads')
const senderAttributedSlot = createPublishedSlot<(sender: unknown, origin: string) => boolean>('senderAttributed', 'a second one could disagree with the first about which sender is attributed to which origin, and every broker channel must apply the same answer')
const extensionsSlot = createPublishedSlot<ExtensionsApi>('extensions', 'a second one could load into a different session than the one every extension actually runs in')
const windowForSenderSlot = createPublishedSlot<(sender: WebContents) => BaseWindow | undefined>('windowForSender', 'a second one could disagree about which window currently holds a given tab')

class SubsystemContextImpl implements SubsystemContext {
  readonly app: App
  readonly privateSession: boolean

  constructor (app: App, privateSession: boolean) {
    this.app = app
    this.privateSession = privateSession
  }

  get broker (): Broker | undefined {
    return brokerSlot.get(this)
  }

  get loader (): Loader | undefined {
    return loaderSlot.get(this)
  }

  get requestGrant (): ((origin: string, request: CapabilityRequest, caller?: DialogCaller, abandoned?: AbortSignal) => Promise<boolean>) | undefined {
    return requestGrantSlot.get(this)
  }

  get installApp (): ((hintingOrigin: string, hintedUrl: string, caller?: DialogCaller) => Promise<LoadResult | GrantedWithoutInstall>) | undefined {
    return installAppSlot.get(this)
  }

  get senderAttributed (): ((sender: unknown, origin: string) => boolean) | undefined {
    return senderAttributedSlot.get(this)
  }

  get extensions (): ExtensionsApi | undefined {
    return extensionsSlot.get(this)
  }

  get windowForSender (): ((sender: WebContents) => BaseWindow | undefined) | undefined {
    return windowForSenderSlot.get(this)
  }
}

/**
 * The one way to build a `SubsystemContext`. `main/index.ts` calls this
 * once, at startup, and threads the result through `runAfterReady`.
 */
export function createSubsystemContext (app: App, privateSession = false): SubsystemContext {
  return new SubsystemContextImpl(app, privateSession)
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

/** The one sanctioned way to set `ctx.requestGrant` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishRequestGrant (ctx: SubsystemContext, requestGrant: (origin: string, request: CapabilityRequest, caller?: DialogCaller, abandoned?: AbortSignal) => Promise<boolean>): void {
  requestGrantSlot.publish(ctx, requestGrant)
}

/** The one sanctioned way to set `ctx.installApp` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishInstallApp (ctx: SubsystemContext, installApp: (hintingOrigin: string, hintedUrl: string, caller?: DialogCaller) => Promise<LoadResult | GrantedWithoutInstall>): void {
  installAppSlot.publish(ctx, installApp)
}

/** The one sanctioned way to set `ctx.senderAttributed` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishSenderAttributed (ctx: SubsystemContext, senderAttributed: (sender: unknown, origin: string) => boolean): void {
  senderAttributedSlot.publish(ctx, senderAttributed)
}

/** The one sanctioned way to set `ctx.extensions` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishExtensions (ctx: SubsystemContext, extensions: ExtensionsApi): void {
  extensionsSlot.publish(ctx, extensions)
}

/** The one sanctioned way to set `ctx.windowForSender` -- see `publishBroker`'s own doc; same guarantee, same reason. */
export function publishWindowForSender (ctx: SubsystemContext, windowForSender: (sender: WebContents) => BaseWindow | undefined): void {
  windowForSenderSlot.publish(ctx, windowForSender)
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
 * quiet (handle-contracts.md's "What the shim must do" section, rule 2).
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
 * Why this exists: a critical subsystem's throw was previously only
 * `console.error`'d by `runAfterReady`'s own failure collection -- the app
 * booted a completely normal-looking window with every `orivon.*` call
 * from every app silently unroutable
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
