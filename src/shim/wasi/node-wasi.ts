// `wasi` module target (module-map.ts): Node's WASI class over the host.
// Two departures from Node, both forced: start() and initialize() return
// promises, because a program suspends on every file call (JSPI); and
// `preopens` values are paths under the app's virtual root, since an app
// tab has no host paths.

import { getOrivon } from '../orivon-global.js'
import { codedError } from '../node-errors.js'
import { refuseShim } from '../errors.js'
import { nodeModule } from '../polyfills/module-proxy.js'
import { createWasiHost, type WasiHost } from './host.js'
import { initializeReactor, runCommand, suspendingImports } from './instantiate.js'

export interface WASIOptions {
  readonly version: 'preview1' | 'unstable'
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly preopens?: Readonly<Record<string, string>>
  readonly returnOnExit?: boolean
  readonly stdin?: number
  readonly stdout?: number
  readonly stderr?: number
}

function invalidArg (name: string, expected: string, value: unknown): TypeError {
  return codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}. Received ${typeof value}`)
}

function validate (options: WASIOptions): void {
  if (typeof options !== 'object' || options === null) throw invalidArg('options', 'of type object', options)
  if (options.version === 'unstable') {
    throw refuseShim('wasi.WASI', 'not-applicable', "WASI version 'unstable' predates preview1 and is not hosted here; build for wasm32-wasip1")
  }
  if (options.version !== 'preview1') throw invalidArg('options.version', "one of 'unstable' or 'preview1'", options.version)
  if (options.args !== undefined && !Array.isArray(options.args)) throw invalidArg('options.args', 'an instance of Array', options.args)
  if (options.returnOnExit === false) {
    throw refuseShim('wasi.WASI', 'not-applicable', 'returnOnExit: false ends the host process, and an app tab cannot end its own')
  }
  for (const [name, fd] of [['stdin', 0], ['stdout', 1], ['stderr', 2]] as const) {
    const given = options[name]
    if (given !== undefined && given !== fd) {
      throw refuseShim(`wasi.WASI options.${name}`, 'not-applicable', `options.${name} names a host file descriptor, and an app tab has none`)
    }
  }
}

export class WASI {
  readonly wasiImport: Record<string, unknown>
  readonly #host: WasiHost
  #started = false

  constructor (options: WASIOptions) {
    validate(options)
    this.#host = createWasiHost({
      fs: getOrivon().fs,
      args: options.args ?? [],
      env: options.env ?? {},
      preopens: options.preopens ?? {}
    })
    this.wasiImport = suspendingImports(this.#host)
  }

  getImportObject (): { wasi_snapshot_preview1: Record<string, unknown> } {
    return { wasi_snapshot_preview1: this.wasiImport }
  }

  /** Runs a command's `_start`; resolves with its exit code. */
  async start (instance: WebAssembly.Instance): Promise<number> {
    this.#claim(instance, '_initialize')
    return await runCommand(instance, this.#host)
  }

  /** Runs a reactor's `_initialize`, if it exports one. */
  async initialize (instance: WebAssembly.Instance): Promise<void> {
    this.#claim(instance, '_start')
    await initializeReactor(instance, this.#host)
  }

  #claim (instance: WebAssembly.Instance, forbidden: string): void {
    if (this.#started) throw codedError(Error, 'ERR_WASI_ALREADY_STARTED', 'WASI instance has already started')
    if (typeof instance !== 'object' || instance === null || typeof instance.exports !== 'object') {
      throw invalidArg('instance', 'an instance of WebAssembly.Instance', instance)
    }
    if (instance.exports[forbidden] !== undefined) {
      throw invalidArg(`instance.exports.${forbidden}`, 'undefined', instance.exports[forbidden])
    }
    this.#started = true
  }
}

export default nodeModule('wasi', { WASI })
