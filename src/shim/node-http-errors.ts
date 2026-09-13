// Maps an OrivonError (src/contracts/errors.ts) onto the Error shape Node
// HTTP client code actually branches on: `err.code`.
//
// THREE DELIBERATE CHOICES, because a Node app inspects `.code`, never a
// closed-enum field it has never heard of:
//
// 1. 'denied' never becomes a fake errno -- Node code commonly retries on
//    ECONNREFUSED/ETIMEDOUT, and a permission refusal disguised as one
//    gets "fixed" by retrying forever. `.code` stays 'denied'; `.orivonCode`
//    carries the same value for anyone branching on it deliberately.
// 2. Every other code prefers `platformCode` (a real Node errno) when
//    present, falling back to the OrivonErrorCode string otherwise --
//    forwarded as-is, never reinterpreted (docs/open-questions.md has the
//    open TLS-mapping question this file does not need to answer).
// 3. `isOrivonError` is STRUCTURAL, never `instanceof Error` -- A152: a
//    real denial crossing back from the main world
//    (../preload/main-world-socket.ts) can carry every field correctly
//    while never being `instanceof Error` here. Still fails closed:
//    `code` must be one of the closed enum's own values, or toNodeError's
//    'internal' fallback fires instead.

import type { OrivonError, OrivonErrorCode } from '../contracts/errors.js'

export interface NodeShapedError extends Error {
  code: string
  /** The original closed-enum value, always present, regardless of what `code` reads. */
  orivonCode: OrivonErrorCode
}

/**
 * Every value OrivonErrorCode actually has -- see contracts/errors.ts.
 * Duplicated from src/broker/errors.ts's own identical set rather than
 * imported: that file is on the other side of the broker/shim trust
 * boundary (src/shim/README.md forbids importing src/broker/), and
 * contracts/errors.ts itself emits no runtime code to import instead (its
 * own header) -- so each side that needs to validate a code at runtime
 * keeps its own copy of the same eleven literals.
 */
const ORIVON_ERROR_CODES: ReadonlySet<OrivonErrorCode> = new Set<OrivonErrorCode>([
  'denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal'
])

function isOrivonError (value: unknown): value is OrivonError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown, message?: unknown, code?: unknown }
  return typeof candidate.name === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    ORIVON_ERROR_CODES.has(candidate.code as OrivonErrorCode)
}

/** Node-http client code only ever sees errors through this: never a raw OrivonError. */
export function toNodeError (value: unknown): NodeShapedError {
  if (!isOrivonError(value)) {
    const wrapped = value instanceof Error ? value : new Error(String(value))
    return Object.assign(wrapped, { code: 'internal', orivonCode: 'internal' as const })
  }

  const orivonCode = value.code
  const code = orivonCode === 'denied' ? 'denied' : (value.platformCode ?? orivonCode)
  const message = orivonCode === 'denied'
    ? `orivon: connection denied by capability grant (${value.message})`
    : value.message

  const error = new Error(message) as NodeShapedError
  error.code = code
  error.orivonCode = orivonCode
  error.name = value.name
  return error
}
