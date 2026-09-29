import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Alias } from 'vite'
import { defineConfig } from 'vitest/config'
import { aliasPattern, buildAliasEntries } from './src/shim/module-map.js'
import { isShimSource } from './src/shim/is-shim-source.js'

const root = dirname(fileURLToPath(import.meta.url))
const SHIM_SOURCE_DIRS = ['src/shim/', 'src/shim-electron/']

/** A shim module itself, never a test or its support files: those drive real `node:*` servers
 * and disks. electron.vite.config.ts's `isShimImporter` applies the identical rule for the
 * preload build; both share `isShimSource`'s implementation. */
function isShimImporter (importer: string | undefined): boolean {
  return isShimSource(root, importer, SHIM_SOURCE_DIRS)
}

/**
 * A shim module's own `stream`/`buffer`/`events`/... import resolves to what
 * the renderer build aliases it to (src/shim/module-map.ts), not to Node's
 * builtin; every other importer keeps Node's. Without it a shim test runs
 * against `node:stream`, whose defaults readable-stream 3 does not share, and
 * a bug the page would hit passes here.
 *
 * An alias with a `customResolver`, not a plugin `resolveId`: Vitest settles
 * a bare builtin before plugin hooks run, and only the alias stage sees it.
 */
function shimModuleAliases (): Alias[] {
  return buildAliasEntries().map(({ specifier, kind, implementation }) => {
    const target = kind === 'package' ? implementation : resolve(root, 'src/shim', implementation)
    return {
      find: aliasPattern(specifier),
      replacement: '$&',
      async customResolver (_source, importer, options) {
        if (!isShimImporter(importer)) return null
        return await this.resolve(target, importer, { ...options, skipSelf: true })
      }
    }
  })
}

// Node, not a DOM: the unit suite tests pure functions and needs no browser.
export default defineConfig({
  resolve: { alias: shimModuleAliases() },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'spike/**']
  }
})
