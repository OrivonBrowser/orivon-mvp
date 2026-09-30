// The wrapper every module target here that stands on a polyfill package or
// is hand-written puts around its default export, so a member it lacks
// refuses by name when called (A135) instead of being a bare
// `undefined is not a function`. See README.md's Design notes on refusingProxy.

import { refuseShim } from '../errors.js'
import { refusingProxy } from '../unimplemented.js'

/** The one reason `nodeModule` gives for every member it wraps generically -- exported so a member's GENERATED named-export stand-in (A287, generated/*.ts) throws the identical error a bundler's default-export interop already would, instead of a second, driftable copy of this wording. */
export function nodeModuleRefusal (name: string, prop: string): ReturnType<typeof refuseShim> {
  return refuseShim(
    `${name}.${prop}`, 'unimplemented',
    `${name}.${prop} is real Node ${name} surface this shim has not implemented and has not ` +
    'decided whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  )
}

export function nodeModule<T extends object> (name: string, known: T): T {
  return refusingProxy(known, (prop) => nodeModuleRefusal(name, prop))
}
