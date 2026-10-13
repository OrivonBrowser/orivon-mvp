// Loads the Nym module from a directory and starts a tunnel from it. The module is wasm-bindgen output that keeps
// its state in the module instance, and allows one tunnel per instance, so each tunnel imports the glue afresh and
// instantiates the one compiled `.wasm`. Every byte that runs was read once and hashed against the pin
// (../local-node/pinned-file.ts).

import { PinMismatch, readPinned } from '../local-node/pinned-file.js'
import type { TcpStream, Tunnel, UdpChannel } from './instances.js'
import { MODULE_GLUE, MODULE_WASM } from './protocol.js'
import type { PinnedFile } from './protocol.js'

/** What the glue exports that this host calls. */
export interface ModuleExports {
  initSync: (input: { module: WebAssembly.Module }) => unknown
  main: () => void
  setupMixTunnel: (options: { clientId: string }) => Promise<unknown>
  connectTcp: (host: string, port: number) => Promise<TcpStream>
  bindUdp: () => Promise<UdpChannel>
  disconnectMixTunnel: () => Promise<unknown>
}

const REQUIRED: ReadonlyArray<keyof ModuleExports> = ['initSync', 'main', 'setupMixTunnel', 'connectTcp', 'bindUdp', 'disconnectMixTunnel']

/** What a test replaces. */
export interface LoaderSeams {
  /** Imports the glue source as a module; the default imports a `data:` URL made of the bytes that were hashed. */
  readonly importGlue?: (source: Buffer) => Promise<unknown>
  readonly compile?: (bytes: Buffer) => Promise<WebAssembly.Module>
  /** How long a tunnel may take to come up before it counts as failed. */
  readonly startTimeoutMs?: number
}

export const START_TIMEOUT_MS = 90_000

export interface NymModule {
  /** Brings up a tunnel in a module instance of its own. */
  start: (clientId: string) => Promise<Tunnel>
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function exportsOf (namespace: unknown): ModuleExports {
  const found = namespace as Partial<Record<keyof ModuleExports, unknown>>
  const missing = REQUIRED.filter((name) => typeof found[name] !== 'function')
  if (missing.length > 0) throw new PinMismatch(`${MODULE_GLUE} does not export ${missing.join(', ')}`)
  return namespace as ModuleExports
}

export async function loadNymModule (directory: string, files: readonly PinnedFile[], seams: LoaderSeams = {}): Promise<NymModule> {
  const glue = await readPinned(directory, files, MODULE_GLUE)
  const wasm = await readPinned(directory, files, MODULE_WASM)
  const compiled = await (seams.compile ?? (async (bytes) => await WebAssembly.compile(bytes as unknown as Uint8Array<ArrayBuffer>)))(wasm)
  const importGlue = seams.importGlue ?? (async (source: Buffer) => await import(/* @vite-ignore */ `data:text/javascript;base64,${source.toString('base64')}`) as unknown)
  let instance = 0
  // Fails here, not at the first tunnel, when the glue is not the module.
  exportsOf(await importGlue(glue))

  return {
    start: async (clientId) => {
      instance += 1
      // The same text under a name of its own is a module of its own: its wasm state is not shared.
      const source = Buffer.concat([glue, Buffer.from(`\n//# orivon-instance ${String(instance)}\n`)])
      const module = exportsOf(await importGlue(source))
      module.initSync({ module: compiled })
      module.main()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          module.setupMixTunnel({ clientId }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`no gateway answered within ${String(Math.round((seams.startTimeoutMs ?? START_TIMEOUT_MS) / 1000))} s`)) }, seams.startTimeoutMs ?? START_TIMEOUT_MS) })
        ])
      } catch (error) {
        module.disconnectMixTunnel().catch(() => {})
        throw new Error(describe(error))
      } finally {
        clearTimeout(timer)
      }
      return {
        connectTcp: async (host, port) => await module.connectTcp(host, port),
        bindUdp: async () => await module.bindUdp(),
        disconnect: async () => { await module.disconnectMixTunnel() }
      }
    }
  }
}
