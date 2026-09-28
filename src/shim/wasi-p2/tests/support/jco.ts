// jco, loaded from outside this repository for the opt-in tests that build
// components (it has native dependencies, so it is never one of this
// repository's, Rule 8). ORIVON_JCO_DIR names a directory holding
// @bytecodealliance/jco-transpile and jco's package/lib adapters; the
// commands to prepare one are in ../fixtures.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASYNC_EXPORTS, ASYNC_IMPORTS } from '../../imports.js'

export const JCO_DIR = process.env.ORIVON_JCO_DIR

export interface Transpiled {
  readonly glue: string
  readonly cores: ReadonlyMap<string, Uint8Array>
}

export interface Jco {
  /** A preview1 command made a WASI 0.2 component with the preview1 adapter, then transpiled as a port is told to. */
  adaptAndTranspile (program: Uint8Array, name: string): Promise<Transpiled>
}

async function jcoModule (path: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(join(JCO_DIR as string, 'node_modules/@bytecodealliance/jco-transpile', path)).href) as Record<string, unknown>
}

export async function loadJco (): Promise<Jco> {
  const tools = await jcoModule('dist/wasm-tools.js')
  const bindgen = await jcoModule('vendor/js-component-bindgen-component.js')
  await bindgen.$init
  const adapter = readFileSync(join(JCO_DIR as string, 'package/lib/wasi_snapshot_preview1.command.wasm'))
  const componentNew = tools.componentNew as (bytes: Uint8Array, adapters: Array<[string, Uint8Array]>) => Promise<Uint8Array>
  const generate = bindgen.generate as (bytes: Uint8Array, options: unknown) => { files: Array<[string, Uint8Array]> }
  return {
    adaptAndTranspile: async (program, name) => {
      const component = await componentNew(program, [['wasi_snapshot_preview1', adapter]])
      const files = new Map(generate(component, {
        name,
        instantiation: { tag: 'async' },
        asyncMode: { tag: 'jspi', val: { imports: [...ASYNC_IMPORTS], exports: [...ASYNC_EXPORTS] } },
        noNodejsCompat: true,
        noTypescript: true,
        map: []
      }).files)
      return {
        glue: new TextDecoder().decode(files.get(`${name}.js`)),
        cores: new Map([...files].filter(([file]) => file.endsWith('.wasm')))
      }
    }
  }
}
