import { fileURLToPath } from 'node:url'
import { localFileKey } from '../../broker/policy/origin.js'
import { INERT_FILE_CSP, LOCAL_FILE_CSP, NO_SNIFF_HEADER, withPolicies } from './local-file-csp.js'

/** What a handler is built for: the local-files session serves files under a policy; any other session serves none. */
export type FileHandlerKind = 'local' | 'guarded'

export interface FileHandlerDeps {
  readonly kind: FileHandlerKind
  /** Reads the file through Chromium's own `file:` loader, skipping this handler (`bypassCustomProtocolHandlers`). */
  readonly fetchFile: (request: Request) => Promise<Response>
  /** `'guarded'` only: the built shell pages' folder. Files under it are served as they are. */
  readonly passThroughRoot?: string
  /** `'local'` only: a further policy for a document whose key holds Orivon permissions, or undefined. */
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

function isUnder (path: string, root: string, platform: NodeJS.Platform): boolean {
  const separator = platform === 'win32' ? '\\' : '/'
  const [inner, outer] = platform === 'win32' ? [path.toLowerCase(), root.toLowerCase()] : [path, root]
  return inner.startsWith(outer.endsWith(separator) ? outer : `${outer}${separator}`)
}

/**
 * The `protocol.handle('file')` handler of one session.
 *
 * `'local'` serves any local file the way Chromium does and adds the local-file policy
 * (`local-file-csp.ts`) to the response, with a second policy for a granted document. `'guarded'`
 * serves only the shell's own built pages; any other `file:` URL gets an empty sandboxed page, so
 * a document that commits in the wrong session reads nothing and runs nothing until the tab moves
 * to the local-files session. Both refuse a host, a share, and anything but GET and HEAD.
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
    const path = localPathOf(url, platform)
    if (path === null) return refuse(403)

    if (deps.kind === 'guarded') {
      if (deps.passThroughRoot !== undefined && isUnder(path, deps.passThroughRoot, platform)) return await deps.fetchFile(request)
      return new Response('', { status: 200, headers: withPolicies(new Headers({ 'content-type': 'text/html' }), [INERT_FILE_CSP]) })
    }

    const key = localFileKey(request.url)
    if (key === null) return refuse(403)
    const policies = [LOCAL_FILE_CSP]
    const extra = await deps.extraPolicy?.(key)
    if (extra !== undefined) policies.push(extra)
    const response = await deps.fetchFile(request)
    const headers = withPolicies(response.headers, policies)
    headers.set(...NO_SNIFF_HEADER)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
