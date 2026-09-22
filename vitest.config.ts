import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Alias } from 'vite'
import { defineConfig } from 'vitest/config'
import { aliasPattern, buildAliasEntries } from './src/shim/module-map.js'

const root = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const SHIM_SOURCE_DIRS = [`${root}/src/shim/`, `${root}/src/shim-electron/`]

/** A shim module itself, never a test or its support files: those drive real `node:*` servers and disks. */
function isShimSource (importer: string | undefined): boolean {
  if (importer === undefined) return false
  const path = importer.replace(/\\/g, '/')
  return SHIM_SOURCE_DIRS.some((dir) => path.startsWith(dir)) && !path.includes('/tests/')
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
        if (!isShimSource(importer)) return null
        return await this.resolve(target, importer, { ...options, skipSelf: true })
      }
    }
  })
}

// Node environment only. The MVP's unit tests cover security-critical pure
// functions -- capability checks, path traversal, origin derivation, key
// derivation, the update decision table, telemetry accounting (build-plan.md
// SS Testing). None of those need a DOM, and no UI tests are planned.
export default defineConfig({
  resolve: { alias: shimModuleAliases() },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'spike/**']
  }
})
