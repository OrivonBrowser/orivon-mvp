// Loads a native addon's WebAssembly build through emnapi, Node-API for
// WebAssembly, over the WASI host's synchronous imports. Node's dlopen is
// synchronous, so this is too: the build is fetched and compiled on the
// calling thread. A page's main thread refuses to compile a large module
// synchronously; preloadAddon does it asynchronously first, and a forked
// child, a Worker, has no such limit.

import { instantiateNapiModule, instantiateNapiModuleSync, type InstantiateOptions } from '@emnapi/core'
import { getDefaultContext } from '@emnapi/runtime'
import { refuseShim } from '../errors.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { createWasiHost, type WasiFs } from '../wasi/host.js'
import { synchronousWasi } from '../wasi/instantiate.js'
import { addonUrls, isWasm } from './resolve.js'

const loaded = new Map<string, unknown>()

/** A synchronous module never reaches the file system (sync-fallbacks.ts), so its host needs none. */
const NO_FS = new Proxy({}, { get: () => { throw new Error('a native addon has no file system here') } }) as WasiFs

function keyOf (filename: string): string {
  return filename.startsWith('file://') ? new URL(filename).pathname : filename
}

function dlopenError (filename: string, detail: string): Error {
  return Object.assign(new Error(`${filename}: ${detail}`), { code: 'ERR_DLOPEN_FAILED', reason: 'excluded' })
}

/** Synchronous GET of a binary resource. A document may not set responseType on a synchronous request, a Worker may. */
function fetchSync (url: string): Uint8Array | undefined {
  const request = new XMLHttpRequest()
  request.open('GET', url, false)
  const inDocument = typeof document !== 'undefined'
  if (inDocument) request.overrideMimeType('text/plain; charset=x-user-defined')
  else request.responseType = 'arraybuffer'
  try {
    request.send()
  } catch {
    return undefined
  }
  if (request.status !== 200) return undefined
  if (!inDocument) return new Uint8Array(request.response as ArrayBuffer)
  const text = request.responseText
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** A threaded build needs Workers sharing its memory, which the loader does not start. */
function refuseThreaded (module: WebAssembly.Module, filename: string): void {
  const threaded = WebAssembly.Module.imports(module).some((entry) => entry.module === 'wasi' && entry.name === 'thread-spawn')
  if (threaded) {
    throw refuseShim('process.dlopen', 'not-built', `${filename} is a threaded WebAssembly build (wasm32-wasip1-threads); build it for wasm32-wasip1`)
  }
}

function options (filename: string): InstantiateOptions {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const host = createWasiHost({
    fs: NO_FS,
    args: [filename],
    env: Object.fromEntries(Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
    preopens: { '/': VIRTUAL_ROOT }
  })
  return { context: getDefaultContext(), filename, wasi: synchronousWasi(host), asyncWorkPoolSize: 0 }
}

/** The addon's exports, loading it the first time. Throws ERR_DLOPEN_FAILED when no WebAssembly build is found. */
export function loadAddon (filename: string, origin: string = globalThis.location.origin): unknown {
  const key = keyOf(filename)
  if (loaded.has(key)) return loaded.get(key)
  for (const url of addonUrls(key, origin)) {
    const bytes = fetchSync(url)
    if (bytes === undefined || !isWasm(bytes)) continue
    let module: WebAssembly.Module
    try {
      module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>)
    } catch (error) {
      if (error instanceof RangeError) {
        throw dlopenError(filename, `its WebAssembly build is too large to compile synchronously on the page: await preloadAddon('${filename}') before loading it, or load it in a forked child`)
      }
      throw dlopenError(filename, `its WebAssembly build is not valid: ${String(error)}`)
    }
    refuseThreaded(module, filename)
    const { napiModule } = instantiateNapiModuleSync(module, options(filename))
    loaded.set(key, napiModule.exports)
    return napiModule.exports
  }
  throw dlopenError(filename, `no WebAssembly build found (${addonUrls(key, origin).map((url) => new URL(url).pathname).join(', ')}); a native addon runs here only as WebAssembly`)
}

/** Fetches, compiles and instantiates the addon asynchronously, so a later synchronous load finds it ready. */
export async function preloadAddon (filename: string, origin: string = globalThis.location.origin): Promise<void> {
  const key = keyOf(filename)
  if (loaded.has(key)) return
  for (const url of addonUrls(key, origin)) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok !== true) continue
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!isWasm(bytes)) continue
    const module = await WebAssembly.compile(bytes)
    refuseThreaded(module, filename)
    const { napiModule } = await instantiateNapiModule(module, options(filename))
    loaded.set(key, napiModule.exports)
    return
  }
  throw dlopenError(filename, 'no WebAssembly build found; a native addon runs here only as WebAssembly')
}
