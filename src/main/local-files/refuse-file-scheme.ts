import type { Session } from 'electron'

/**
 * Answers `file:` with a 404 on `target`, a session that is not a local-files session, unless it already
 * handles `file:` (a local-files session, or the shell's own). A document that reaches such a session by
 * history (Back to a file entry) then reads nothing, and its `did-navigate` with the 404 is what moves
 * the tab to the session the file belongs in.
 */
export function refuseFileScheme (target: Pick<Session, 'protocol'>): void {
  if (target.protocol.isProtocolHandled('file')) return
  target.protocol.handle('file', () => new Response('Not found', { status: 404 }))
}
