// Runs a WASI 0.2 command component from jco's transpiled output: checks the
// output marks every import the host answers asynchronously, instantiates
// it against the host, and enters it through wasi:cli/run.

import { ComponentExit } from './basics.js'
import { ASYNC_IMPORTS } from './imports.js'

export type GetCoreModule = (name: string) => Promise<WebAssembly.Module>
export type Instantiate = (getCoreModule: GetCoreModule, imports: Record<string, unknown>) => Promise<Record<string, unknown>>

/**
 * jco's glue names each import it lowers `<interface>@<version>#<camelCaseName>`
 * and marks an asynchronous one right after; the pattern survives a minifier.
 */
const TRAMPOLINE = /([\w$]+)\.fnName\s*=\s*(['"])([^'"@]+)@[^'"#]*#([^'"]+)\2\s*[;,]?\s*(\1\.manuallyAsync\s*=\s*(?:true|!0))?/g

function camelCase (name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/** `wasi:io/poll#[method]pollable.block` as the glue names it: `wasi:io/poll#block`. */
function glueName (selector: string): string {
  const [iface = '', fn = ''] = selector.split('#')
  return `${iface}#${camelCase(fn.slice(fn.lastIndexOf('.') + 1))}`
}

const ASYNC_GLUE_NAMES = new Set(ASYNC_IMPORTS.map(glueName))

/** The imports the host answers asynchronously that `glue` lowers synchronously: each would receive a promise. */
export function unmarkedAsyncImports (glue: string): string[] {
  const unmarked: string[] = []
  for (const [, , , iface, fn, marked] of glue.matchAll(TRAMPOLINE)) {
    const name = `${iface}#${fn}`
    if (ASYNC_GLUE_NAMES.has(name) && marked === undefined) unmarked.push(name)
  }
  return unmarked
}

/** The command a port transpiles a component with, for the message that refuses output made otherwise. */
export function transpileCommand (component: string): string {
  const name = component.replace(/^.*\//, '').replace(/\.wasm$/, '')
  return `jco transpile ${component} --name ${name} -o ${name}.p2 --instantiation async --async-mode jspi --no-nodejs-compat ` +
    `--async-exports wasi:cli/run#run ${ASYNC_IMPORTS.map((selector) => `--async-imports '${selector}'`).join(' ')}`
}

function runExport (exports: Record<string, unknown>): () => Promise<unknown> {
  const entry = Object.entries(exports).find(([key]) => key === 'run' || key.startsWith('wasi:cli/run@'))?.[1] as { run?: unknown } | undefined
  if (typeof entry?.run !== 'function') throw new TypeError('the component does not export wasi:cli/run: only a command component can be spawned')
  return entry.run as () => Promise<unknown>
}

/**
 * Instantiates the component; the function it resolves with runs it, and
 * resolves with the exit code: 0 when run returns, 1 when it returns an
 * error, the code wasi:cli/exit was given otherwise.
 */
export async function instantiateComponent (instantiate: Instantiate, getCoreModule: GetCoreModule, imports: Record<string, unknown>): Promise<() => Promise<number>> {
  const run = runExport(await instantiate(getCoreModule, imports))
  return async () => {
    try {
      await run()
      return 0
    } catch (error) {
      if (error instanceof ComponentExit) return error.code
      if (typeof error === 'object' && error !== null && 'payload' in error) return 1
      throw error
    }
  }
}

export async function runComponent (instantiate: Instantiate, getCoreModule: GetCoreModule, imports: Record<string, unknown>): Promise<number> {
  return await (await instantiateComponent(instantiate, getCoreModule, imports))()
}
