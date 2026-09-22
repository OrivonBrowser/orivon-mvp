// Every Node-shaped error this package builds: toNodeError maps an
// OrivonError (src/contracts/errors.ts) onto what Node code branches on
// (`err.code`, `err.errno`, `err.syscall`), and the builders below make the
// ERR_* / system errors Node itself would have thrown. Shared by net, http,
// tls, dgram, dns and fs.
//
// THREE DELIBERATE CHOICES in toNodeError:
//
// 1. 'denied' never becomes a fake errno -- Node code commonly retries on
//    ECONNREFUSED/ETIMEDOUT, and a permission refusal disguised as one
//    gets "fixed" by retrying forever. `.code` stays 'denied'; `.orivonCode`
//    carries the same value for anyone branching on it deliberately.
// 2. A real `platformCode` wins. Only when it is absent is a Node errno
//    synthesised from the Orivon code (see synthesiseCode).
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
  errno?: number
  syscall?: string
  address?: string
  port?: number
  hostname?: string
}

/** What the caller knows about the operation that failed; every field is copied onto the error when present. */
export interface ErrorContext {
  readonly syscall?: string
  readonly address?: string
  readonly port?: number
  readonly hostname?: string
}

/**
 * Every value OrivonErrorCode actually has -- see contracts/errors.ts.
 * Duplicated from src/broker/errors.ts's own identical set rather than
 * imported: that file is on the other side of the broker/shim trust
 * boundary (src/shim/README.md forbids importing src/broker/), and
 * contracts/errors.ts itself emits no runtime code to import instead.
 */
const ORIVON_ERROR_CODES: ReadonlySet<OrivonErrorCode> = new Set<OrivonErrorCode>([
  'denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal'
])

/** Node's negative errno for each code, in Linux numbering (libuv's EAI_* for resolver codes). */
const ERRNO: Readonly<Record<string, number>> = {
  EPERM: -1, ENOENT: -2, EBADF: -9, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22,
  EMFILE: -24, ENOSPC: -28, EROFS: -30, EPIPE: -32, ENOTEMPTY: -39, EPROTO: -71, EMSGSIZE: -90,
  EADDRINUSE: -98, EADDRNOTAVAIL: -99, ENETDOWN: -100, ENETUNREACH: -101, ECONNABORTED: -103,
  ECONNRESET: -104, ENOTCONN: -107, ETIMEDOUT: -110, ECONNREFUSED: -111, EHOSTUNREACH: -113,
  EAI_AGAIN: -3001, EAI_FAIL: -3004, ENOTFOUND: -3008
}

function isOrivonError (value: unknown): value is OrivonError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown, message?: unknown, code?: unknown }
  return typeof candidate.name === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    ORIVON_ERROR_CODES.has(candidate.code as OrivonErrorCode)
}

function isAlreadyMapped (value: unknown): value is NodeShapedError {
  return value instanceof Error &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { orivonCode?: unknown }).orivonCode === 'string'
}

/** The Node errno a failure with no platformCode most plausibly was; the Orivon code itself when nothing fits. */
function synthesiseCode (orivonCode: OrivonErrorCode, syscall: string | undefined): string {
  switch (orivonCode) {
    case 'timeout': return 'ETIMEDOUT'
    case 'reset': return 'ECONNRESET'
    case 'unreachable': return syscall === 'getaddrinfo' ? 'ENOTFOUND' : 'ECONNREFUSED'
    case 'closed': return syscall === 'write' ? 'EPIPE' : 'closed'
    default: return orivonCode
  }
}

/** Adds errno and the context fields, never replacing a value the error already has. */
function decorate<E extends Error & { code?: string, errno?: number }> (error: E, context: ErrorContext): E {
  const target = error as Error & Record<string, unknown>
  const errno = error.code !== undefined ? ERRNO[error.code] : undefined
  if (errno !== undefined && target.errno === undefined) target.errno = errno
  for (const key of ['syscall', 'address', 'port', 'hostname'] as const) {
    if (context[key] !== undefined && target[key] === undefined) target[key] = context[key]
  }
  return error
}

/** Node-http client code only ever sees errors through this: never a raw OrivonError. */
export function toNodeError (value: unknown, context: ErrorContext = {}): NodeShapedError {
  if (isAlreadyMapped(value)) return decorate(value, context)
  if (!isOrivonError(value)) {
    const wrapped = (value instanceof Error ? value : new Error(String(value))) as NodeShapedError
    if (typeof (wrapped as { code?: unknown }).code !== 'string') wrapped.code = 'internal'
    wrapped.orivonCode = 'internal'
    return decorate(wrapped, context)
  }

  const orivonCode = value.code
  const code = orivonCode === 'denied' ? 'denied' : (value.platformCode ?? synthesiseCode(orivonCode, context.syscall))
  const message = orivonCode === 'denied'
    ? `orivon: connection denied by capability grant (${value.message})`
    : value.message

  const error = new Error(message) as NodeShapedError
  error.code = code
  error.orivonCode = orivonCode
  error.name = value.name
  return decorate(error, context)
}

/** An ERR_* error the way Node's internal/errors builds one: the right constructor, plus `code`. */
export function codedError<C extends new (message: string) => Error> (Ctor: C, code: string, message: string): InstanceType<C> & { code: string } {
  return Object.assign(new Ctor(message) as InstanceType<C>, { code })
}

/** A system error Node would have produced itself, message and all: `send EMSGSIZE 1.2.3.4:6881`. */
export function systemError (code: string, syscall: string, context: ErrorContext = {}): Error & { code: string, errno?: number } {
  const target = context.hostname ?? (context.address !== undefined
    ? `${context.address}${context.port !== undefined ? `:${String(context.port)}` : ''}`
    : undefined)
  const error = Object.assign(new Error(`${syscall} ${code}${target !== undefined ? ` ${target}` : ''}`), { code })
  return decorate(error, { ...context, syscall })
}

/** Node's ConnResetException: 'socket hang up' before a response, 'aborted' during one. */
export function connResetError (message: 'socket hang up' | 'aborted'): Error & { code: string } {
  return codedError(Error, 'ECONNRESET', message)
}

/** Node's AbortError, as `signal`-driven cancellation raises it. */
export function abortError (reason?: unknown): Error & { code: string } {
  const error = codedError(Error, 'ABORT_ERR', 'The operation was aborted')
  error.name = 'AbortError'
  if (reason !== undefined) (error as Error & { cause?: unknown }).cause = reason
  return error
}
