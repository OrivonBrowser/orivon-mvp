import type { OrivonError, OrivonErrorCode } from '../contracts/errors.js'

// The one OrivonError builder shared by every isolated-world file in this
// directory that needs to reject or throw one -- socket-port.ts, socket-
// bridge.ts and orivon-surface.ts each built their own copy before this
// consolidation (code-guidelines.md Rule 3). main-world-socket.ts keeps a
// separate copy: it is serialised into the main world with no free
// identifiers allowed, so it cannot import this one.
//
// Returns a PLAIN OBJECT, never `new Error(...)` -- contextBridge's promise-
// rejection marshalling only preserves `.message` on a real `Error`
// instance and silently drops `.code`/`.platformCode` (orivon-surface.ts's
// own header has the full story). `OrivonError` is an interface for
// exactly this reason: every consumer only needs the shape.

/** `message` defaults to a generic, code-derived string when the caller has nothing more specific to say. */
export function toOrivonError (code: OrivonErrorCode, options: { message?: string, platformCode?: string } = {}): OrivonError {
  const { message = `socket failed: ${code}`, platformCode } = options
  return platformCode === undefined
    ? { name: 'OrivonError', message, code }
    : { name: 'OrivonError', message, code, platformCode }
}
