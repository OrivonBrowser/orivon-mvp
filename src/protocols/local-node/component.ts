// Loads jco's output for the node from a directory, running only bytes that
// match the pins main handed over: each file is read once, hashed, and the
// glue is imported and each core module compiled from those same bytes (the
// glue with its debug log switched off, the one edit), so nothing can change
// between the check and the run. Entered through the WASI host
// (src/shim/wasi-p2/run.ts).

import { isJcoOutput, instantiateComponent, transpileCommand, unmarkedAsyncImports } from '../../shim/wasi-p2/run.js'
import type { GetCoreModule, Instantiate } from '../../shim/wasi-p2/run.js'
import { PinMismatch, readPinned } from './pinned-file.js'
import type { PinnedFile } from './protocol.js'

export { PinMismatch, readPinned }

export interface LoadedComponent {
  /** Runs the component to its end and resolves with its exit code. */
  readonly run: () => Promise<number>
  /** How long the core modules took to compile, in ms. */
  readonly compileMs: number
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

/** jco's debug log as its glue defines it: every import call reads `process.env` through it, twice. */
const DEBUG_LOG = 'const _debugLog = (...args) => {\n    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }\n    console.debug(...args);\n  };'

/** The pinned glue with its debug log made a no-op, unless JCO_DEBUG is set or the glue does not define the log exactly once. */
function withoutDebugLog (glue: string): string {
  if (process.env.JCO_DEBUG) return glue
  const parts = glue.split(DEBUG_LOG)
  return parts.length === 2 ? parts.join('const _debugLog = () => {};') : glue
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
  const running = withoutDebugLog(glue)
  const runningBytes = running === glue ? glueBytes : Buffer.from(running)
  const instantiate = seams.instantiate === undefined
    ? (await import(/* @vite-ignore */ `data:text/javascript;base64,${runningBytes.toString('base64')}`) as { instantiate: Instantiate }).instantiate
    : await seams.instantiate(running, glueFile)
  const compiled = { ms: 0 }
  const run = await instantiateComponent(instantiate, coreModuleReader(directory, pins, compiled, seams.wasm), imports)
  return { run, compileMs: compiled.ms }
}
