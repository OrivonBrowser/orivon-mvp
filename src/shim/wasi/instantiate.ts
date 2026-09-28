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

/**
 * Runs `entry` (a command's `_start`, a reactor's `_initialize`) to its end.
 * Resolves with the exit code: 0 when the entry returns, the argument of
 * proc_exit when the program calls it.
 */
export async function runEntry (instance: WebAssembly.Instance, host: WasiHost, entry: string, wasm: object = WebAssembly): Promise<number> {
  const fn = exportedFunction(instance, entry)
  if (fn === undefined) throw new TypeError(`The WASI program does not export "${entry}"`)
  bindInstanceMemory(instance, host)
  try {
    await jspi(wasm).promising(fn)()
    return 0
  } catch (error) {
    if (error instanceof WasiExit) return error.code
    throw error
  } finally {
    await host.finish()
  }
}
