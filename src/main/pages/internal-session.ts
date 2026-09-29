// The session internal pages run in, and the only one that can load them.
// It is in memory (no `persist:`), holds nothing across a restart, and serves
// `orivon://` itself; every other session, the default one and each app's,
// has no handler for the scheme, so a website cannot load, frame or fetch an
// internal page whatever URL it names.
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { protocol, session } from 'electron'
import type { Session } from 'electron'
import { INTERNAL_PARTITION, INTERNAL_SCHEME } from './internal-pages.js'
import { createInternalHandler, isDevServerRequest } from './serve.js'

/** Its real path, so it lines up with what Vite itself reports for a request
 * under it (Vite resolves symlinks in a module's path) -- this project's own
 * parallel build-step worktrees share one `node_modules` exactly that way.
 * Falls back to the plain path so a checkout missing the directory (a fresh
 * `git worktree add`, before `npm install`) still starts rather than throw. */
function devFsRoot (path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

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
  const rendererRoot = join(dirname, '../renderer')
  // out/renderer's parent's parent: out/main -> out -> the project root.
  const projectRoot = join(rendererRoot, '..', '..')
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  const internal = session.fromPartition(INTERNAL_PARTITION)
  internal.protocol.handle(INTERNAL_SCHEME, createInternalHandler({
    rendererRoot,
    devServerUrl,
    readFile: async (path) => await readFile(path),
    devFsRoots: ['src', 'node_modules'].map((dir) => devFsRoot(join(projectRoot, dir)))
  }))
  // A page in this session has no reason to reach the network beyond the dev
  // server's own HMR socket in development, and the CSP already says so;
  // this is the second lock on the same door (isDevServerRequest's own doc).
  internal.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (details, callback) => { callback({ cancel: !isDevServerRequest(details.url, devServerUrl) }) }
  )
  installed = internal
  return internal
}
