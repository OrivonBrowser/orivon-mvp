// Loads a native addon's WebAssembly build through emnapi, Node-API for
// WebAssembly, over the WASI host's synchronous imports. Node's dlopen is
// synchronous, so this is too: the build is fetched and compiled on the
// calling thread. A page's main thread refuses to compile a large module
// synchronously; preloadAddon does it asynchronously first, and a forked
// child, a Worker, has no such limit. The addon's file calls block on the
// page's orivon.fs, which only a Worker with shared memory can do.

import { instantiateNapiModule, instantiateNapiModuleSync, type InstantiateOptions } from '@emnapi/core'
import { getDefaultContext } from '@emnapi/runtime'
import { OrivonShimError, refuseShim } from '../errors.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { type SyncWasiFs, createWasiHost, type WasiFs } from '../wasi/host.js'
import { synchronousWasi } from '../wasi/instantiate.js'
import { SYNCHRONOUS } from '../worker/sync-channel.js'
import { importedMemory } from './imported-memory.js'
import { addonPath, addonUrls, isWasm } from './resolve.js'

/** Exports by the addon's path on the origin, however it was spelled when asked for. */
const loaded = new Map<string, unknown>()
const preloading = new Map<string, Promise<void>>()

/** A synchronous module's file calls go to `syncFs`; the asynchronous orivon.fs is never reached. */
const NO_FS = new Proxy({}, { get: () => { throw new Error('a native addon has no file system here') } }) as WasiFs

/** A forked child's orivon has a synchronous twin when the app is cross-origin isolated; a page's has none. */
function synchronousFs (): SyncWasiFs | undefined {
  const orivon = (globalThis as { orivon?: Record<PropertyKey, unknown> }).orivon
  return (orivon?.[SYNCHRONOUS] as { fs?: SyncWasiFs } | undefined)?.fs
}

interface WritableStdio { write?: (chunk: Uint8Array) => unknown }
type ShimProcess = { env?: Record<string, string | undefined>, stdout?: WritableStdio, stderr?: WritableStdio } | undefined

function dlopenError (filename: string, detail: string): Error {
  return Object.assign(new Error(`${filename}: ${detail}`), { code: 'ERR_DLOPEN_FAILED', reason: 'excluded' })
}

