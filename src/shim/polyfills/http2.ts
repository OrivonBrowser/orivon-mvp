// `http2` module target (module-map.ts): it loads, with Node's real
// `constants` (http2-constants.generated.json), because http2-wrapper and
// undici read the header and method names from it as they evaluate. Every
// function refuses by name: no HTTP/2 transport exists over orivon.net yet,
// and a client library falls back to HTTP/1.1 on the error.

import { refuseShim } from '../errors.js'
import table from './http2-constants.generated.json'
import { nodeModule } from './module-proxy.js'

export function otherHttp2Member (prop: string): Error {
  return refuseShim(`http2.${prop}`, 'not-built',
    `http2.${prop} is not built: there is no HTTP/2 session over orivon.net, only http and https over HTTP/1.1. See docs/planning/compatibility-matrix.md Table 3.`)
}

export const constants: Readonly<Record<string, string | number>> = Object.freeze({ ...table.constants })

export const sensitiveHeaders: symbol = Symbol('nodejs.http2.sensitiveHeaders')

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/http2.js'

export default nodeModule('http2', { constants, sensitiveHeaders }, otherHttp2Member)
