// `vm` module target (module-map.ts): code run in the page's own context, as
// an indirect eval and `new Function` run it, which an app's served CSP
// admits ('unsafe-eval'). A context of its own would need a second realm, so
// every call that makes or enters one refuses by name.

import { refuseShim } from '../errors.js'
import { nodeModule } from './module-proxy.js'

const indirectEval = globalThis.eval

function noContext (api: string): Error {
  return refuseShim(`vm.${api}`, 'unimplemented',
    `vm.${api} runs code in a context of its own, which needs a second JavaScript realm; ` +
    'vm.runInThisContext and vm.compileFunction run in the page\'s own context')
}

export function runInThisContext (code: string): unknown {
  return indirectEval(String(code))
}

export function compileFunction (code: string, params: readonly string[] = [], options: { contextExtensions?: readonly unknown[], parsingContext?: unknown } = {}): (...args: unknown[]) => unknown {
  if ((options.contextExtensions?.length ?? 0) > 0 || options.parsingContext !== undefined) throw noContext('compileFunction with a context')
  return new Function(...params.map(String), String(code)) as (...args: unknown[]) => unknown
}

export function isContext (_object: unknown): boolean {
  return false
}

export class Script {
  readonly #code: string

  constructor (code: string) {
    this.#code = String(code)
  }

  runInThisContext (): unknown {
    return runInThisContext(this.#code)
  }

  runInContext (): never { throw noContext('Script.runInContext') }
  runInNewContext (): never { throw noContext('Script.runInNewContext') }
  createCachedData (): never { throw refuseShim('vm.Script.createCachedData', 'not-applicable', 'V8 code caches are not exposed to a page') }
}

export function createContext (): never { throw noContext('createContext') }
export function runInContext (): never { throw noContext('runInContext') }
export function runInNewContext (): never { throw noContext('runInNewContext') }

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/vm.js'

export default nodeModule('vm', { runInThisContext, compileFunction, isContext, Script, createContext, runInContext, runInNewContext })
