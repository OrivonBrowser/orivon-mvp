// The esbuild plugin a port bundles its app with, so `import 'fs'` or
// `require('net')` resolves to this shim. Loaded from another repository
// under Node's type stripping: erasable TypeScript only, node: imports only,
// and the alias table read as JSON beside this file (README.md).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OnResolveArgs, OnResolveResult, Plugin, PluginBuild } from 'esbuild'

interface AliasTable {
  readonly virtualRoot: string
  readonly entries: readonly { readonly specifier: string, readonly kind: 'local' | 'package', readonly implementation: string, readonly prefixOnly?: boolean }[]
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SHIM_DIR = fileURLToPath(new URL('../', import.meta.url))
const CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TABLE: AliasTable = JSON.parse(readFileSync(`${HERE}alias-table.generated.json`, 'utf8'))

/** The directory every Node-shaped path in an app agrees on (virtual-root.ts). */
export const virtualRoot: string = TABLE.virtualRoot

const NODE_BUILTINS = new Set(builtinModules)
const NODE_MODULES_DIR = `${CHECKOUT_ROOT}node_modules${sep}`
const EMPTY_MODULE = `${HERE}empty.cjs`
const PACKAGE_RESOLVE_MARK = 'orivon-shim-package-resolve'
const REQUIRE_NAMESPACE = 'orivon-shim-require'

/** The SQLite engine's browser build: the package's `node` export condition names a build that reads the disk with Node's own `fs`. */
const SQLITE_ENGINE = `${NODE_MODULES_DIR}@sqlite.org${sep}sqlite-wasm${sep}dist${sep}index.mjs`
const SQLITE_WASM = `${NODE_MODULES_DIR}@sqlite.org${sep}sqlite-wasm${sep}dist${sep}sqlite3.wasm`

/** Specifiers a port imports by a name of the shim's own choosing. */
const SHIM_SUBPATHS: Readonly<Record<string, string>> = {
  'orivon-node-shim/sqlite-ready': join(SHIM_DIR, 'sqlite', 'ready.ts')
}

/** Files a port copies next to its bundle: the engine fetches `sqlite3.wasm` relative to the module that holds its code. */
export function shimAssets (): readonly { readonly name: string, readonly path: string }[] {
  return [{ name: 'sqlite3.wasm', path: SQLITE_WASM }]
}

/** Node's own escape for an npm package named like a builtin: `events/` is the package. */
function packageRequest (name: string): string {
  return NODE_BUILTINS.has(name) ? `${name}/` : name
}

type BrowserEntries = readonly (readonly [string, string | false])[]
interface PackageInfo { readonly dir: string, readonly main: string, readonly browser: BrowserEntries }
const packages = new Map<string, PackageInfo | undefined>()

/** The package a file belongs to: its nearest package.json below the checkout's node_modules. */
function packageOf (file: string): PackageInfo | undefined {
  let dir = dirname(file)
  const visited: string[] = []
  for (;;) {
    const known = packages.get(dir)
    if (known !== undefined || packages.has(dir)) return known
    visited.push(dir)
    if (existsSync(join(dir, 'package.json'))) {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const main: string = typeof json.main === 'string' ? json.main : 'index.js'
      const field = json.browser
      const browser: BrowserEntries = typeof field === 'string' ? [[main, field]] : (typeof field === 'object' && field !== null ? Object.entries(field) : [])
      const info: PackageInfo = { dir, main, browser }
      for (const seen of visited) packages.set(seen, info)
      return info
    }
    const parent = dirname(dir)
    if (parent === dir || !dir.startsWith(CHECKOUT_ROOT)) {
      for (const seen of visited) packages.set(seen, undefined)
      return undefined
    }
    dir = parent
  }
}

/** The file forms a package.json path names: as written, with an extension, or as a directory index. */
function forms (path: string): string[] {
  return [path, `${path}.js`, `${path}.json`, join(path, 'index.js')]
}

/** What a package's `browser` field says about `wanted`: another file, `false` for empty, or undefined. */
function browserRule (info: PackageInfo, wanted: string): string | false | undefined {
  for (const [key, value] of info.browser) {
    if (key.startsWith('.') || !key.includes('/') && key === info.main) {
      if (forms(resolve(info.dir, key)).includes(wanted)) return value === false ? false : resolve(info.dir, value)
    } else if (key === wanted) {
      return value === false ? false : (value.startsWith('.') ? resolve(info.dir, value) : value)
    }
  }
  return undefined
}

let shimPackageDirs: Set<string> | undefined

/** The directory of `name` as a package installed for `fromDir`, found the way Node walks node_modules. */
function installedAt (name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; `${dir}${sep}`.startsWith(CHECKOUT_ROOT); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) break
  }
  return undefined
}

