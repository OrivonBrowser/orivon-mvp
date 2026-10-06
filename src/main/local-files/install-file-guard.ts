import type { Session } from 'electron'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { createFileHandler } from './file-handler.js'

const ALL_URLS = { urls: ['<all_urls>'] }

/**
 * Serves `file:` on a session that is not the local-files session: the shell's own built pages as they
 * are, and an empty sandboxed page for anything else (see `createFileHandler`). A session that already
 * handles `file:` is left as it is, so a later call cannot undo `serveLocalFiles`.
 */
export function guardFileScheme (target: Session, shellPagesRoot: string): void {
  if (target.protocol.isProtocolHandled('file')) return
  target.protocol.handle('file', createFileHandler({
    kind: 'guarded',
    passThroughRoot: shellPagesRoot,
    fetchFile: async (request) => await target.fetch(request, { bypassCustomProtocolHandlers: true })
  }))
}

/**
 * Makes `target` the session local files run in: every `file:` response gets the local-file policy
 * (and `extraPolicy`'s, for a document that holds Orivon permissions), and no cookie is sent or kept,
 * whatever site a local page reaches.
 */
export function serveLocalFiles (target: Session, extraPolicy: (key: string) => Promise<string | undefined>): void {
  if (target.protocol.isProtocolHandled('file')) target.protocol.unhandle('file')
  target.protocol.handle('file', createFileHandler({
    kind: 'local',
    extraPolicy,
    fetchFile: async (request) => await target.fetch(request, { bypassCustomProtocolHandlers: true })
  }))
  const owner = webRequestOwnerFor(target)
  owner.onBeforeSendHeaders(RUN_LAST, ALL_URLS, () => true, (_details, current) => ({
    ...current,
    requestHeaders: Object.fromEntries(Object.entries(current.requestHeaders).filter(([name]) => name.toLowerCase() !== 'cookie'))
  }))
  owner.onHeadersReceived(RUN_LAST, ALL_URLS, () => true, (_details, current) => ({
    ...current,
    responseHeaders: Object.fromEntries(Object.entries(current.responseHeaders).filter(([name]) => name.toLowerCase() !== 'set-cookie'))
  }))
}
