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

  /**
   * Always true, and NOT optional -- a dependency that reads this must get
   * an answer, never `undefined`.
   *
   * Found by grepping the spike's shipped bundles (the ones that made gates
   * 1a/1b pass) rather than by anticipating a surface, per
   * src/shim/README.md requirement 1: `process.browser` is read 4 times in
   * gate1a's graph and 6 times in gate1b's, and the npm `process` polyfill
   * those bundles carried sets it to true. The readers are
   * `bittorrent-tracker` (`if (!process.browser && !opts.port) throw`, in
   * both Client and Server), `crypto-browserify`'s `checkNative()` and
   * default-encoding selection, and webtorrent's `FILESYSTEM_CONCURRENCY`.
   *
   * Leaving it off does not raise anything. It makes every one of those
   * quietly take the Node branch -- installing a partial `process` turns a
   * loud ReferenceError into a silent wrong answer, which is precisely the
   * failure mode the rest of this file exists to prevent.
   */
  readonly browser: true

  readonly nextTick: <Args extends readonly unknown[]>(callback: (...args: Args) => void, ...args: Args) => void
  readonly emitWarning: (warning: string | Error, typeOrOptions?: string | EmitWarningOptions, code?: string) => void
}

/**
 * The options-object form of process.emitWarning's second argument. Every
 * field is `| undefined` on purpose: the callers are untyped JavaScript
 * libraries, and under `exactOptionalPropertyTypes` a plain `type?: string`
 * would reject the entirely ordinary `{ type: undefined }`.
 */
export interface EmitWarningOptions {
  readonly type?: string | undefined
  readonly code?: string | undefined
  readonly detail?: string | undefined
}

/**
 * What setImmediate returns and clearImmediate consumes, treated as opaque.
 *
 * Deliberately a union rather than `ReturnType<typeof setTimeout>`: this
 * repo sets `"types": ["node"]` globally, so that alias resolves to
 * NodeJS.Timeout -- an OBJECT with .ref()/.unref(). In the sandboxed
 * renderer this shim actually runs in, setTimeout returns a NUMBER, which
 * has neither. The alias therefore type-checks `setImmediate(fn).unref()`
 * clean and throws at runtime. The union has no members in common, so the
 * handle stays opaque and the mistake is caught at `npm run typecheck`.
 */
export type ImmediateHandle = ReturnType<typeof setTimeout> | number

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
  //
  // KNOWN, ACCEPTED DIFFERENCE FROM REAL NODE -- ordering. Node keeps a
  // dedicated nextTick queue that is drained to exhaustion BEFORE any
  // promise continuation runs. queueMicrotask puts these callbacks in the
  // same microtask queue as promises, so nextTick and .then() callbacks
  // interleave here in FIFO order where Node would run every nextTick
  // first. Checked against the real graph before accepting it:
  // `process-nextick-args`, the package most sensitive to this, branches on
  // `!process.version` and takes its own fallback path under this shim (see
  // `version` above), so nothing in the spike's graph depends on the
  // stricter ordering. Revisit if a dependency ever does -- the fix is a
  // real queue drained from one queueMicrotask, not a second polyfill.
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
  // Covers BOTH of Node's documented shapes, not just the positional one:
  //   emitWarning(warning[, type[, code]][, ctor])
  //   emitWarning(warning[, options])              options: {type, code, detail}
  // Handling only the first assigned the whole options object to
  // `error.name`, which stringifies to '[object Object]' -- a warning that
  // arrives unreadable rather than not at all. Same quiet-failure class as
  // the swallowed exception above, so it gets the same treatment.
  function emitWarning (warning: string | Error, typeOrOptions?: string | EmitWarningOptions, code?: string): void {
    // Matches real Node: an Error is emitted as-is (a `type` argument
    // alongside one is ignored); a string is wrapped and named, defaulting
    // to 'Warning' the same way Node's own unnamed warnings print as
    // "Warning: ..." rather than the generic Error's "Error: ...".
    if (warning instanceof Error) {
      reportError(warning, 'warning')
      return
    }

    const options: EmitWarningOptions = typeof typeOrOptions === 'string'
      ? { type: typeOrOptions, code }
      : typeOrOptions ?? {}

    const error: Error & { code?: string, detail?: string } = new Error(warning)
    error.name = options.type ?? 'Warning'
    // Attached only when present, so a consumer can distinguish "no code"
    // from "code explicitly undefined" -- Node does the same.
    if (options.code !== undefined) error.code = options.code
    if (options.detail !== undefined) error.detail = options.detail

    reportError(error, 'warning')
  }

  target.process = {
    platform: 'browser',
    env: {},
    version: '',
    browser: true,
    nextTick,
    emitWarning
  }
  target.setImmediate = shimSetImmediate
  target.clearImmediate = shimClearImmediate
}