/** Every package this checkout's `dependencies` reach, transitively: what the shim stands on, and never a devDependency. */
function shimPackages (): Set<string> {
  if (shimPackageDirs !== undefined) return shimPackageDirs
  const seen = new Set<string>()
  const visit = (json: { dependencies?: Record<string, string> }, dir: string): void => {
    for (const name of Object.keys(json.dependencies ?? {})) {
      const found = installedAt(name, dir)
      if (found === undefined || seen.has(found)) continue
      seen.add(found)
      visit(JSON.parse(readFileSync(join(found, 'package.json'), 'utf8')), found)
    }
  }
  visit(JSON.parse(readFileSync(join(CHECKOUT_ROOT, 'package.json'), 'utf8')), CHECKOUT_ROOT)
  shimPackageDirs = seen
  return seen
}

/**
 * True for a file of the shim or of a package the shim depends on: those run in a page, so a
 * package's `browser` field applies to them. A devDependency of this checkout does not.
 */
function isShimTree (file: string): boolean {
  if (file.startsWith(SHIM_DIR)) return true
  if (!file.startsWith(NODE_MODULES_DIR)) return false
  const owner = packageOf(file)
  return owner !== undefined && shimPackages().has(owner.dir)
}

/** The package name in a bare specifier: `name`, `name/sub`, `@scope/name` or `@scope/name/sub`. */
function packageName (specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
}

/**
 * The shim's own dependencies (crypto-browserify and what it stands on) keep a Node entry point
 * that requires the very builtin they implement, so their `browser` field must be honoured
 * even when the port builds for `platform: 'node'`. esbuild applies that field only for
 * `platform: 'browser'`, so it is applied here, for those files only.
 */
function resolveFile (absolute: string): string | undefined {
  return forms(absolute).find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

/** A package's directory, and its `main` file, when it can be found without asking esbuild: no `exports` map to follow. */
function locateInstalled (specifier: string, importerDir: string): { info: PackageInfo, file: string | undefined } | undefined {
  const dir = installedAt(packageName(specifier), importerDir)
  if (dir === undefined) return undefined
  const info = packageOf(join(dir, 'package.json'))
  if (info === undefined) return undefined
  const subpath = specifier.slice(packageName(specifier).length + 1)
  if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports !== undefined) return { info, file: undefined }
  return { info, file: resolveFile(resolve(dir, subpath === '' ? info.main : subpath)) }
}

async function resolveBrowserField (build: PluginBuild, args: OnResolveArgs): Promise<OnResolveResult | undefined> {
  const from = packageOf(args.importer)
  const isRelative = args.path.startsWith('.') || args.path.startsWith('/')
  let request = args.path
  if (from !== undefined && from.browser.length > 0) {
    const rule = browserRule(from, isRelative ? resolve(dirname(args.importer), request) : request)
    const wanted = isRelative ? resolveFile(resolve(dirname(args.importer), request)) : undefined
    const byFile = wanted === undefined ? undefined : browserRule(from, wanted)
    const found = rule ?? byFile
    if (found === false) return { path: EMPTY_MODULE }
    if (found !== undefined) request = found
  }
  if (request !== args.path) {
    const mapped = isAbsolutePath(request) ? resolveFile(request) : undefined
    if (mapped !== undefined) return { path: mapped }
    return await nestedResolve(build, request, args)
  }
  if (request.startsWith('node:') || NODE_BUILTINS.has(request)) return undefined
  // What the imported file is, and what its own package's `browser` field says about it.
  let target: { info: PackageInfo, file: string | undefined } | undefined
  if (isRelative) {
    const file = resolveFile(resolve(dirname(args.importer), request))
    target = from === undefined || file === undefined ? undefined : { info: from, file }
  } else {
    target = locateInstalled(request, dirname(args.importer))
    if (target !== undefined && target.file === undefined && target.info.browser.length > 0) return await viaEsbuild(build, args)
  }
  if (target?.file === undefined) return undefined
  const rule = browserRule(target.info, target.file)
  if (rule === undefined) return undefined
  if (rule === false) return { path: EMPTY_MODULE }
  const mapped = resolveFile(rule)
  return mapped === undefined ? undefined : { path: mapped }
}

