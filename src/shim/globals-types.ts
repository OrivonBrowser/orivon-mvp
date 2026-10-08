// The shapes globals.ts installs. Kept apart from it because installGlobals
// itself must stay one self-contained function (its serialisation-safety
// test says why), and the types are most of what a reader needs.

import type { NodeIdentity } from './node-identity.js'

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
  /** node-identity.ts's NODE_IDENTITY, passed in for the same reason as `root`. */
  readonly node: NodeIdentity
  /** virtual-root.ts's VIRTUAL_ROOT and VIRTUAL_TMPDIR, passed in: installGlobals may not name a module-level value. */
  readonly root: string
  readonly tmpdir: string
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

export type ProcessListener = (...args: any[]) => void

export interface ShimStdio {
  readonly fd: number
  readonly isTTY: false
  write: (chunk: unknown, encodingOrCallback?: unknown, callback?: () => void) => boolean
}

export interface ShimProcess {
  /** 'linux' on every host: the platform whose rules the app's files follow (node-identity.ts), so a library takes its POSIX paths and XDG directories. */
  readonly platform: NodeIdentity['platform']
  /** Fresh per install and never seeded from any ambient environment, which would be a disclosure bug: only the directory variables, all naming the virtual root. */
  readonly env: Record<string, string | undefined>
  /** `v` and the Node version the shim's surface is measured against. */
  readonly version: string
  /**
   * `node` alone. Every other key is a build fact of a real Node or Electron that the shim cannot state honestly:
   * `modules` and `napi` pick a native addon's binary, and Orivon runs none (natives are WebAssembly);
   * `electron` and `chrome` belong to an Electron port's own build, which knows its Electron.
   */
  readonly versions: Readonly<Record<string, string>>
  readonly argv: string[]
  readonly execArgv: string[]
  /** '' : a string, as every reader expects (`path.dirname(process.execPath)`), naming no binary: there is none to run. */
  readonly execPath: string
  readonly pid: number
  readonly ppid: number
  readonly title: string
  /** 'x64', os.arch()'s answer too, on every host. A library that picks a native prebuild by it finds none and fails by name, as under Node without one. */
  readonly arch: NodeIdentity['arch']
  readonly release: { readonly name: 'node' }
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
