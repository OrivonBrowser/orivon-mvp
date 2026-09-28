// jco, loaded from outside this repository for the opt-in tests that build
// components (it has native dependencies, so it is never one of this
// repository's, Rule 8). ORIVON_JCO_DIR names a directory holding
// @bytecodealliance/jco-transpile and jco's package/lib adapters; the
// commands to prepare one are in ../fixtures.test.ts.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  /** A core module written against `world` in `wit` (which may use the WASI 0.2.12 packages) made a component, then transpiled. */
  embedAndTranspile (module: Uint8Array, wit: string, world: string, name: string): Promise<Transpiled>
}

async function jcoModule (path: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(join(JCO_DIR as string, 'node_modules/@bytecodealliance/jco-transpile', path)).href) as Record<string, unknown>
}

export async function loadJco (): Promise<Jco> {
  const tools = await jcoModule('dist/wasm-tools.js')
  const bindgen = await jcoModule('vendor/js-component-bindgen-component.js')
  await bindgen.$init
  const adapter = readFileSync(join(JCO_DIR as string, 'package/lib/wasi_snapshot_preview1.command.wasm'))
  const componentNew = tools.componentNew as (bytes: Uint8Array, adapters?: Array<[string, Uint8Array]>) => Promise<Uint8Array>
  const componentEmbed = tools.componentEmbed as (options: { binary: Uint8Array, witPath: string, world: string }) => Promise<Uint8Array>
  const generate = bindgen.generate as (bytes: Uint8Array, options: unknown) => { files: Array<[string, Uint8Array]> }
  const transpile = (component: Uint8Array, name: string): Transpiled => {
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
  return {
    adaptAndTranspile: async (program, name) => transpile(await componentNew(program, [['wasi_snapshot_preview1', adapter]]), name),
    embedAndTranspile: async (module, wit, world, name) => {
      const dir = mkdtempSync(join(tmpdir(), 'orivon-wit-'))
      try {
        writeFileSync(join(dir, 'world.wit'), wit)
        cpSync(join(JCO_DIR as string, 'package/lib/wit/builtin/0.2.12'), join(dir, 'deps'), { recursive: true })
        return transpile(await componentNew(await componentEmbed({ binary: module, witPath: dir, world })), name)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}
