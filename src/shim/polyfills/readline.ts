// `readline` module target (module-map.ts): it loads, so a library that only
// requires it at the top (`read`, which asks for a password on a terminal)
// evaluates; every function names why it refuses. An app has no terminal, and
// line-splitting a stream is a few lines of a caller's own.

import { refuseShim } from '../errors.js'
import { nodeModule } from './module-proxy.js'

export function otherReadlineMember (prop: string): Error {
  return refuseShim(`readline.${prop}`, 'unimplemented',
    `readline.${prop} is not built: an app has no terminal to read lines from or draw a prompt on, and no consumer has needed ` +
    'readline over an ordinary stream yet. See docs/planning/compatibility-matrix.md Table 3.')
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/readline.js'

export default nodeModule('readline', {}, otherReadlineMember)
