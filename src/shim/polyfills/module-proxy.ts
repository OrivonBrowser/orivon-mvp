// The wrapper every module target here that stands on a polyfill package or
// is hand-written puts around its default export, so a member it lacks
// refuses by name when called (A135) instead of being a bare
// `undefined is not a function`. See README.md's Design notes on refusingProxy.

import { refuseShim } from '../errors.js'
import { refusingProxy } from '../unimplemented.js'

export function nodeModule<T extends object> (name: string, known: T): T {
  return refusingProxy(known, (prop) => refuseShim(
    `${name}.${prop}`, 'unimplemented',
    `${name}.${prop} is real Node ${name} surface this shim has not implemented and has not ` +
    'decided whether it will. See docs/planning/compatibility-matrix.md Table 3.'
  ))
}
