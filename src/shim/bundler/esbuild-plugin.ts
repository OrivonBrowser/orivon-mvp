// The esbuild plugin a port bundles its app with, so `import 'fs'` or
// `require('net')` resolves to this shim. Loaded from another repository
// under Node's type stripping: erasable TypeScript only, node: imports only,
// and the alias table read as JSON beside this file (README.md).

import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OnResolveArgs, OnResolveResult, Plugin, PluginBuild } from 'esbuild'

interface AliasTable {
  readonly virtualRoot: string
  readonly entries: readonly { readonly specifier: string, readonly kind: 'local' | 'package', readonly implementation: string }[]
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SHIM_DIR = fileURLToPath(new URL('../', import.meta.url))
const CHECKOUT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TABLE: AliasTable = JSON.parse(readFileSync(`${HERE}alias-table.generated.json`, 'utf8'))

/** The directory every Node-shaped path in an app agrees on (virtual-root.ts). */
export const virtualRoot: string = TABLE.virtualRoot

const NODE_BUILTINS = new Set(builtinModules)
const NODE_MODULES_DIR = `${CHECKOUT_ROOT}node_modules${sep}`
const EMPTY_MODULE = `${HERE}empty.js`
const PACKAGE_RESOLVE_MARK = 'orivon-shim-package-resolve'

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

/**
 * The shim's own dependencies (crypto-browserify and what it stands on) keep a Node entry point
 * that requires the very builtin they implement, so their `browser` field must be honoured
 * even when the port builds for `platform: 'node'`. esbuild applies that field only for
 * `platform: 'browser'`, so it is applied here, for those files only.
 */
async function resolveBrowserField (build: PluginBuild, args: OnResolveArgs): Promise<OnResolveResult | undefined> {
  const options = { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: PACKAGE_RESOLVE_MARK }
  let request = args.path
  const from = packageOf(args.importer)
  if (from !== undefined) {
    const key = request.startsWith('.') ? resolve(dirname(args.importer), request) : request
    const rule = browserRule(from, key)
    if (rule === false) return { path: EMPTY_MODULE }
    if (rule !== undefined) request = rule
  }
  if (request === args.path && (request.startsWith('node:') || NODE_BUILTINS.has(request))) return undefined
  const found = await build.resolve(request, options)
  if (found.errors.length > 0 || found.external || !isShimTree(found.path)) return found.errors.length > 0 ? { errors: found.errors } : undefined
  const target = packageOf(found.path)
  const rule = target === undefined ? undefined : browserRule(target, found.path)
  if (rule === false) return { path: EMPTY_MODULE }
  if (typeof rule === 'string') {
    const mapped = await build.resolve(rule, { ...options, resolveDir: target?.dir ?? args.resolveDir })
    return mapped.errors.length > 0 ? { errors: mapped.errors } : { path: mapped.path }
  }
  return { path: found.path }
}

/** onResolve only, so a port can register its own onLoad. Matches each ready
 * module-map.ts row whole: an alias by prefix would also capture subpaths and
 * send the shim's own imports (`util/util.js`) back into the shim. */
export function orivonShimPlugin (): Plugin {
  return {
    name: 'orivon-shim',
    setup (build) {
      const specifiers = new Set(TABLE.entries.map((entry) => entry.specifier))
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === PACKAGE_RESOLVE_MARK || !isShimTree(args.importer)) return undefined
        return await resolveBrowserField(build, args)
      })
      for (const entry of TABLE.entries) {
        const escaped = entry.specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
        build.onResolve({ filter: new RegExp(`^(?:node:)?${escaped}$`) }, async (args) => {
          // A package row's own inner resolve passes back through here.
          if (args.pluginData === PACKAGE_RESOLVE_MARK) return undefined
          if (entry.kind === 'local') return { path: join(SHIM_DIR, entry.implementation.replace(/\.js$/, '.ts')) }
          const resolved = await build.resolve(packageRequest(entry.implementation), { kind: args.kind, resolveDir: CHECKOUT_ROOT, pluginData: PACKAGE_RESOLVE_MARK })
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path }
        })
      }
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
