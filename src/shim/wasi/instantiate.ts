// The one place JSPI appears. WASI calls are synchronous for the program
// and orivon.fs is asynchronous: each import that may await is wrapped in
// WebAssembly.Suspending, and the entry export in WebAssembly.promising, so
// the program's stack suspends while the page's event loop runs on.

import type { WasiHost } from './host.js'
import { WasiExit } from './termination.js'

interface JspiNamespace {
  Suspending: new (fn: (...args: never[]) => unknown) => object
  promising: (fn: (...args: never[]) => unknown) => (...args: never[]) => Promise<unknown>
}

export class WasiJspiUnavailable extends Error {
  constructor () {
    super('This engine has no WebAssembly JavaScript Promise Integration (JSPI), which the WASI host needs to reach orivon.fs')
    this.name = 'WasiJspiUnavailable'
  }
}

/** `wasm` is the WebAssembly namespace to use: a test passes one from a JSPI-enabled context. */
function jspi (wasm: object): JspiNamespace {
  const candidate = wasm as Partial<JspiNamespace>
  if (typeof candidate.Suspending !== 'function' || typeof candidate.promising !== 'function') throw new WasiJspiUnavailable()
  return candidate as JspiNamespace
}

/**
 * The wasi_snapshot_preview1 namespace to instantiate against. The wrapped
 * functions go straight into the import object: a Suspending import reached
 * through any JavaScript frame traps instead of suspending.
 */
export function suspendingImports (host: WasiHost, wasm: object = WebAssembly): Record<string, unknown> {
  const { Suspending } = jspi(wasm)
  const imports: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(host.functions)) {
    imports[name] = host.suspending.has(name) ? new Suspending(fn) : fn
  }
  return imports
}

function exportedFunction (instance: WebAssembly.Instance, name: string): ((...args: never[]) => unknown) | undefined {
  const value = instance.exports[name]
  return typeof value === 'function' ? value as (...args: never[]) => unknown : undefined
}

export function bindInstanceMemory (instance: WebAssembly.Instance, host: WasiHost): void {
  const memory = instance.exports.memory
  if (typeof memory !== 'object' || memory === null || !('buffer' in memory)) throw new TypeError('A WASI program must export its memory as "memory"')
  host.bindMemory(memory as WebAssembly.Memory)
}

async function callEntry (instance: WebAssembly.Instance, entry: string, wasm: object): Promise<number> {
  const fn = exportedFunction(instance, entry)
  if (fn === undefined) throw new TypeError(`The WASI program does not export "${entry}"`)
  try {
    await jspi(wasm).promising(fn)()
    return 0
  } catch (error) {
    if (error instanceof WasiExit) return error.code
    throw error
  }
}

/**
 * Runs a command's `_start` to its end, then closes every file it left
 * open. Resolves with the exit code: 0 when `_start` returns, the argument
 * of proc_exit when the program calls it.
 */
export async function runCommand (instance: WebAssembly.Instance, host: WasiHost, wasm: object = WebAssembly): Promise<number> {
  bindInstanceMemory(instance, host)
  try {
    return await callEntry(instance, '_start', wasm)
  } finally {
    await host.finish()
  }
}

/**
 * Binds a reactor's memory and runs its `_initialize`, when it has one. Its
 * files stay open: a reactor lives on after `_initialize` returns. An export
 * JavaScript calls later reaches a suspending import only if it is called
 * through `WebAssembly.promising`.
 */
export async function initializeReactor (instance: WebAssembly.Instance, host: WasiHost, wasm: object = WebAssembly): Promise<void> {
  bindInstanceMemory(instance, host)
  if (exportedFunction(instance, '_initialize') !== undefined) await callEntry(instance, '_initialize', wasm)
}

/** A WASI object for a module JavaScript calls synchronously, in the shape Node's `WASI` and emnapi expect. */
export interface SyncWasi {
  readonly wasiImport: Readonly<Record<string, unknown>>
  initialize (instance: WebAssembly.Instance): void
  /** A command's `_start`, run to its end; returns its exit code. */
  start (instance: WebAssembly.Instance): number
}

/**
 * The host for a module with no `promising` entry, a native addon's
 * WebAssembly build: its imports never suspend, and initialize() binds its
 * memory and runs `_initialize` directly.
 */
export function synchronousWasi (host: WasiHost): SyncWasi {
  return {
    wasiImport: host.syncFunctions,
    initialize: (instance) => {
      bindInstanceMemory(instance, host)
      const init = exportedFunction(instance, '_initialize')
      if (init !== undefined) init()
    },
    start: (instance) => {
      bindInstanceMemory(instance, host)
      const run = exportedFunction(instance, '_start')
      if (run === undefined) throw new TypeError('The WASI program does not export "_start"')
      try {
        run()
        return 0
      } catch (error) {
        if (error instanceof WasiExit) return error.code
        throw error
      }
    }
  }
}
