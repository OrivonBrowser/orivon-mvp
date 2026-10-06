import type { Session } from 'electron'
import type { WebRequestOwner } from '../sessions/web-request-owner.js'
import { createFileHandler } from './file-handler.js'
import type { FileHandlerDeps } from './file-handler.js'
import { installLocalFileFence } from './local-file-fence.js'

export interface LocalSessionDeps {
  readonly owner: (target: Session) => Pick<WebRequestOwner, 'onBeforeRequest'>
  readonly fuse: FileHandlerDeps['fuse']
  readonly extraPolicy: NonNullable<FileHandlerDeps['extraPolicy']>
}

const prepared = new WeakSet<Session>()

/**
 * Makes `target` a local-files session: the `file:` handler that serves a file as Chromium does (with
 * the policy `createFileHandler` adds) and the fence that refuses another session's files. Once per
 * session. A session is created with a 404 for `file:` (`refuse-file-scheme.ts`), taken off first.
 */
export function prepareLocalSession (target: Session, partition: string, deps: LocalSessionDeps): void {
  if (prepared.has(target)) return
  prepared.add(target)
  if (target.protocol.isProtocolHandled('file')) target.protocol.unhandle('file')
  target.protocol.handle('file', createFileHandler({
    fetchFile: async (request) => await target.fetch(request, { bypassCustomProtocolHandlers: true }),
    fuse: deps.fuse,
    extraPolicy: deps.extraPolicy
  }))
  installLocalFileFence(deps.owner(target), partition)
}

let preparer: ((partition: string) => void) | undefined

/** Set once by the local-files subsystem, which owns the Electron wiring; a tab view calls `ensureLocalSession` before it loads. */
export function setLocalSessionPreparer (prepare: ((partition: string) => void) | undefined): void {
  preparer = prepare
}

/** Makes the session of `partition`, a local-files partition, ready to load files. A no-op until the subsystem has started. */
export function ensureLocalSession (partition: string): void {
  preparer?.(partition)
}
