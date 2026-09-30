// A CommonJS loader for files in the app's own fs, behind `createRequire` and
// the `require` a forked child gets. Only a relative or absolute path loads,
// or a builtin by name: there is no node_modules resolution, since a bundle
// resolves its packages when it is built. Files are read with the shim's
// readFileSync and evaluated by vm.compileFunction, which needs the served
// CSP's 'unsafe-eval' (the same CSP a page and a child host carry).

import { dirname, resolve } from 'path'
import { refuseShim } from '../errors.js'
import { readFileSync } from '../fs/fs.js'
import { hasBuiltin, loadBuiltin } from './cjs-builtins.js'
import { compileFunction } from './vm.js'

export interface CjsModule {
  id: string
  filename: string
  path: string
  exports: unknown
  loaded: boolean
  children: CjsModule[]
  paths: string[]
  parent: CjsModule | undefined
  require: CjsRequire
}

export interface CjsRequire {
  (id: string): unknown
  resolve: (id: string) => string
  cache: Record<string, CjsModule | undefined>
  main: CjsModule | undefined
}

const SUFFIXES = ['', '.js', '.cjs', '.json', '/index.js'] as const
const MISSING = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

/** Node's one cache, shared by every require: deleting an entry makes the next require read the file again. */
const cache: Record<string, CjsModule | undefined> = Object.create(null)

function notFound (id: string, requireStack: string[], why = ''): Error {
  const stack = requireStack.length > 0 ? `\nRequire stack:\n${requireStack.map((entry) => `- ${entry}`).join('\n')}` : ''
  return Object.assign(new Error(`Cannot find module '${id}'${stack}${why}`), { code: 'MODULE_NOT_FOUND', requireStack })
}

/** The file's text, or undefined when nothing readable is there. A denial or any other failure is not "missing". */
function tryRead (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8') as string
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== undefined && MISSING.has(code)) return undefined
    throw error
  }
}

interface Found { readonly filename: string, readonly source: string }

function locate (id: string, base: string, requireStack: string[]): Found {
  const absolute = resolve(base, id)
  const bare = absolute.replace(/\/+$/, '')
  for (const suffix of SUFFIXES) {
    const filename = `${bare}${suffix}`
    const source = tryRead(filename)
    if (source !== undefined) return { filename, source }
  }
  throw notFound(id, requireStack)
}

function isPath (id: string): boolean {
  return id === '.' || id === '..' || id.startsWith('./') || id.startsWith('../') || id.startsWith('/')
}

function bareRefusal (id: string, requireStack: string[]): Error {
  return notFound(id, requireStack,
    "\nThe shim's require loads a relative or absolute path, or a shim builtin by name, and does not search node_modules: bundle the package into the app instead.")
}

function evaluate (mod: CjsModule, source: string): void {
  if (mod.filename.endsWith('.json')) {
    try {
      mod.exports = JSON.parse(source.replace(/^﻿/, ''))
    } catch (error) {
      throw Object.assign(error as Error, { message: `${mod.filename}: ${(error as Error).message}` })
    }
    return
  }
  const text = source.replace(/^﻿/, '').replace(/^#!/, '//')
  let wrapper: (...args: unknown[]) => unknown
  try {
    wrapper = compileFunction(`${text}\n//# sourceURL=file://${mod.filename}`, ['exports', 'require', 'module', '__filename', '__dirname'])
  } catch (error) {
    if (error instanceof EvalError) {
      throw refuseShim('module.require', 'not-applicable',
        `require('${mod.filename}') evaluates the file, which the served Content-Security-Policy refuses without 'unsafe-eval' (${(error as Error).message})`)
    }
    throw error
  }
  wrapper.call(mod.exports, mod.exports, mod.require, mod, mod.filename, dirname(mod.filename))
}

function makeRequire (parent: CjsModule | undefined, base: string, from: string): CjsRequire {
  const requireStack = (): string[] => {
    const stack: string[] = []
    for (let at = parent; at !== undefined; at = at.parent) stack.push(at.filename)
    return stack.length > 0 ? stack : [from]
  }
  const load = (id: string): unknown => {
    if (typeof id !== 'string' || id === '') {
      throw Object.assign(new TypeError(`The argument 'id' must be a non-empty string. Received ${String(id)}`), { code: 'ERR_INVALID_ARG_VALUE' })
    }
    if (id.startsWith('node:')) {
      if (hasBuiltin(id)) return loadBuiltin(id)
      throw refuseShim(`require('${id}')`, 'unimplemented', `${id} is not a builtin the shim's require returns`)
    }
    if (!isPath(id)) {
      if (hasBuiltin(id)) return loadBuiltin(id)
      throw bareRefusal(id, requireStack())
    }
    const { filename, source } = locate(id, base, requireStack())
    const cached = cache[filename]
    if (cached !== undefined) return cached.exports
    const mod: CjsModule = { id: filename, filename, path: dirname(filename), exports: {}, loaded: false, children: [], paths: [], parent, require: undefined as unknown as CjsRequire }
    mod.require = makeRequire(mod, mod.path, filename)
    parent?.children.push(mod)
    cache[filename] = mod
    try {
      evaluate(mod, source)
    } catch (error) {
      delete cache[filename]
      throw error
    }
    mod.loaded = true
    return mod.exports
  }
  const require = load as CjsRequire
  require.resolve = (id: string): string => {
    if (hasBuiltin(id.replace(/^node:/, ''))) return id
    if (!isPath(id)) throw bareRefusal(id, requireStack())
    return locate(id, base, requireStack()).filename
  }
  require.cache = cache
  require.main = parent === undefined ? undefined : mainOf(parent)
  return require
}

function mainOf (mod: CjsModule): CjsModule {
  let at = mod
  while (at.parent !== undefined) at = at.parent
  return at
}

/** A `require` for code at `filename`: relative paths resolve from its directory (a trailing slash names a directory). */
export function createCjsRequire (filename: string): CjsRequire {
  const base = filename.endsWith('/') ? filename : dirname(filename)
  const entry: CjsModule = { id: '.', filename, path: base, exports: {}, loaded: true, children: [], paths: [], parent: undefined, require: undefined as unknown as CjsRequire }
  entry.require = makeRequire(entry, base, filename)
  entry.require.main = entry
  return entry.require
}
