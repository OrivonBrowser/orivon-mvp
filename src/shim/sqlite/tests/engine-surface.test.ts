// The engine's internals this module leans on, checked against the real
// package: an upgrade that renames or removes one fails here, by name, before
// anything reaches a database. Also the facts that decide how the engine starts.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadSqliteEngine, sqliteEngine } from '../engine.js'
import type { Sqlite3 } from '../engine.js'
import { loadTestEngine } from './support/engine.js'

const require = createRequire(import.meta.url)
const typesSource = readFileSync(new URL('../engine-types.ts', import.meta.url), 'utf8')

/** The member names one interface of engine-types.ts declares. */
function declared (name: string): string[] {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(typesSource)?.[1] ?? ''
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)/gm)].map((match) => match[1] as string)
}

describe('the package', () => {
  it('is pinned to one exact version, and that version is the engine that loads', async () => {
    const pinned = ((JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@sqlite.org/sqlite-wasm']) ?? ''
    expect(pinned).toMatch(/^\d+\.\d+\.\d+-build\d+$/)
    expect((require('@sqlite.org/sqlite-wasm/package.json') as { version: string }).version).toBe(pinned)
    await loadTestEngine()
    expect(sqliteEngine().capi.sqlite3_libversion()).toBe(pinned.replace(/-build\d+$/, ''))
  })

  it('starts asynchronously: no route brings it up without an await', async () => {
    const { default: init } = await import('@sqlite.org/sqlite-wasm')
    const wasmBinary = readFileSync(require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'))
    ;(globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-vfs': true, 'opfs-sahpool': true, 'opfs-wl': true } } }
    let instantiatedSynchronously = false
    const started = (init as unknown as (options: object) => Promise<unknown>)({
      wasmBinary,
      instantiateWasm (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), imports)
        instantiatedSynchronously = true
        receive(instance)
        return instance.exports
      }
    })
    expect(started).toBeInstanceOf(Promise)
    expect(instantiatedSynchronously).toBe(true)
    // A synchronous instantiation still returns a Promise: the rest of the start-up
    // is behind `await` inside the package. If this ever fails because init became
    // synchronous, the ready module and its top-level await can go.
    await started
  })

  it('loading twice is the same promise', () => {
    expect(loadSqliteEngine()).toBe(loadSqliteEngine())
  })

  it('does not install the browser storage backends', async () => {
    await loadTestEngine()
    const sqlite3 = sqliteEngine() as unknown as { opfs?: unknown, capi: { sqlite3_vfs_find (name: string): number } }
    expect(sqlite3.opfs).toBeUndefined()
    for (const name of ['opfs', 'opfs-sahpool', 'opfs-wl']) expect(sqlite3.capi.sqlite3_vfs_find(name), name).toBe(0)
  })
})

describe('the names engine-types.ts declares', () => {
  it.each([['SqliteCapi', 'capi'], ['SqliteWasm', 'wasm']] as const)('%s is on the engine\'s %s', async (interfaceName, key) => {
    await loadTestEngine()
    const target = sqliteEngine()[key] as unknown as Record<string, unknown>
    const names = declared(interfaceName)
    expect(names.length).toBeGreaterThan(10)
    for (const name of names) expect(target[name], `${key}.${name}`).toBeDefined()
  })

  it('SqliteExports is on the WebAssembly exports', async () => {
    await loadTestEngine()
    const exports = sqliteEngine().wasm.exports as unknown as Record<string, unknown>
    for (const name of declared('SqliteExports')) expect(typeof exports[name], `exports.${name}`).toBe('function')
  })

  it('the VFS installer is present', async () => {
    await loadTestEngine()
    expect(typeof (sqliteEngine() as Sqlite3).vfs.installVfs).toBe('function')
  })
})
