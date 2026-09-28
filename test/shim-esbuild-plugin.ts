// Bundles an e2e fixture app's own script against src/shim/ the way a real
// app's bundler would, for the suites that serve such a script.

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type esbuild from 'esbuild'
import { aliasPattern, buildAliasEntries } from '../src/shim/module-map.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** electron.vite.config.ts's own renderer alias, generated from the SAME
 * table (src/shim/module-map.ts) and matched the SAME way (aliasPattern:
 * the whole specifier, bare or `node:`-prefixed) -- so a shim dependency
 * added there is picked up here automatically (code-guidelines.md Rule 3).
 * A plugin, not esbuild's `alias` option: that option also captures every
 * subpath, so the shim's own `import 'util/util.js'` would be rewritten into
 * the shim itself. A 'local' entry's on-disk file is '.ts'; its import
 * specifier is written '.js' (NodeNext-style), the same swap
 * electron.vite.config.ts documents. */
const SHIM_ALIAS_INNER = Symbol('orivon-shim-alias-inner')

export function shimEsbuildPlugin (): esbuild.Plugin {
  return {
    name: 'orivon-shim-alias',
    setup (build) {
      for (const entry of buildAliasEntries()) {
        build.onResolve({ filter: aliasPattern(entry.specifier) }, async (args) => {
          // A package row's target (`events` -> `events`) resolves through
          // this same filter; the marker lets that inner resolve fall through.
          if (args.pluginData === SHIM_ALIAS_INNER) return undefined
          if (entry.kind === 'local') return { path: join(REPO_ROOT, 'src/shim', entry.implementation.replace(/\.js$/, '.ts')) }
          const resolved = await build.resolve(entry.implementation, { kind: args.kind, resolveDir: REPO_ROOT, pluginData: SHIM_ALIAS_INNER })
          return resolved.errors.length > 0 ? { errors: resolved.errors } : { path: resolved.path }
        })
      }
    }
  }
}
