// What a page of an app that holds an `fs` grant may load by URL: its own files, read-only, at
// `/orivon/app/<path>` on its own origin (ADR-0070). Pure, like the rest of this directory; the Electron
// half that asks it is ../../main/sessions/app-files-by-url.ts, which also says how a request reaches
// the bytes. T1 reads the same afterwards: the path is confined by `Broker.fs`, the check the
// `orivon.fs` calls use, and the URL adds no way to name a file outside the app's root.

import { originFromUrl } from './origin.js'
import type { RequestingDocument } from './own-listener-media.js'

/** The virtual root every Node-shaped path in an app names (src/shim/virtual-root.ts), as a URL path prefix. */
export const APP_FILES_PREFIX = '/orivon/app/'

export interface AppFileRequest {
  readonly document: RequestingDocument
  readonly url: string
  readonly method: string
  /** Whether that origin holds a live `fs` grant. */
  readonly holdsFs: boolean
}

/**
 * `serve`: answer from the app's files, `path` being relative to the app's files directory and not yet
 * confined, `encodedPath` the same text as the request spelled it. `refuse`: the app's own page asked for a path no file can have; answer 404. `pass`: this
 * gate has no opinion, so the request goes where it was going and the app's host answers as it always did.
 */
export type AppFileVerdict =
  | { readonly kind: 'serve', readonly origin: string, readonly path: string, readonly encodedPath: string }
  | { readonly kind: 'refuse' }
  | { readonly kind: 'pass' }

/**
 * Only the app's own page, over a GET or HEAD, with a live `fs` grant, is answered. Every other asker,
 * another site's `<img>` included, gets what the app's host would have said, so the URL is no oracle
 * for the existence or size of a file.
 */
export function appFileVerdict (request: AppFileRequest): AppFileVerdict {
  if (request.method !== 'GET' && request.method !== 'HEAD') return { kind: 'pass' }
  if (request.document.kind !== 'web' || !request.holdsFs) return { kind: 'pass' }
  const origin = originFromUrl(request.url)
  if (origin === null || origin !== request.document.origin) return { kind: 'pass' }
  let pathname: string
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return { kind: 'pass' }
  }
  if (!pathname.startsWith(APP_FILES_PREFIX) || pathname.length === APP_FILES_PREFIX.length) return { kind: 'pass' }
  const encodedPath = pathname.slice(APP_FILES_PREFIX.length)
  const path = decodedPath(encodedPath)
  return path === null ? { kind: 'refuse' } : { kind: 'serve', origin, path, encodedPath }
}

/** One decode of an encoded path, or null for text no file name can be: bad escapes, a NUL. */
function decodedPath (encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded)
    return decoded.includes('\0') ? null : decoded
  } catch {
    return null
  }
}

/** The scheme a redirect hands the bytes to. */
export const APP_FILE_SCHEME = 'orivon-file'

const SHAPE = /^orivon-file:\/\/app\/([0-9a-f]+)\/([^/]+)\/(.+)$/

/**
 * The URL a verified request is redirected to: the origin and the encoded path, under a MAC that only
 * this process can make. The scheme is registered on the default session and on each app's session,
 * and any page can ask for it, so the MAC is what stops one from naming another app's file.
 */
export function appFileUrl (origin: string, encodedPath: string, mac: (text: string) => string): string {
  return `${APP_FILE_SCHEME}://app/${mac(`${origin}\n${encodedPath}`)}/${encodeURIComponent(origin)}/${encodedPath}`
}

/** The origin and decoded path of an `appFileUrl`, or null when it is not one this process made. */
export function parseAppFileUrl (url: string, mac: (text: string) => string): { readonly origin: string, readonly path: string } | null {
  const parts = SHAPE.exec(url.split('?')[0] ?? '')
  if (parts === null) return null
  const [, claimed, originEncoded, encodedPath] = parts as unknown as [string, string, string, string]
  let origin: string
  try {
    origin = decodeURIComponent(originEncoded)
  } catch {
    return null
  }
  if (!sameText(claimed, mac(`${origin}\n${encodedPath}`))) return null
  const path = decodedPath(encodedPath)
  return path === null ? null : { origin, path }
}

/** Equal text, compared without stopping at the first difference. */
function sameText (a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}