function notFound (filename: string, origin: string): Error {
  const tried = addonUrls(filename, origin).map((url) => new URL(url).pathname).join(', ')
  return dlopenError(filename, `no WebAssembly build found (${tried}); a native addon runs here only as WebAssembly`)
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

/**
 * Refuses by name what the loader cannot run: a threaded build needs
 * Workers sharing its memory, and a command build (one exporting `_start`)
 * is started through Node's own WASI internals, which emnapi reaches for.
 */
function assertLoadable (module: WebAssembly.Module, filename: string): void {
  if (WebAssembly.Module.imports(module).some((entry) => entry.module === 'wasi' && entry.name === 'thread-spawn')) {
    throw refuseShim('process.dlopen', 'not-built', `${filename} is a threaded WebAssembly build (wasm32-wasip1-threads); build it for wasm32-wasip1`)
  }
  if (WebAssembly.Module.exports(module).some((entry) => entry.name === '_start')) {
    throw dlopenError(filename, 'its WebAssembly build is a command (it exports _start); build the addon as a reactor, as napi-rs does and -mexec-model=reactor asks')
  }
}

type ImportObject = Record<string, Record<string, unknown>>

/**
 * The conventions a napi-rs build is loaded by, as its own loaders load it:
 * Node-API reached from `env` beside its own namespaces, `env.memory`
 * supplied at the size the build declares when it imports one, and each
 * `__napi_register__*` export run before the module initializes.
 */
function napiRsConventions (bytes: Uint8Array, filename: string): Pick<InstantiateOptions, 'overwriteImports' | 'beforeInit'> {
  const memory = memoryFor(bytes, filename)
  return {
    overwriteImports: (importObject: ImportObject) => {
      importObject.env = { ...importObject.env, ...importObject.napi, ...importObject.emnapi, ...(memory === undefined ? {} : { memory }) }
      return importObject
    },
    beforeInit: ({ instance }: { instance: WebAssembly.Instance }) => {
      for (const [name, value] of Object.entries(instance.exports)) {
        if (name.startsWith('__napi_register__') && typeof value === 'function') (value as () => void)()
      }
    }
  } as Pick<InstantiateOptions, 'overwriteImports' | 'beforeInit'>
}

/** 1 GiB: a build declaring more initial memory than this refuses rather than claiming it on the calling thread. napi-rs's own loaders start at 256 MiB. */
const MAX_INITIAL_PAGES = 16_384

/** The memory a build imports, at the size it declares; one this loader cannot supply refuses by name. */
function memoryFor (bytes: Uint8Array, filename: string): WebAssembly.Memory | undefined {
  const limits = importedMemory(bytes)
  if (limits === undefined) return undefined
  if (limits.shared) throw refuseShim('process.dlopen', 'not-built', `${filename} imports a shared memory, as a threaded build does; build it for wasm32-wasip1`)
  if (limits.memory64) throw dlopenError(filename, 'its WebAssembly build imports a 64-bit memory, which this loader does not supply')
  if (limits.initial > MAX_INITIAL_PAGES) throw dlopenError(filename, `its WebAssembly build declares ${limits.initial} pages of memory, more than the ${MAX_INITIAL_PAGES} an addon may start with`)
  try {
    return new WebAssembly.Memory({ initial: limits.initial, maximum: limits.maximum ?? 65_536 })
  } catch (error) {
    if (error instanceof RangeError) throw dlopenError(filename, `its WebAssembly build declares ${limits.initial} pages of memory, more than can be allocated`)
    throw error
  }
}

/** Addon output goes where Node's does: the process's stdout and stderr, a forked child's pipes included. */
function options (filename: string, bytes: Uint8Array): InstantiateOptions {
  const proc = (globalThis as { process?: ShimProcess }).process
  const env = proc?.env ?? {}
  const write = (stream: WritableStdio | undefined) => (bytes: Uint8Array): void => { stream?.write?.(bytes) }
  const syncFs = synchronousFs()
  const host = createWasiHost({
    fs: NO_FS,
    ...(syncFs === undefined ? {} : { syncFs }),
    args: [filename],
    env: Object.fromEntries(Object.entries(env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
    preopens: { '/': VIRTUAL_ROOT },
    ...(proc?.stdout?.write === undefined ? {} : { syncStdout: write(proc.stdout) }),
    ...(proc?.stderr?.write === undefined ? {} : { syncStderr: write(proc.stderr) })
  })
  return { context: getDefaultContext(), filename, wasi: synchronousWasi(host), asyncWorkPoolSize: 0, ...napiRsConventions(bytes, filename) }
}

/** A failure while the build instantiates or registers (a trap in its code included) is ERR_DLOPEN_FAILED, as Node's dlopen reports one. */
function instantiationFailure (filename: string, error: unknown): Error {
  if (error instanceof OrivonShimError || (error as { code?: unknown } | null)?.code === 'ERR_DLOPEN_FAILED') return error as Error
  return dlopenError(filename, `its WebAssembly build failed while loading: ${String((error as Error)?.message ?? error)}`)
}

function keyOf (filename: string, origin: string): string {
  const path = addonPath(filename, origin)
  if (path === undefined) throw dlopenError(filename, 'a native addon must come from the app\'s own origin')
  return path
}

/** The addon's exports, loading it the first time. Throws ERR_DLOPEN_FAILED when no WebAssembly build is found. */
export function loadAddon (filename: string, origin: string = globalThis.location.origin): unknown {
  const key = keyOf(filename, origin)
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
    assertLoadable(module, filename)
    let exports: unknown
    try {
      exports = instantiateNapiModuleSync(module, options(filename, bytes)).napiModule.exports
    } catch (error) {
      throw instantiationFailure(filename, error)
    }
    loaded.set(key, exports)
    return exports
  }
  throw notFound(filename, origin)
}

async function preload (filename: string, key: string, origin: string): Promise<void> {
  for (const url of addonUrls(key, origin)) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok !== true) continue
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!isWasm(bytes)) continue
    let module: WebAssembly.Module
    try {
      module = await WebAssembly.compile(bytes)
    } catch (error) {
      throw dlopenError(filename, `its WebAssembly build is not valid: ${String(error)}`)
    }
    assertLoadable(module, filename)
    // A synchronous load may have finished while this one was compiling: the first instance stays.
    if (loaded.has(key)) return
    let exports: unknown
    try {
      exports = (await instantiateNapiModule(module, options(filename, bytes))).napiModule.exports
    } catch (error) {
      throw instantiationFailure(filename, error)
    }
    if (!loaded.has(key)) loaded.set(key, exports)
    return
  }
  throw notFound(filename, origin)
}

/** Fetches, compiles and instantiates the addon asynchronously, so a later synchronous load finds it ready. */
export async function preloadAddon (filename: string, origin: string = globalThis.location.origin): Promise<void> {
  const key = keyOf(filename, origin)
  if (loaded.has(key)) return
  let pending = preloading.get(key)
  if (pending === undefined) {
    pending = preload(filename, key, origin).finally(() => preloading.delete(key))
    preloading.set(key, pending)
  }
  await pending
}
