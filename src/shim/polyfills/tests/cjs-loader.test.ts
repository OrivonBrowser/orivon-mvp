// The run-time require: files in the app's own fs, over the shim's
// readFileSync, evaluated by vm.compileFunction.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { OrivonShimError } from '../../errors.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'
import { registerBuiltin } from '../cjs-builtins.js'
import { createCjsRequire } from '../cjs-loader.js'
import { createRequire } from '../module.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

const files = new Map<string, string>()
const reads: string[] = []

function fail (code: string): Error {
  return Object.assign(new Error(code), { name: 'OrivonError', code: code === 'ENOENT' ? 'notFound' : code === 'EISDIR' ? 'invalid' : 'denied', platformCode: code })
}

beforeEach(() => {
  files.clear()
  reads.length = 0
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readFileSync: (path: string) => {
        reads.push(path)
        if (path.endsWith('.d') || path === 'lib') throw fail('EISDIR')
        const text = files.get(path)
        if (text === undefined) throw fail('ENOENT')
        return new TextEncoder().encode(text)
      }
    }
  } as unknown as Orivon
  for (const key of Object.keys(createCjsRequire(`${VIRTUAL_ROOT}/x.js`).cache)) delete createCjsRequire(`${VIRTUAL_ROOT}/x.js`).cache[key]
})

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
})

const require = (): ReturnType<typeof createCjsRequire> => createCjsRequire(`${VIRTUAL_ROOT}/main.js`)

