// The session internal pages run in, and the only one that can load them.
// It is in memory (no `persist:`), holds nothing across a restart, and serves
// `orivon://` itself; every other session, the default one and each app's,
// has no handler for the scheme, so a website cannot load, frame or fetch an
// internal page whatever URL it names.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, protocol, session } from 'electron'
import type { Session } from 'electron'
import { INTERNAL_PARTITION, INTERNAL_SCHEME } from './internal-pages.js'
import { createInternalHandler } from './serve.js'
import { validatedDevServerUrl } from '../shell/renderer-entry.js'

let installed: Session | undefined

export function internalSession (): Session | undefined {
  return installed
}

/** Before the app is ready: Electron fixes a scheme's privileges then. It may
 * be called only once, so any other scheme the shell needs privileged joins
 * this list rather than making a second call. `standard` and `secure` give
 * pages an origin, `fetch` and a secure context; nothing here bypasses a
 * page's CSP. */
export function registerInternalScheme (): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: INTERNAL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** `dirname`: the calling module's `import.meta.dirname` (out/main), from
 * which the built renderer is found at `../renderer`. */
export function installInternalSession (dirname: string): Session {
  if (installed !== undefined) return installed
  const internal = session.fromPartition(INTERNAL_PARTITION)
  internal.protocol.handle(INTERNAL_SCHEME, createInternalHandler({
    rendererRoot: join(dirname, '../renderer'),
    devServerUrl: validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']),
    readFile: async (path) => await readFile(path)
  }))
  // A page in this session has no reason to reach the network, and the CSP
  // already says so; this is the second lock on the same door.
  internal.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => { callback({ cancel: true }) }
  )
  installed = internal
  return internal
}
