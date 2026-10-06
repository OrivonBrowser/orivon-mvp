import { fileURLToPath } from 'node:url'
import { localFileKey } from '../../broker/policy/origin.js'
import type { FileProtocolFuse } from './file-fuse.js'

export interface FileHandlerDeps {
  /** Reads the file through Chromium's own `file:` loader, skipping this handler (`bypassCustomProtocolHandlers`). */
  readonly fetchFile: (request: Request) => Promise<Response>
  /** What the running binary's file-protocol fuse says (`file-fuse.ts`); anything but `'off'` serves nothing. */
  readonly fuse: () => Promise<FileProtocolFuse>
  /** The policy a document that holds Orivon permissions is served under, or undefined. Takes the document's key. */
  readonly extraPolicy?: (key: string) => Promise<string | undefined>
  readonly platform?: NodeJS.Platform
}

/** A Windows path that names a drive: `C:\...`. UNC (`\\server`), `\\?\` and `\\.\` do not. */
const DRIVE_PATH = /^[A-Za-z]:\\/

function refuse (status: number): Response {
  return new Response('', { status, headers: { 'content-type': 'text/plain' } })
}

/** The file path a `file:` URL names, or null when it names a host, a share, or something that is not one plain local path. */
export function localPathOf (url: URL, platform: NodeJS.Platform): string | null {
  if (url.protocol !== 'file:' || url.hostname !== '' || url.pathname.startsWith('//')) return null
  let path: string
  try {
    path = fileURLToPath(url, { windows: platform === 'win32' })
  } catch {
    return null
  }
  return platform === 'win32' && !DRIVE_PATH.test(path) ? null : path
}

/**
 * The `protocol.handle('file')` handler of a local-files session: it serves a file the way Chromium
 * does, with `nosniff` on every response (README.md's Design notes say why no other policy is added)
 * and, while the document's key holds Orivon permissions, the policy that grant earns.
 * It refuses a host, a share and any method but GET and HEAD, and serves nothing while the binary's
 * file-protocol fuse is not off: with the fuse on, a local page could read other files.
 */
export function createFileHandler (deps: FileHandlerDeps): (request: Request) => Promise<Response> {
  const platform = deps.platform ?? process.platform

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return refuse(400)
    }
    if (localPathOf(url, platform) === null) return refuse(403)
    const key = localFileKey(request.url)
    if (key === null || await deps.fuse() !== 'off') return refuse(403)

    const response = await deps.fetchFile(request)
    const headers = new Headers(response.headers)
    headers.set('x-content-type-options', 'nosniff')
    const policy = await deps.extraPolicy?.(key)
    if (policy !== undefined) headers.append('content-security-policy', policy)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
