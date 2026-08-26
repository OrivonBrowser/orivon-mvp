// The Node globals a renderer-hosted Node library reads straight off the
// global object rather than importing: `process`, and the two free
// functions `setImmediate`/`clearImmediate`. Node exposes all three as
// ambient globals, never as values a module imports -- so this file's job is
// to build a global-shaped object, not to export values for something else
// to `import`.
//
// Installed onto a TARGET the caller passes in, never onto the real
// globalThis -- see installGlobals below. That is the whole reason this file
// is unit testable: a test installs onto a throwaway object and inspects it,
// instead of mutating (and having to clean up after) the one real global
// environment an entire test run shares.
//
// Read src/shim/README.md's five binding requirements before changing this
// file. This file exists for requirement 2.

/**
 * Which installed primitive produced a report. 'warning' covers
 * process.emitWarning below -- not itself a timing primitive, but held to
 * the same "louder, not quieter" standard as the two that are.
 */
export type GlobalsErrorOrigin = 'nextTick' | 'setImmediate' | 'warning'

/**
 * Where an exception that would otherwise crash a real Node process goes
 * instead. Required on InstallGlobalsOptions below, not optional with a
 * silent default: Node's own process.nextTick has no "off switch" for this,
 * and a shim that let a caller omit a reporter would make silence the
 * default again -- reintroducing, by a different route, the exact bug this
 * file exists to fix.
 */
export type GlobalsErrorReporter = (error: unknown, origin: GlobalsErrorOrigin) => void

export interface InstallGlobalsOptions {
  readonly reportError: GlobalsErrorReporter
}

/**
 * Node's own process.platform is a closed union of real OS names, and
 * deliberately does not include this value. This file has no `electron`
 * import and no ambient Node `process` to read the real one from --
 * src/shim/README.md bans the former, and a sandboxed renderer has none of
 * the latter -- so the honest answer is "unknown", not a guess. 'browser'
 * can never equal a real platform name, so an exact check such as
 * `platform === 'win32'` safely falls through to its generic branch instead
 * of firing on a wrong one.
 */
export type ShimPlatform = NodeJS.Platform | 'browser'

export interface ShimProcess {
  readonly platform: ShimPlatform

  /**
   * Starts empty on every install and is never seeded from any ambient
   * process.env. This process runs code for one app under one capability
   * grant; inheriting the host's real environment variables would be a
   * disclosure bug wearing an API-shape improvement as a disguise.
   */
  readonly env: Record<string, string | undefined>

  /**
   * Empty string, not a fabricated Node version -- the same choice the
   * standard browser polyfill for this field makes (npm's `process`
   * package, `browser.js`: `process.version = ''`), and for the same
   * reason: a library that branches on a real-looking version string may
   * take a code path this shim cannot actually back, where '' reads as
   * "unknown" and is far more likely to land on a defended default.
   */
  readonly version: string

  readonly nextTick: <Args extends readonly unknown[]>(callback: (...args: Args) => void, ...args: Args) => void
  readonly emitWarning: (warning: string | Error, type?: string) => void
}

/** What setImmediate returns and clearImmediate consumes. */
type ImmediateHandle = ReturnType<typeof setTimeout>

/**
 * The shape installGlobals writes onto. Every field is optional and
 * otherwise unconstrained, on purpose: the production caller passes
 * globalThis (a huge, unrelated type), a test passes `{}`. Requiring more
 * here would make one of those two calls fight the type checker for no
 * safety gained -- installGlobals only ever WRITES these three properties,
 * never reads them back.
 */
export interface GlobalsTarget {
  process?: ShimProcess
  setImmediate?: <Args extends readonly unknown[]>(callback: (...args: Args) => void, ...args: Args) => ImmediateHandle
  clearImmediate?: (handle: ImmediateHandle) => void
}

/**
 * Installs process/setImmediate/clearImmediate onto `target`.
 *
 * Never touches the real globalThis itself -- the caller decides what
 * "global" means (production: globalThis; a test: a disposable object).
 */
export function installGlobals (target: GlobalsTarget, options: InstallGlobalsOptions): void {
  const { reportError } = options

  // THE RULE THIS FILE EXISTS FOR. Node's real process.nextTick surfaces an
  // exception escaping its callback to the process, loudly. A bare
  // `queueMicrotask(() => fn(...args))` does not reproduce that -- but
  // verified directly (`node -e`, 2026-08-26) that Node itself in fact
  // treats an uncaught queueMicrotask exception as fatal too (exit code 1),
  // same as a bare setTimeout callback. So the failure this guards against
  // is not "Node silently drops it" -- Node doesn't, anywhere. It is that a
  // browser renderer's ambient handling of the identical throw is quiet by
  // comparison: logged to a devtools console nobody is watching in a
  // packaged app, never reaching whatever this project's operator actually
  // monitors. Relying on ambient behaviour is exactly the bug, whether that
  // behaviour happens to be fatal (Node) or quiet (renderer) -- the fix has
  // to be an explicit, environment-independent report either way.
  function nextTick<Args extends readonly unknown[]> (callback: (...args: Args) => void, ...args: Args): void {
    queueMicrotask(() => {
      try {
        callback(...args)
      } catch (error) {
        reportError(error, 'nextTick')
      }
    })
  }

  // Same rule, same fix, different primitive -- setImmediate gets the
  // identical explicit try/catch, so a fix proven on nextTick cannot regress
  // here just because the bug happened to be found on nextTick first
  // (handle-contracts.md SSWhat the shim must do, rule 2: "any polyfilled
  // Node timing primitive", not just the one that failed once).
  //
  // setTimeout(fn, 0) rather than a MessageChannel-based scheduler: Node
  // does not promise a library that setImmediate runs in any particular
  // phase relative to I/O, only that it runs soon and asynchronously, which
  // setTimeout(0) already provides.
  function shimSetImmediate<Args extends readonly unknown[]> (callback: (...args: Args) => void, ...args: Args): ImmediateHandle {
    return setTimeout(() => {
      try {
        callback(...args)
      } catch (error) {
        reportError(error, 'setImmediate')
      }
    }, 0)
  }

  function shimClearImmediate (handle: ImmediateHandle): void {
    clearTimeout(handle)
  }

  // Not a timing primitive, but held to the same "louder, not quieter"
  // standard: Node's default for an unhandled 'warning' event is to print
  // it, not drop it, so an emitWarning that went nowhere would be a
  // regression by the same measure nextTick/setImmediate are held to above.
  function emitWarning (warning: string | Error, type?: string): void {
    // Matches real Node: an Error is emitted as-is (a `type` argument
    // alongside one is ignored); a string is wrapped and named, defaulting
    // to 'Warning' the same way Node's own unnamed warnings print as
    // "Warning: ..." rather than the generic Error's "Error: ...".
    if (warning instanceof Error) {
      reportError(warning, 'warning')
      return
    }
    const error = new Error(warning)
    error.name = type ?? 'Warning'
    reportError(error, 'warning')
  }

  target.process = {
    platform: 'browser',
    env: {},
    version: '',
    nextTick,
    emitWarning
  }
  target.setImmediate = shimSetImmediate
  target.clearImmediate = shimClearImmediate
}