describe('cjs-loader', () => {
  it('loads a relative file with exports, require, module, __filename and __dirname', () => {
    files.set('lib/a.js', "exports.name = __filename; exports.dir = __dirname; exports.self = module.exports === exports; exports.b = require('./b').value")
    files.set('lib/b.js', 'module.exports = { value: 7 }')
    const a = require()('./lib/a') as { name: string, dir: string, self: boolean, b: number }
    expect(a).toEqual({ name: `${VIRTUAL_ROOT}/lib/a.js`, dir: `${VIRTUAL_ROOT}/lib`, self: true, b: 7 })
  })

  it('tries the exact name, .js, .cjs, .json, then /index.js', () => {
    files.set('exact', 'module.exports = "exact"')
    files.set('one.js', 'module.exports = "js"')
    files.set('two.cjs', 'module.exports = "cjs"')
    files.set('three.json', '{"k": 3}')
    files.set('dir/index.js', 'module.exports = "index"')
    const r = require()
    expect(r('./exact')).toBe('exact')
    expect(r('./one')).toBe('js')
    expect(r('./two')).toBe('cjs')
    expect(r('./three')).toEqual({ k: 3 })
    expect(r('./dir')).toBe('index')
    expect(r('./dir/')).toBe('index')
  })

  it('a directory that shadows the exact name falls through to the next candidate', () => {
    files.set('lib.js', 'module.exports = "file"')
    expect(require()('./lib')).toBe('file')
    expect(reads).toEqual(['lib', 'lib.js'])
  })

  it('resolves an absolute path under the virtual root', () => {
    files.set('abs.js', 'module.exports = 5')
    expect(require()(`${VIRTUAL_ROOT}/abs.js`)).toBe(5)
  })

  it('caches by resolved path: two spellings load once, and deleting the entry reloads', () => {
    files.set('c.js', 'globalThis.__loads = (globalThis.__loads || 0) + 1; module.exports = {}')
    ;(globalThis as { __loads?: number }).__loads = 0
    const r = require()
    expect(r('./c.js')).toBe(r('./sub/../c'))
    expect((globalThis as { __loads?: number }).__loads).toBe(1)
    delete r.cache[`${VIRTUAL_ROOT}/c.js`]
    r('./c.js')
    expect((globalThis as { __loads?: number }).__loads).toBe(2)
  })

  it('a cycle returns the partial exports, as Node does', () => {
    files.set('x.js', "exports.early = 1; const y = require('./y'); exports.late = 2; exports.seenByY = y.sawX")
    files.set('y.js', "const x = require('./x'); exports.sawX = JSON.stringify(x)")
    expect(require()('./x')).toEqual({ early: 1, late: 2, seenByY: '{"early":1}' })
  })

  it('a module that throws is not cached', () => {
    files.set('bad.js', "throw new Error('boom')")
    const r = require()
    expect(() => r('./bad')).toThrow('boom')
    expect(r.cache[`${VIRTUAL_ROOT}/bad.js`]).toBeUndefined()
  })

  it('require.resolve returns the resolved filename or throws MODULE_NOT_FOUND', () => {
    files.set('r.js', '')
    const r = require()
    expect(r.resolve('./r')).toBe(`${VIRTUAL_ROOT}/r.js`)
    expect(() => r.resolve('./nope')).toThrowError(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }) as Error)
    expect(r.resolve('fs')).toBe('fs')
  })

  it('a bare specifier naming a shim builtin returns it, bare or node:-prefixed', async () => {
    const r = require()
    expect(r('path')).toBe((await import('../path.js')).default)
    expect(r('node:path')).toBe(r('path'))
    expect(typeof (r('events') as { EventEmitter: unknown }).EventEmitter).toBe('function')
    expect(typeof (r('util') as { format: unknown }).format).toBe('function')
    expect(typeof (r('async_hooks') as { AsyncResource: unknown }).AsyncResource).toBe('function')
  })

  it('any other bare specifier throws MODULE_NOT_FOUND, saying there is no node_modules resolution', () => {
    files.set('user.js', "try { require('bufferutil') } catch (e) { exports.code = e.code }")
    expect(require()('./user')).toEqual({ code: 'MODULE_NOT_FOUND' })
    expect(() => require()('lodash')).toThrow(/does not search node_modules/)
    expect(() => require()('node:nonesuch')).toThrow(OrivonShimError)
  })

  it('a module\'s require resolves from its own directory, and its stack names its requirers', () => {
    files.set('deep/one.js', "module.exports = require('./two')")
    files.set('deep/two.js', "module.exports = require('missing-pkg')")
    let error: unknown
    try { require()('./deep/one') } catch (caught) { error = caught }
    expect((error as { requireStack: string[] }).requireStack).toEqual([`${VIRTUAL_ROOT}/deep/two.js`, `${VIRTUAL_ROOT}/deep/one.js`, `${VIRTUAL_ROOT}/main.js`])
  })

  it('parses JSON, naming the file on a syntax error', () => {
    files.set('bad.json', '{ nope')
    expect(() => require()('./bad.json')).toThrow(/bad\.json/)
  })

  it('strips a shebang and a byte-order mark', () => {
    files.set('s.js', '﻿#!/usr/bin/env node\nmodule.exports = "ok"')
    expect(require()('./s')).toBe('ok')
  })

  it('passes a denial through rather than reading it as a missing file', () => {
    ;(globalThis as GlobalWithOrivon).orivon = { fs: { readFileSync: () => { throw fail('EACCES') } } } as unknown as Orivon
    expect(() => require()('./anything')).toThrowError(expect.objectContaining({ code: 'denied' }) as Error)
  })

  it('names the CSP when eval is refused', () => {
    files.set('e.js', 'module.exports = 1')
    const original = globalThis.Function
    vi.stubGlobal('Function', function () { throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source") })
    try {
      expect(() => require()('./e')).toThrow(/unsafe-eval/)
      expect(() => require()('./e')).toThrow(OrivonShimError)
    } finally {
      vi.stubGlobal('Function', original)
    }
  })

  it('registerBuiltin adds a module a require returns', () => {
    registerBuiltin('my-builtin', { yes: true })
    expect(require()('my-builtin')).toEqual({ yes: true })
    expect(require()('node:my-builtin')).toEqual({ yes: true })
  })

  it('createRequire delegates to it', () => {
    files.set('sub/m.js', 'module.exports = __dirname')
    const r = createRequire(`${VIRTUAL_ROOT}/main.js`)
    expect(r('./sub/m')).toBe(`${VIRTUAL_ROOT}/sub`)
    expect(createRequire(new URL(`https://app.test${VIRTUAL_ROOT}/main.js`))('./sub/m')).toBe(`${VIRTUAL_ROOT}/sub`)
    expect(() => r('nope-pkg')).toThrowError(expect.objectContaining({ code: 'MODULE_NOT_FOUND' }) as Error)
  })

  it('every ready module-map row is in the require table or named as left out', async () => {
    const { SHIM_MODULE_MAP } = await import('../../module-map.js')
    const { hasBuiltin } = await import('../cjs-builtins.js')
    const leftOut = new Set(['child_process', 'wasi', 'worker_threads', 'module', 'electron'])
    const missing = SHIM_MODULE_MAP.map((row) => row.specifier).filter((name) => !hasBuiltin(name) && !leftOut.has(name))
    expect(missing).toEqual([])
  })
})
