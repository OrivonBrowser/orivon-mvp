// Loads jco's output for the node from a directory, running only bytes that
// match the pins main handed over: each file is read once, hashed, and the
// glue is imported and each core module compiled from those same bytes, so
// nothing can change between the check and the run. Entered through the WASI
// host (src/shim/wasi-p2/run.ts).

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJcoOutput, instantiateComponent, transpileCommand, unmarkedAsyncImports } from '../../shim/wasi-p2/run.js'
import type { GetCoreModule, Instantiate } from '../../shim/wasi-p2/run.js'
import type { PinnedFile } from './protocol.js'

export interface LoadedComponent {
  /** Runs the component to its end and resolves with its exit code. */
  readonly run: () => Promise<number>
  /** How long the core modules took to compile, in ms. */
  readonly compileMs: number
}

/** A file whose bytes are not the ones the build pins, or that the build does not pin at all. */
export class PinMismatch extends Error {}

const PINNED_NAME = /^[\w.-]+$/

/** The pinned file `file`, read once, with the bytes that were hashed: a name that is not pinned, or bytes that differ from the pin, are refused. */
export async function readPinned (directory: string, pins: readonly PinnedFile[], file: string): Promise<Buffer> {
  const pin = PINNED_NAME.test(file) ? pins.find((entry) => entry.name === file) : undefined
  if (pin === undefined) throw new PinMismatch(`the component asks for ${JSON.stringify(file)}, which this build does not pin`)
  const bytes = await readFile(join(directory, file))
  if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new PinMismatch(`${file} is not the file this build pins`)
  return bytes
}

/** The pinned core module `file`, compiled from the bytes that were checked. */
export function coreModuleReader (directory: string, pins: readonly PinnedFile[], compiled: { ms: number }, wasm: typeof WebAssembly = WebAssembly): GetCoreModule {
  return async (file) => {
    if (!file.endsWith('.wasm')) throw new Error(`the component asks for a core module named ${JSON.stringify(file)}`)
    const bytes = await readPinned(directory, pins, file)
    const started = performance.now()
    const module = await wasm.compile(bytes as unknown as Uint8Array<ArrayBuffer>)
    compiled.ms += performance.now() - started
    return module
  }
}

/** What a test replaces: the process that has JSPI already imports the glue itself and uses its own WebAssembly. */
export interface LoaderSeams {
  readonly instantiate?: (glue: string, file: string) => Promise<Instantiate>
  readonly wasm?: typeof WebAssembly
}

export async function loadComponent (directory: string, name: string, pins: readonly PinnedFile[], imports: Record<string, unknown>, seams: LoaderSeams = {}): Promise<LoadedComponent> {
  const glueFile = `${name}.js`
  const glueBytes = await readPinned(directory, pins, glueFile)
  const glue = glueBytes.toString('utf8')
  if (!isJcoOutput(glue)) throw new Error(`${glueFile} is not jco's output for a component`)
  const unmarked = unmarkedAsyncImports(glue)
  if (unmarked.length > 0) throw new Error(`the component was not transpiled for this host (${unmarked.join(', ')}): ${transpileCommand(`${name}.wasm`)}`)
  const instantiate = seams.instantiate === undefined
    ? (await import(/* @vite-ignore */ `data:text/javascript;base64,${glueBytes.toString('base64')}`) as { instantiate: Instantiate }).instantiate
    : await seams.instantiate(glue, glueFile)
  const compiled = { ms: 0 }
  const run = await instantiateComponent(instantiate, coreModuleReader(directory, pins, compiled, seams.wasm), imports)
  return { run, compileMs: compiled.ms }
}
