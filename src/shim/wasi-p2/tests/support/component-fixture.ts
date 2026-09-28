// The WASI 0.2 component fixture (../fixtures.test.ts regenerates it), and
// how a test loads jco's glue: evaluated with the JSPI namespace standing in
// for the global WebAssembly it reads, since Node keeps JSPI behind a flag.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GetCoreModule, Instantiate } from '../../run.js'

export const TOUR_FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'tour.generated.json')

export interface ComponentFixture {
  readonly glue: string
  readonly cores: ReadonlyMap<string, Uint8Array>
}

export function tourFixture (): ComponentFixture {
  const { glue, cores } = JSON.parse(readFileSync(TOUR_FIXTURE, 'utf8')) as { glue: string, cores: Record<string, string> }
  return { glue, cores: new Map(Object.entries(cores).map(([name, base64]) => [name, new Uint8Array(Buffer.from(base64, 'base64'))])) }
}

type GlueInstantiate = (getCoreModule: GetCoreModule, imports: Record<string, unknown>, instantiateCore: (module: WebAssembly.Module, imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>) => Promise<Record<string, unknown>>

/**
 * The glue's `instantiate`, its fallback loader's import.meta removed: a test
 * always passes getCoreModule. Instances are created through a main-realm
 * promise, because the glue drives its steps with `instanceof Promise`,
 * which a promise from the JSPI context fails.
 */
export function instantiateFrom (glue: string, wasm: typeof WebAssembly): Instantiate {
  const body = glue.replace(/\bexport\s*\{[^}]*\}\s*;?/g, '').replace(/\bexport\s+(?=function|const|let|class)/g, '').replace(/import\.meta\.url/g, 'undefined')
  const exported = /export\s*\{[^}]*?\b(\w+)\s+as\s+instantiate\b/.exec(glue)?.[1] ?? 'instantiate'
  // eslint-disable-next-line no-new-func -- the glue is generated code the test must evaluate against the JSPI namespace
  const instantiate = new Function('WebAssembly', `${body}\nreturn ${exported}`)(wasm) as GlueInstantiate
  return async (getCoreModule, imports) => await instantiate(getCoreModule, imports, async (module, moduleImports) => await wasm.instantiate(module, moduleImports))
}

export function coreModules (fixture: ComponentFixture, wasm: typeof WebAssembly): GetCoreModule {
  return async (name) => await wasm.compile(fixture.cores.get(name) as Uint8Array<ArrayBuffer>)
}
