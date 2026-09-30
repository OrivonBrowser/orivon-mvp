// The esbuild plugin a port bundles its app with, so `import 'fs'` or
// `require('net')` resolves to this shim. Loaded from another repository
// under Node's type stripping: erasable TypeScript only, node: imports only,
// and the alias table read as JSON beside this file (README.md).

import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'esbuild'

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
const PACKAGE_RESOLVE_MARK = 'orivon-shim-package-resolve'

/** Node's own escape for an npm package named like a builtin: `events/` is the package. */
function packageRequest (name: string): string {
  return NODE_BUILTINS.has(name) ? `${name}/` : name
}

function matches (specifier: string, path: string): boolean {
  return path === specifier || path === `node:${specifier}`
}

/** onResolve only, so a port can register its own onLoad. Matches each ready
 * module-map.ts row whole: an alias by prefix would also capture subpaths and
 * send the shim's own imports (`util/util.js`) back into the shim. */
export function orivonShimPlugin (): Plugin {
  return {
    name: 'orivon-shim',
    setup (build) {
      const specifiers = new Set(TABLE.entries.map((entry) => entry.specifier))
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
