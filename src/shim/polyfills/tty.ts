// `tty` module target (module-map.ts): an app has no terminal, so isatty is
// false for every descriptor, which is what libraries read to decide not to
// colour their output or ask for a prompt. The stream classes refuse by name.

import { refuseShim } from '../errors.js'
import { nodeModule } from './module-proxy.js'

export function otherTtyMember (prop: string): Error {
  return refuseShim(`tty.${prop}`, 'not-applicable',
    `tty.${prop} needs a terminal, and an app has none: tty.isatty() is false for every descriptor, and process.stdout is a plain stream`)
}

export function isatty (_fd?: number): boolean {
  return false
}

export class ReadStream {
  constructor () { throw otherTtyMember('ReadStream') }
}

export class WriteStream {
  constructor () { throw otherTtyMember('WriteStream') }
}

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/tty.js'

export default nodeModule('tty', { isatty, ReadStream, WriteStream }, otherTtyMember)
