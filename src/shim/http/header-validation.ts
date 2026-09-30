// The checks Node's outgoing side makes on a header before it is stored, with
// Node's own error classes and codes. Also exported as
// http.validateHeaderName / http.validateHeaderValue.

import { codedError } from '../node-errors.js'

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const INVALID_CONTENT_CHARACTER = /[^\t\x20-\x7e\x80-\xff]/

export function validateHeaderName (name: unknown, label = 'Header name'): void {
  if (typeof name !== 'string' || name === '' || !TOKEN.test(name)) {
    throw codedError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `${label} must be a valid HTTP token [${JSON.stringify(name)}]`)
  }
}

export function validateHeaderValue (name: string, value: unknown): void {
  if (value === undefined) {
    throw codedError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "undefined" for header "${name}"`)
  }
  for (const one of Array.isArray(value) ? value as unknown[] : [value]) {
    if (INVALID_CONTENT_CHARACTER.test(String(one))) {
      throw codedError(TypeError, 'ERR_INVALID_CHAR', `Invalid character in header content [${JSON.stringify(name)}]`)
    }
  }
}
