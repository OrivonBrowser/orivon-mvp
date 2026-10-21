// Loads the Nym module from a directory and starts a tunnel from it. The module is wasm-bindgen output that keeps
// its state in the module instance, and allows one tunnel per instance, so each tunnel imports the glue afresh and
// instantiates the one compiled `.wasm`. Every byte that runs was read once and hashed against the pin
// (../local-node/pinned-file.ts).

import { randomBytes } from 'node:crypto'
import { PinMismatch, readPinned } from '../local-node/pinned-file.js'
import { createResolver, DnsError } from './dns.js'
import { StallError } from './instances.js'
import type { TcpStream, Tunnel, UdpChannel } from './instances.js'
import { MODULE_GLUE, MODULE_WASM, mixOptionsFor } from './protocol.js'
import type { MixPrivacyOptions, NymPrivacy, PinnedFile } from './protocol.js'

/** What the glue exports that this host calls. */
export interface ModuleExports {
  initSync: (input: { module: WebAssembly.Module }) => unknown
  main: () => void
  setupMixTunnel: (options: { clientId: string } & MixPrivacyOptions) => Promise<unknown>
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
  /** How long one attempt to bring a tunnel up may take before it counts as failed. */
  readonly startTimeoutMs?: number
  readonly startAttempts?: number
}

/** A tunnel comes up in 3 to 8 s; the gateway picked at random is sometimes slow or gone, and another pick is better than a longer wait. */
export const START_TIMEOUT_MS = 30_000
export const START_ATTEMPTS = 3

export interface NymModule {
  /** Brings up a tunnel in a module instance of its own, for the user name `name`, at the privacy level `privacy`; a failed attempt is tried again under a new identity. */
  start: (name: string, privacy: NymPrivacy) => Promise<Tunnel>
  /** How many module instances have been made, failed attempts included: each stays in memory until the process exits. */
  instances: () => number
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

  const attempt = async (name: string, privacy: NymPrivacy): Promise<Tunnel> => {
    instance += 1
    // The same text under a name of its own is a module of its own: its wasm state is not shared.
    const source = Buffer.concat([glue, Buffer.from(`\n//# orivon-instance ${String(instance)}\n`)])
    const module = exportsOf(await importGlue(source))
    module.initSync({ module: compiled })
    module.main()
    // A new identity at each attempt: the gateway is picked at the first registration of an identity and kept after.
    const clientId = `${name}-${randomBytes(6).toString('hex')}`
    const limit = seams.startTimeoutMs ?? START_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        module.setupMixTunnel({ clientId, ...mixOptionsFor(privacy) }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`no gateway answered within ${String(Math.round(limit / 1000))} s`)) }, limit) })
      ])
    } catch (error) {
      module.disconnectMixTunnel().catch(() => {})
      throw new Error(describe(error))
    } finally {
      clearTimeout(timer)
    }
    const resolver = createResolver({ bind: async () => await module.bindUdp() })
    return {
      connectTcp: async (host, port) => {
        let address: string
        try {
          address = await resolver.resolve(host)
        } catch (error) {
          // A name that does not exist, or that the resolvers could not answer for, is about the name. A lookup that got no answer at all,
          // or a socket that cannot be bound, is about the tunnel.
          if (error instanceof DnsError && (error.kind === 'no-such-name' || error.kind === 'failed' || error.kind === 'invalid' || error.kind === 'closed')) throw error
          throw new StallError(describe(error))
        }
        // The module's own connect timeout says the destination did not answer, which a destination can cause by itself: it is a refusal.
        return await module.connectTcp(address, port)
      },
      bindUdp: async () => await module.bindUdp(),
      disconnect: async () => {
        resolver.close()
        await module.disconnectMixTunnel()
      }
    }
  }

  return {
    instances: () => instance,
    start: async (name, privacy) => {
      const attempts = seams.startAttempts ?? START_ATTEMPTS
      let last: unknown
      for (let tried = 0; tried < attempts; tried += 1) {
        try {
          return await attempt(name, privacy)
        } catch (error) {
          last = error
        }
      }
      throw last instanceof Error ? last : new Error(describe(last))
    }
  }
}
