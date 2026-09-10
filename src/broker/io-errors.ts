// Translating a raw error from an injected dependency into the closed
// OrivonErrorCode enum. Split out of ./index.ts (code-guidelines.md Rule 2)
// when udpBind pushed that file past 500 lines -- a pure move, no behaviour
// changed, so the diff is reviewable as one.
//
// SEPARATE FROM ./errors.ts ON PURPOSE. That file CONSTRUCTS errors this
// broker raises; this one TRANSLATES errors it caught from somewhere else.
// The two do meet: `isOrivonError` below is a stricter twin of `errors.ts`'s
// `isOrivonErrorLike`, and which of the two is correct is an open behavioural
// question (docs/open-questions.md A39) deliberately NOT answered by this
// move. Merging them blind is the thing A39 exists to prevent.

import { errnoOf, fail } from './errors.js'
import type { OrivonError, OrivonErrorCode } from '../contracts/index.js'

/** Every value OrivonErrorCode actually has -- see contracts/errors.ts. Used to recognise an error this broker already produced, not one still raw from an injected dependency. */
const ORIVON_ERROR_CODES: ReadonlySet<OrivonErrorCode> = new Set<OrivonErrorCode>([
  'denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'internal'
])

export function isOrivonError (error: unknown): error is OrivonError {
  return error instanceof Error && error.name === 'OrivonError' &&
    ORIVON_ERROR_CODES.has((error as { code?: OrivonErrorCode }).code as OrivonErrorCode)
}

/** Node errno -> OrivonErrorCode. Anything not listed here fails closed as 'internal'. */
const ERRNO_TO_CODE: Readonly<Record<string, OrivonErrorCode>> = {
  ENOENT: 'notFound',
  EEXIST: 'exists',
  ECONNREFUSED: 'unreachable',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
  ENOTFOUND: 'unreachable',
  EAI_AGAIN: 'unreachable',
  ETIMEDOUT: 'timeout',
  ECONNRESET: 'reset',
  EPIPE: 'reset',
  EMFILE: 'limit',
  ENFILE: 'limit',
  ENOSPC: 'limit',
  EDQUOT: 'limit',
  EACCES: 'denied',
  EPERM: 'denied'
}

/**
 * Maps a raw rejection from an injected dependency -- `deps.resolve`,
 * `deps.dial`, `deps.fs.readFile`, `deps.fs.writeFile` -- onto the closed
 * OrivonErrorCode enum. Before this fix none of the four was wrapped: an app
 * switching exhaustively on `err.code`, exactly as contracts/errors.ts's own
 * doc says it may, would see a raw Node errno such as 'ENOENT' -- a value
 * that same doc calls a bug to receive.
 *
 * An error this broker already threw (via `fail`, e.g. 'denied' from a
 * failed policy check) passes through unchanged -- mapping it a second time
 * would be a no-op at best and a lie at worst if two enum members ever
 * collided as strings.
 *
 * WRITES A FRESH MESSAGE, NEVER FORWARDS THE ORIGINAL. A raw fs error
 * message carries the confined absolute path (e.g. "ENOENT: ... open
 * '/apps/<sha256>/missing.txt'") -- handing that to the app tells it exactly
 * where its own confinement root sits (security-model.md T13b), the first
 * thing anything attacking policy/paths.ts wants to know. Only the errno
 * itself survives, as `platformCode` -- and errors.ts's own BrokerError
 * constructor already strips that for 'denied', so it does not need
 * repeating here.
 */
export function mapIoError (error: unknown, kind: 'net' | 'fs'): OrivonError {
  if (isOrivonError(error)) return error
  const errno = errnoOf(error)
  const code = errno === undefined ? 'internal' : (ERRNO_TO_CODE[errno] ?? 'internal')
  const message = kind === 'net' ? 'the network operation failed' : 'the filesystem operation failed'
  return fail(code, message, undefined, errno)
}

/**
 * net.connectSecure's OWN error mapping, kept as its own function rather than
 * a branch inside `mapIoError` (../contracts/capability-api.ts's doc on
 * `connectSecure`, handle-contracts.md's Errors-section owner decision,
 * 2026-08-26): a failed handshake and a certificate/hostname mismatch are
 * 'unreachable' with the real platformCode, exactly like a raw dial failure
 * -- the attempt was one the app was permitted to make, so it gets the true,
 * specific reason, never a generic denial.
 *
 * NOT FOLDED INTO ERRNO_TO_CODE. Node's TLS/OpenSSL binding reports a failed
 * handshake as a `.code` string -- 'CERT_HAS_EXPIRED',
 * 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', and more --
 * that is not a POSIX errno and does not belong in that table. Everything
 * else about the shape is identical to `mapIoError`'s: pass an already-
 * mapped OrivonError through unchanged, keep the platformCode, write a fresh
 * message rather than forwarding OpenSSL's own text (which is not shaped to
 * be handed to an app).
 *
 * THE ONE PLACE THIS TRANSLATION HAPPENS, on purpose: the conductor has
 * raised a live concern with the owner about whether 'unreachable' is the
 * right code for what may be an active interception rather than an ordinary
 * network failure (an app branching on the closed enum cannot tell the two
 * apart, and platformCode is all that carries the difference today).
 * Whichever way that lands, this is the only function that needs to change.
 */
export function mapTlsError (error: unknown): OrivonError {
  if (isOrivonError(error)) return error
  return fail('unreachable', 'the secure connection failed', undefined, errnoOf(error))
}

