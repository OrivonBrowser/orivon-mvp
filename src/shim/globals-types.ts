// The shapes globals.ts installs. Kept apart from it because installGlobals
// itself must stay one self-contained function (its serialisation-safety
// test says why), and the types are most of what a reader needs.

/** Which installed primitive produced a report. 'warning' is process.emitWarning, held to the same "louder, not quieter" standard as the two timing primitives. */
export type GlobalsErrorOrigin = 'nextTick' | 'setImmediate' | 'warning'

/**
 * Where an exception that would crash a real Node process goes instead.
 * Omitted, an exception goes to the page's own `reportError` (the HTML one:
 * window 'error' handlers and the page console, as an uncaught exception
 * would) and a warning to the page console. Never silence: a reporter the
 * caller could omit into nothing would reintroduce the bug this exists for.
 */
export type GlobalsErrorReporter = (error: unknown, origin: GlobalsErrorOrigin) => void

export interface InstallGlobalsOptions {
  readonly reportError?: GlobalsErrorReporter | undefined
  /** virtual-root.ts's VIRTUAL_ROOT and VIRTUAL_TMPDIR, passed in: installGlobals may not name a module-level value. */
  readonly root: string
  readonly tmpdir: string
}

/**
 * Node's process.platform is a closed union of real OS names, and this is
 * deliberately not one: there is no real platform to read here, and
 * 'browser' can never equal one, so `platform === 'win32'` safely falls
 * through to a generic branch instead of firing on a wrong guess.
 */
export type ShimPlatform = NodeJS.Platform | 'browser'

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

export type ProcessListener = (...args: any[]) => void

export interface ShimStdio {
  readonly fd: number
  readonly isTTY: false
  write: (chunk: unknown, encodingOrCallback?: unknown, callback?: () => void) => boolean
}

export interface ShimProcess {
  readonly platform: ShimPlatform
  /** Fresh per install and never seeded from any ambient environment, which would be a disclosure bug: only the directory variables, all naming the virtual root. */
  readonly env: Record<string, string | undefined>
  /** '' rather than a fabricated Node version (npm's `process` polyfill makes the same choice): a real-looking one invites a Node-only code path. */
  readonly version: string
  /** Present but empty, for the same reason: `process.versions.node` reads undefined, so a check for Node or Electron takes its browser branch, instead of throwing on `undefined.node`. */
  readonly versions: Readonly<Record<string, string>>
  /**
   * Always true, and NOT optional. Real readers take their browser branch on
   * it (bittorrent-tracker, crypto-browserify, webtorrent); leaving it off
   * would make each quietly take the Node branch instead of failing loudly.
   */
  readonly browser: true
  readonly argv: string[]
  readonly execArgv: string[]
  readonly pid: number
  readonly ppid: number
  readonly title: string
  /** os.arch()'s answer too: no real architecture to report, and one that matches none. */
  readonly arch: string
  readonly release: { readonly name: string }
  exitCode: number | undefined
  readonly stdout: ShimStdio
  readonly stderr: ShimStdio
  readonly nextTick: <Args extends readonly unknown[]>(callback: (...args: Args) => void, ...args: Args) => void
  readonly emitWarning: (warning: string | Error, typeOrOptions?: string | EmitWarningOptions, code?: string) => void
  /** The virtual root (virtual-root.ts), which the fs shim maps onto the app's own files. */
  readonly cwd: () => string
  readonly hrtime: ((previous?: readonly [number, number]) => [number, number]) & { bigint: () => bigint }
  readonly uptime: () => number
  readonly memoryUsage: (() => Record<'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers', number>) & { rss: () => number }
  readonly umask: (mask?: number) => number
  /** Throws: an app tab cannot end its own process. Emits 'exit' first, as Node does. */
  readonly exit: (code?: number) => never
  readonly on: (event: string, listener: ProcessListener) => ShimProcess
  readonly addListener: (event: string, listener: ProcessListener) => ShimProcess
  readonly once: (event: string, listener: ProcessListener) => ShimProcess
  readonly off: (event: string, listener: ProcessListener) => ShimProcess
  readonly removeListener: (event: string, listener: ProcessListener) => ShimProcess
  readonly removeAllListeners: (event?: string) => ShimProcess
  readonly emit: (event: string, ...args: unknown[]) => boolean
  readonly listeners: (event: string) => ProcessListener[]
  readonly listenerCount: (event: string) => number
}

/**
 * What setImmediate returns and clearImmediate consumes: a number, treated
 * as opaque. Never `ReturnType<typeof setTimeout>`: with `"types": ["node"]`
 * that is NodeJS.Timeout, whose `.unref()` would typecheck and then throw on
 * a number at runtime.
 */
export type ImmediateHandle = number

/**
 * What installGlobals writes onto: the page's window in production, a
 * throwaway object in a test. `reportError` is read, never written: it is
 * the page's own, the default destination for an uncaught callback error.
 */
export interface GlobalsTarget {
  process?: ShimProcess
  global?: unknown
  setImmediate?: <Args extends readonly unknown[]>(callback: (...args: Args) => void, ...args: Args) => ImmediateHandle
  clearImmediate?: (handle: ImmediateHandle) => void
  reportError?: (error: unknown) => void
}
