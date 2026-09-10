// Maps an OrivonError (src/contracts/errors.ts) onto the Error shape Node
// HTTP client code actually branches on: `err.code`.
//
// TWO DELIBERATE CHOICES, both because a Node app inspects `.code`, never a
// closed-enum field it has never heard of:
//
// 1. 'denied' never becomes a fake errno. Node code commonly retries on
//    ECONNREFUSED/ETIMEDOUT; handing back one of those for a permission
//    refusal would make a developer "fix" it by retrying forever, or filing
//    a bug against the wrong layer. `.code` stays the literal string
//    'denied' -- unfamiliar, but honest, and `.orivonCode` carries the same
//    value for anyone branching on it deliberately.
// 2. Every other code prefers `platformCode` (a real Node errno from the
//    broker, e.g. ECONNREFUSED, CERT_HAS_EXPIRED) when present, and falls
//    back to the OrivonErrorCode string otherwise. This repo's own open
//    question about whether TLS failures should keep sharing 'unreachable'
//    is still open (docs/open-questions.md) -- this file does not guess at
//    a resolution, it just forwards whatever platformCode the broker sent,
//    so a future change to that mapping needs no change here.

import type { OrivonError, OrivonErrorCode } from '../contracts/errors.js'

export interface NodeShapedError extends Error {
  code: string
  /** The original closed-enum value, always present, regardless of what `code` reads. */
  orivonCode: OrivonErrorCode
}

function isOrivonError (value: unknown): value is OrivonError {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string'
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
