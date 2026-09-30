// The checks Node's outgoing side makes on a header before it is stored, with
// Node's own error classes and codes. Also exported as
// http.validateHeaderName / http.validateHeaderValue.

import { codedError } from '../node-errors.js'
import { HTTP_TOKEN, INVALID_HEADER_CONTENT } from './header-tokens.js'


export function validateHeaderName (name: unknown, label = 'Header name'): void {
  if (typeof name !== 'string' || name === '' || !HTTP_TOKEN.test(name)) {
    throw codedError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `${label} must be a valid HTTP token [${JSON.stringify(name)}]`)
  }
}

export function validateHeaderValue (name: string, value: unknown): void {
  if (value === undefined) {
    throw codedError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "undefined" for header "${name}"`)
  }
  for (const one of Array.isArray(value) ? value as unknown[] : [value]) {
    if (INVALID_HEADER_CONTENT.test(String(one))) {
      throw codedError(TypeError, 'ERR_INVALID_CHAR', `Invalid character in header content [${JSON.stringify(name)}]`)
    }
  }
}
