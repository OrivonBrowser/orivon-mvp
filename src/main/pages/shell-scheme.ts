// Serves the shell's own renderer entries from `orivon-shell://renderer/...`,
// in the two sessions that show them. Answers nothing in any other session, so
// a website, an app or an extension cannot load a page of the shell.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { session } from 'electron'
import { createShellHandler } from './serve.js'
import { reachableFiles, shellDetailsAllowed } from './route.js'
import type { ManifestChunk } from './route.js'
import { SHELL_PARTITION, SHELL_SCHEME, isShellSchemeUrl, shellEntryFile } from '../shell/shell-session.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'

/** The files the new-tab page's build reaches, from Vite's manifest. Empty when there is no build (a dev server serves it). */
function newtabFiles (rendererRoot: string): ReadonlySet<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>
    return reachableFiles(manifest, shellEntryFile('newtab'))
  } catch {
    return new Set()
  }
}

/** `dirname`: the calling module's `import.meta.dirname` (out/main), from which the built renderer is `../renderer`. */
export function installShellScheme (dirname: string): void {
  const rendererRoot = join(dirname, '../renderer')
  const read = async (path: string): Promise<Uint8Array> => await readFile(path)

  const shell = session.fromPartition(SHELL_PARTITION)
  shell.protocol.handle(SHELL_SCHEME, createShellHandler({ rendererRoot, session: 'shell', readFile: read }))
  // The shell's pages load nothing from disk by `file:`: the build is served above, and a page of the shell
  // that names a local file gets a 404.
  shell.protocol.handle('file', () => new Response('Not found', { status: 404 }))

  session.defaultSession.protocol.handle(SHELL_SCHEME, createShellHandler({
    rendererRoot, session: 'default', defaultFiles: newtabFiles(rendererRoot), readFile: read
  }))
  // The default session is a website's too, and Chromium lets any page load a standard scheme's files as a
  // script, style or image, whatever the response's Cross-Origin-Resource-Policy says (ADR-0059). So only the
  // new-tab page's own top frame, and a main-frame navigation to it, get through.
  webRequestOwnerFor(session.defaultSession).onBeforeRequest(
    0,
    { urls: [`${SHELL_SCHEME}://*/*`] },
    isShellSchemeUrl,
    (details, current) => shellDetailsAllowed(details) ? current : { cancel: true }
  )
}
