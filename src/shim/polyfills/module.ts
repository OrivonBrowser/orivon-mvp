// `module` module target: createRequire, for the one dynamic require a
// browser bundle can still serve at run time, a native addon by its `.node`
// path (../addon/). Anything else a bundle resolves when it is built.

import { dirname, resolve } from 'path'
import { loadAddon } from '../addon/index.js'
import { refuseShim } from '../errors.js'
import { SHIM_MODULE_MAP } from '../module-map.js'
import { nodeModule } from './module-proxy.js'

export const builtinModules: readonly string[] = [...new Set(SHIM_MODULE_MAP.map((entry) => entry.specifier))]

export function isBuiltin (name: string): boolean {
  return builtinModules.includes(name.replace(/^node:/, ''))
}

type ShimRequire = ((id: string) => unknown) & { resolve: (id: string) => string, cache: Record<string, unknown> }

export function createRequire (filename: string | URL): ShimRequire {
  const from = (typeof filename === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(filename)) ? filename : new URL(filename).pathname
  const base = from.endsWith('/') ? from : dirname(from)
  const resolvePath = (id: string): string => id.startsWith('.') || id.startsWith('/') ? resolve(base, id) : id
  const require = ((id: string): unknown => {
    if (id.endsWith('.node')) return loadAddon(resolvePath(id))
    throw refuseShim('module.createRequire', 'not-applicable',
      `require('${id}') at run time: a browser bundle resolves its modules when it is built, so import it instead; only a native addon's .node path is loaded here`)
  }) as ShimRequire
  require.resolve = resolvePath
  require.cache = {}
  return require
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/module.js'

export default nodeModule('module', { createRequire, builtinModules, isBuiltin })
