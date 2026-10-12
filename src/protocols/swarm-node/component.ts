// Loads jco's output for the node from a directory: the glue imported as the
// text that was read and checked, each core module read and compiled, then entered through the WASI host
// (src/shim/wasi-p2/run.ts). The directory's content is pinned by hash when it
// is fetched (scripts/fetch-swarm-node.mjs), so what runs is what was pinned.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJcoOutput, instantiateComponent, transpileCommand, unmarkedAsyncImports } from '../../shim/wasi-p2/run.js'
import type { GetCoreModule, Instantiate } from '../../shim/wasi-p2/run.js'

export interface LoadedComponent {
  /** Runs the component to its end and resolves with its exit code. */
  readonly run: () => Promise<number>
  /** How long the core modules took to compile, in ms. */
  readonly compileMs: number
}

const CORE_MODULE = /^[\w.-]+\.wasm$/

/** The directory's core module `file`, compiled. A name with a separator, or not a `.wasm`, is refused: the glue is generated, but it is read as data here. */
export function coreModuleReader (directory: string, compiled: { ms: number }, wasm: typeof WebAssembly = WebAssembly): GetCoreModule {
  return async (file) => {
    if (!CORE_MODULE.test(file)) throw new Error(`the component asks for a core module named ${JSON.stringify(file)}`)
    const bytes = await readFile(join(directory, file))
    const started = performance.now()
    const module = await wasm.compile(bytes)
    compiled.ms += performance.now() - started
    return module
  }
}

/** What a test replaces: the process that has JSPI already imports the glue itself and uses its own WebAssembly. */
export interface LoaderSeams {
  readonly instantiate?: (glue: string, file: string) => Promise<Instantiate>
  readonly wasm?: typeof WebAssembly
}

export async function loadComponent (directory: string, name: string, imports: Record<string, unknown>, seams: LoaderSeams = {}): Promise<LoadedComponent> {
  const glueFile = join(directory, `${name}.js`)
  const glue = await readFile(glueFile, 'utf8')
  if (!isJcoOutput(glue)) throw new Error(`${glueFile} is not jco's output for a component`)
  const unmarked = unmarkedAsyncImports(glue)
  if (unmarked.length > 0) throw new Error(`the component was not transpiled for this host (${unmarked.join(', ')}): ${transpileCommand(`${name}.wasm`)}`)
  const instantiate = seams.instantiate === undefined
    ? (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(glue).toString('base64')}`) as { instantiate: Instantiate }).instantiate
    : await seams.instantiate(glue, glueFile)
  const compiled = { ms: 0 }
  const run = await instantiateComponent(instantiate, coreModuleReader(directory, compiled, seams.wasm), imports)
  return { run, compileMs: compiled.ms }
}
