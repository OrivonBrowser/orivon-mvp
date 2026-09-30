// `module` module target: createRequire, which loads a native addon by its
// `.node` path (../addon/) and any other file or builtin through cjs-loader.ts.

import { dirname, resolve } from 'path'
import { loadAddon } from '../addon/index.js'
import { SHIM_MODULE_MAP } from '../module-map.js'
import { registerBuiltin } from './cjs-builtins.js'
import { createCjsRequire } from './cjs-loader.js'
import { nodeModule } from './module-proxy.js'

export const builtinModules: readonly string[] = [...new Set(SHIM_MODULE_MAP.map((entry) => entry.prefixOnly === true ? `node:${entry.specifier}` : entry.specifier))]

export function isBuiltin (name: string): boolean {
  return builtinModules.includes(name) || builtinModules.includes(name.replace(/^node:/, ''))
}

type ShimRequire = ReturnType<typeof createCjsRequire>

export function createRequire (filename: string | URL): ShimRequire {
  const from = (typeof filename === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(filename)) ? filename : new URL(filename).pathname
  const base = from.endsWith('/') ? from : dirname(from)
  const files = createCjsRequire(from)
  const addonPath = (id: string): string => id.startsWith('.') || id.startsWith('/') ? resolve(base, id) : id
  const require = ((id: string): unknown => {
    if (typeof id === 'string' && id.endsWith('.node')) return loadAddon(addonPath(id))
    return files(id)
  }) as ShimRequire
  require.resolve = (id: string): string => id.endsWith('.node') ? addonPath(id) : files.resolve(id)
  require.cache = files.cache
  require.main = files.main
  return require
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/module.js'

const moduleExports = nodeModule('module', { createRequire, builtinModules, isBuiltin })
registerBuiltin('module', moduleExports)

export default moduleExports
