// `util` module target (module-map.ts). The `util` package supplies format,
// inspect, types, deprecate, debuglog, callbackify and the legacy isX
// helpers: the parts most costly to get right by hand. This file adds what the
// package gets wrong or predates: a promisify keyed on Node's registry symbol
// (the package's own is a private Symbol no library can set), inherits with
// Node's setPrototypeOf semantics (the package's `inherits` replaces the
// prototype, dropping methods already on it), isDeepStrictEqual, and the
// TextEncoder/TextDecoder Node re-exports. README.md's Design notes has why
// the package is used despite its dependency tree.

import utilPackage from 'util/util.js'
import { isDeepEqual } from './deep-equal.js'
import { nodeModule } from './module-proxy.js'

// Typed as `Function`, matching @types/node's own signature for
// util.inherits -- callers pass an ordinary pre-ES6-class constructor
// function, called both as `new Ctor()` and, by some libraries, plain
// (`Ctor.call(this, ...)`), so a `new (...) => unknown` signature would
// reject calls this shim must accept.

export function inherits (ctor: Function, superCtor: Function): void {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The "ctor" argument must be of type function')
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The "superCtor" argument must be of type function')
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The "superCtor.prototype" property must be of type object')
  }

  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true })
  Object.setPrototypeOf(ctor.prototype as object, superCtor.prototype as object)
}

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')

type Callback = (error: unknown, ...values: unknown[]) => void

function notAFunction (name: string, value: unknown): TypeError & { code: string } {
  return Object.assign(new TypeError(`The "${name}" argument must be of type function. Received ${typeof value}`), { code: 'ERR_INVALID_ARG_TYPE' })
}

/** Node's util.promisify: the callback's first value resolves the promise; a function carrying a custom form under the registry symbol gets that form back. */
export function promisify<T extends Function> (original: T): (...args: unknown[]) => Promise<unknown> {
  if (typeof original !== 'function') throw notAFunction('original', original)
  const custom = (original as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM]
  if (custom !== undefined) {
    if (typeof custom !== 'function') throw notAFunction('util.promisify.custom', custom)
    return custom as (...args: unknown[]) => Promise<unknown>
  }
  function promisified (this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const callback: Callback = (error, ...values) => { if (error !== null && error !== undefined) reject(error); else resolve(values[0]) }
      Reflect.apply(original, this, [...args, callback])
    })
  }
  Object.setPrototypeOf(promisified, Object.getPrototypeOf(original) as object)
  Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original))
  ;(promisified as unknown as Record<symbol, unknown>)[PROMISIFY_CUSTOM] = promisified
  return promisified
}
promisify.custom = PROMISIFY_CUSTOM

export function isDeepStrictEqual (a: unknown, b: unknown): boolean { return isDeepEqual(a, b, true) }

export const TextEncoder = globalThis.TextEncoder
export const TextDecoder = globalThis.TextDecoder
export const callbackify = utilPackage.callbackify
export const debuglog = utilPackage.debuglog
export const deprecate = utilPackage.deprecate
export const format = utilPackage.format
export const inspect = utilPackage.inspect
export const types = nodeModule('util.types', utilPackage.types)

export default nodeModule('util', {
  ...utilPackage,
  types,
  inherits,
  promisify,
  isDeepStrictEqual,
  TextEncoder,
  TextDecoder
})
