// Transcribed from docs/architecture/handle-contracts.md SSErrors. That
// document is the specification; this file must not diverge from it.
//
// OrivonError is declared as an interface rather than a class because this
// directory emits no runtime code -- a `class` would. The broker constructs
// the concrete error object; every consumer only needs its shape.

/**
 * Closed enum. An app may switch on this exhaustively and treat an
 * unrecognised value as a bug, not a case to silently ignore.
 *
 * Adding a code is a BREAKING CHANGE once orivonApiVersion reaches 1
 * (handle-contracts.md SSVersioning). While it is 0, the surface is unstable
 * by declaration and codes may still be added.
 */
export type OrivonErrorCode =
  /**
   * Outside what was granted: pattern mismatch, undeclared capability,
   * privileged port, blocked address range.
   *
   * Uniform across every reason for denial, and never carries a
   * platformCode -- see the note on that field.
   */
  | 'denied'
  /** The grant authorising this handle was withdrawn. See handle-contracts.md SSRevocation. */
  | 'revoked'
  /** The peer could not be reached: refused, no route, DNS failure. */
  | 'unreachable'
  /** The operation exceeded its deadline. */
  | 'timeout'
  /** The peer terminated an established connection abruptly. */
  | 'reset'
  /** Operation attempted on a handle that is already closed. */
  | 'closed'
  /** A resource limit was hit: quota, socket count, in-flight cap. See ./limits.js. */
  | 'limit'
  /** Malformed argument: bad path, bad address, bad option. */
  | 'invalid'
  /** The named file or directory does not exist. */
  | 'notFound'
  /** The named file or directory already exists. */
  | 'exists'
  /** A broker fault. Should never be observed by an app, and is always logged. */
  | 'internal'

export interface OrivonError extends Error {
  readonly code: OrivonErrorCode

  /**
   * The underlying engine's own detail -- a Node errno today (ECONNREFUSED,
   * ENOENT, ...), whatever WASI or Mojo expose later.
   *
   * ADVISORY AND UNVERSIONED. An app that branches on this is coding against
   * the engine underneath rather than against Orivon, and may need adjusting
   * across the Node -> Wasmtime -> Chromium/Mojo transitions. It exists so
   * orivon-node-shim can reconstruct a faithful Node Error, because
   * `err.code === 'ECONNREFUSED'` is a real Node idiom that must keep working
   * through the shim.
   *
   * Present for every code EXCEPT 'denied', for an attempt the app was
   * permitted to make. Owner decision, 2026-08-26: apps get the true, specific
   * reason for a failure, because withholding it breaks the large body of
   * existing Node code that branches on specific errnos to drive retry and
   * fallback logic.
   *
   * NEVER present when `code` is 'denied'. If denials varied by reason, an app
   * could iterate through them and map exactly which pattern, port or address
   * class is blocked, turning the permission boundary itself into a probe
   * target.
   */
  readonly platformCode?: string

  /** The handle the failure relates to, when the failure has one. */
  readonly handleId?: string
}