function isAbsolutePath (path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

/** The slow route: asks esbuild where `request` goes, then applies the imported package's `browser` field to the answer. */
async function nestedResolve (build: PluginBuild, request: string, args: OnResolveArgs): Promise<OnResolveResult | undefined> {
  const options = { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: PACKAGE_RESOLVE_MARK }
  const found = await build.resolve(request, options)
  if (found.errors.length > 0) return { errors: found.errors }
  if (found.external || !isShimTree(found.path)) return { path: found.path }
  const owner = packageOf(found.path)
  const rule = owner === undefined ? undefined : browserRule(owner, found.path)
  if (rule === false) return { path: EMPTY_MODULE }
  if (typeof rule === 'string') {
    const mapped = resolveFile(rule)
    if (mapped !== undefined) return { path: mapped }
  }
  return { path: found.path }
}

async function viaEsbuild (build: PluginBuild, args: OnResolveArgs): Promise<OnResolveResult | undefined> {
  return await nestedResolve(build, args.path, args)
}

export function orivonShimPlugin (): Plugin {
  return {
    name: 'orivon-shim',
    setup (build) {
      const specifiers = new Set(TABLE.entries.map((entry) => entry.specifier))
      const packageRows: Record<string, Promise<Awaited<ReturnType<PluginBuild['resolve']>>>> = {}
      build.onResolve({ filter: /^(orivon-node-shim\/sqlite-ready|@sqlite\.org\/sqlite-wasm)$/ }, (args) => {
        const shimPath = SHIM_SUBPATHS[args.path]
        return { path: shimPath ?? SQLITE_ENGINE }
      })
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === PACKAGE_RESOLVE_MARK || !isShimTree(args.importer)) return undefined
        return await resolveBrowserField(build, args)
      })
      for (const entry of TABLE.entries) {
        const escaped = entry.specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
        build.onResolve({ filter: new RegExp(entry.prefixOnly === true ? `^node:${escaped}$` : `^(?:node:)?${escaped}$`) }, async (args) => {
          // A package row's own inner resolve passes back through here.
          if (args.pluginData === PACKAGE_RESOLVE_MARK) return undefined
          if (entry.kind === 'local') {
            const path = join(SHIM_DIR, entry.implementation.replace(/\.js$/, '.ts'))
            // A CommonJS `require('assert')` is the function itself in Node: esbuild would hand it the ES module's namespace.
            return args.kind === 'require-call' ? { path, namespace: REQUIRE_NAMESPACE } : { path }
          }
          packageRows[entry.specifier] ??= build.resolve(packageRequest(entry.implementation), { kind: args.kind, resolveDir: CHECKOUT_ROOT, pluginData: PACKAGE_RESOLVE_MARK })
          const resolved = await packageRows[entry.specifier]!
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path }
        })
      }
      build.onLoad({ filter: /.*/, namespace: REQUIRE_NAMESPACE }, (args) => ({
        contents: `import * as namespace from ${JSON.stringify(args.path)}\nmodule.exports = typeof namespace.default === 'function' ? namespace.default : Object.defineProperty({ ...namespace }, '__esModule', { value: true })\n`,
        loader: 'js',
        resolveDir: SHIM_DIR
      }))
      build.onResolve({ filter: /^(?:node:|[a-z_])/ }, (args) => {
        if (args.pluginData === PACKAGE_RESOLVE_MARK) return undefined
        const bare = args.path.replace(/^node:/, '')
        if (specifiers.has(bare) || !(args.path.startsWith('node:') || NODE_BUILTINS.has(args.path))) return undefined
        return {
          errors: [{
            text: `'${args.path}' is a Node builtin the Orivon shim has no module for (imported from ${args.importer === '' ? 'the entry point' : args.importer}); see src/shim/module-map.ts`
          }]
        }
      })
    }
  }
}
