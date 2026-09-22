// The Node globals a renderer-hosted Node library reads straight off the
// global object rather than importing: `process`, `global`, and the free
// functions `setImmediate`/`clearImmediate`. Installed onto a TARGET the
// caller passes in, never onto the real globalThis by itself, which is what
// makes this unit testable: a test installs onto a throwaway object.
//
// installGlobals is handed to contextBridge.executeInMainWorld, which
// serialises it with Function.prototype.toString() and re-evaluates it alone
// in the page: it may not name anything outside its own body, which is why
// every helper below is nested inside it. Read src/shim/README.md's five
// binding requirements before changing this file; it exists for requirement 2.

import type {
  EmitWarningOptions, GlobalsErrorOrigin, GlobalsTarget, ImmediateHandle, InstallGlobalsOptions, ProcessListener,
  ShimProcess, ShimStdio
} from './globals-types.js'

export type {
  EmitWarningOptions, GlobalsErrorOrigin, GlobalsErrorReporter, GlobalsTarget, ImmediateHandle, InstallGlobalsOptions,
  ShimPlatform, ShimProcess
} from './globals-types.js'
export { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from './virtual-root.js'

/**
 * Installs process, global, setImmediate and clearImmediate onto `target`.
 * `target` is the trailing, defaulted parameter so the preload can pass only
 * `options` and let it default to the page's own `window`.
 */
export function installGlobals (
  options: InstallGlobalsOptions,
  target: GlobalsTarget = typeof window === 'undefined' ? {} : window as unknown as GlobalsTarget
): void {
  const { root, tmpdir } = options
  const listeners = new Map<string, Array<{ listener: ProcessListener, once: boolean }>>()

  // THE RULE THIS FILE EXISTS FOR. An exception escaping a nextTick or
  // setImmediate callback crashes a real Node process loudly; in a renderer
  // the same throw is quiet by comparison, logged where nobody watches. So
  // every such exception is reported explicitly: to a process
  // 'uncaughtException' listener if the app installed one, as Node does, and
  // otherwise to the page's own reportError, which fires window 'error'
  // exactly as an uncaught exception would. Never to the preload's isolated
  // console, which the page's own error handling cannot see.
  function report (error: unknown, origin: GlobalsErrorOrigin): void {
    if (origin !== 'warning' && emit('uncaughtException', error, 'uncaughtException')) return
    if (origin === 'warning' && emit('warning', error)) return
    if (options.reportError !== undefined) { options.reportError(error, origin); return }
    if (origin === 'warning') { console.warn(error); return }
    if (typeof target.reportError === 'function') target.reportError(error)
    else setTimeout(() => { throw error })
  }

  function add (event: string, listener: ProcessListener, once: boolean): ShimProcess {
    const list = listeners.get(event) ?? []
    list.push({ listener, once })
    listeners.set(event, list)
    return process
  }

  function remove (event: string, listener: ProcessListener): ShimProcess {
    const list = listeners.get(event) ?? []
    const at = list.findIndex((entry) => entry.listener === listener)
    if (at !== -1) list.splice(at, 1)
    return process
  }

  function emit (event: string, ...args: unknown[]): boolean {
    const list = listeners.get(event)
    if (list === undefined || list.length === 0) return false
    for (const entry of [...list]) {
      if (entry.once) remove(event, entry.listener)
      entry.listener.apply(process, args)
    }
    return true
  }

  // KNOWN, ACCEPTED DIFFERENCE FROM REAL NODE -- ordering. Node drains its
  // nextTick queue before any promise continuation; queueMicrotask
  // interleaves the two FIFO. `process-nextick-args`, the package most
  // sensitive to it, branches on `!process.version` and takes its own
  // fallback here, so nothing in the known graph depends on the stricter order.
  function nextTick<Args extends readonly unknown[]> (callback: (...args: Args) => void, ...args: Args): void {
    queueMicrotask(() => {
      try {
        callback(...args)
      } catch (error) {
        report(error, 'nextTick')
      }
    })
  }

  // A MessageChannel task, not setTimeout(0): timers are clamped to 4 ms once
  // nested and to 1 s in a hidden tab, and schedulers that adopt
  // setImmediate when present (React's among them) would inherit both.
  const immediates = new Map<number, () => void>()
  let nextImmediate = 1
  const channel = new MessageChannel()
  channel.port1.onmessage = (event: MessageEvent<number>) => {
    const run = immediates.get(event.data)
    immediates.delete(event.data)
    run?.()
  }
  // Node's MessagePort holds its event loop open once listened to; a
  // browser's has no unref and needs none.
  ;(channel.port1 as { unref?: () => void }).unref?.()

  function shimSetImmediate<Args extends readonly unknown[]> (callback: (...args: Args) => void, ...args: Args): ImmediateHandle {
    const handle = nextImmediate++
    immediates.set(handle, () => {
      try {
        callback(...args)
      } catch (error) {
        report(error, 'setImmediate')
      }
    })
    channel.port2.postMessage(handle)
    return handle
  }

  function shimClearImmediate (handle: ImmediateHandle): void {
    immediates.delete(handle)
  }

  // Both of Node's forms: emitWarning(warning[, type[, code]]) and
  // emitWarning(warning[, { type, code, detail }]). An Error is emitted as
  // is; a string is wrapped and named, 'Warning' by default.
  function emitWarning (warning: string | Error, typeOrOptions?: string | EmitWarningOptions, code?: string): void {
    if (warning instanceof Error) { report(warning, 'warning'); return }
    const opts: EmitWarningOptions = typeof typeOrOptions === 'string' ? { type: typeOrOptions, code } : typeOrOptions ?? {}
    const error: Error & { code?: string, detail?: string } = new Error(warning)
    error.name = opts.type ?? 'Warning'
    if (opts.code !== undefined) error.code = opts.code
    if (opts.detail !== undefined) error.detail = opts.detail
    report(error, 'warning')
  }

  // Monotonic, from the page's own clock origin.
  function hrtime (previous?: readonly [number, number]): [number, number] {
    const now = performance.now()
    let seconds = Math.floor(now / 1000)
    let nanos = Math.floor((now % 1000) * 1e6)
    if (previous !== undefined) {
      seconds -= previous[0]
      nanos -= previous[1]
      if (nanos < 0) { seconds -= 1; nanos += 1e9 }
    }
    return [seconds, nanos]
  }
  hrtime.bigint = (): bigint => BigInt(Math.floor(performance.now() * 1e6))

  function memoryUsage (): Record<'rss' | 'heapTotal' | 'heapUsed' | 'external' | 'arrayBuffers', number> {
    const heap = (performance as { memory?: { usedJSHeapSize: number, totalJSHeapSize: number } }).memory
    return { rss: heap?.totalJSHeapSize ?? 0, heapTotal: heap?.totalJSHeapSize ?? 0, heapUsed: heap?.usedJSHeapSize ?? 0, external: 0, arrayBuffers: 0 }
  }
  memoryUsage.rss = (): number => memoryUsage().rss

  let mask = 0o022
  function umask (next?: number): number {
    const previous = mask
    if (next !== undefined) mask = next
    return previous
  }

  function exit (code?: number): never {
    if (code !== undefined) process.exitCode = code
    emit('exit', process.exitCode ?? 0)
    const error = new Error(`process.exit(${String(process.exitCode ?? 0)}) was called, but an app tab cannot end its own process.`)
    throw Object.assign(error, { name: 'OrivonShimError', api: 'process.exit', reason: 'not-applicable', code: 'ERR_ORIVON_PROCESS_EXIT' })
  }

  // Minimal stdout/stderr: each write is one line on the page console.
  function stdio (fd: number, print: (text: string) => void): ShimStdio {
    return {
      fd,
      isTTY: false,
      write (chunk, encodingOrCallback, callback) {
        print(String(chunk).replace(/\n$/, ''))
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback as () => void : callback
        if (done !== undefined) queueMicrotask(done)
        return true
      }
    }
  }

  const process: ShimProcess = {
    platform: 'browser',
    env: { HOME: root, USERPROFILE: root, APPDATA: root, TMPDIR: tmpdir, TMP: tmpdir, TEMP: tmpdir },
    version: '',
    versions: {},
    browser: true,
    argv: [],
    execArgv: [],
    pid: 1,
    ppid: 0,
    title: 'browser',
    arch: 'javascript',
    release: { name: 'browser' },
    exitCode: undefined,
    stdout: stdio(1, (text) => { console.log(text) }),
    stderr: stdio(2, (text) => { console.error(text) }),
    nextTick,
    emitWarning,
    cwd: () => root,
    hrtime,
    uptime: () => performance.now() / 1000,
    memoryUsage,
    umask,
    exit,
    on: (event, listener) => add(event, listener, false),
    addListener: (event, listener) => add(event, listener, false),
    once: (event, listener) => add(event, listener, true),
    off: remove,
    removeListener: remove,
    removeAllListeners: (event) => { if (event === undefined) listeners.clear(); else listeners.delete(event); return process },
    emit,
    listeners: (event) => (listeners.get(event) ?? []).map((entry) => entry.listener),
    listenerCount: (event) => listeners.get(event)?.length ?? 0
  }

  // Plain assignments, never a locked defineProperty: ADR-0021, an app may
  // shadow or replace any of these (README.md's Design notes).
  target.process = process
  target.global = target
  target.setImmediate = shimSetImmediate
  target.clearImmediate = shimClearImmediate
}
