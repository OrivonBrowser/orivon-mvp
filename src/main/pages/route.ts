// Which file an `orivon://` request is allowed to read. The one place a
// request's path becomes a path on disk, so it is pure and refuses by default:
// a page is one of a fixed few and an asset is only ever a plain file under
// `assets/`.
import { INTERNAL_SCHEME, isInternalPageId } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'

export type InternalRoute =
  | { readonly kind: 'page', readonly page: InternalPageId }
  /** `path` is relative to the built renderer directory and safe to join to it. */
  | { readonly kind: 'asset', readonly path: string }
  /** Development only: a path the dev server serves, e.g. `/@vite/client`. */
  | { readonly kind: 'dev', readonly path: string }
  | { readonly kind: 'not-found' }

const ASSET_EXTENSIONS = ['.js', '.css', '.svg', '.png', '.webp', '.woff2', '.ico']

function safeSegments (pathname: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null
  const segments = decoded.split('/').slice(1)
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? segments : null
}

/** `dev` is true when the renderer is served by the dev server, whose module
 * paths (`/@vite/client`, `/pages/...`) are not under `assets/`. */
export function routeInternalRequest (requestUrl: string, dev = false): InternalRoute {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { kind: 'not-found' }
  }
  if (url.protocol !== `${INTERNAL_SCHEME}:` || !isInternalPageId(url.hostname)) return { kind: 'not-found' }

  const isAsset = url.pathname.startsWith('/assets/')
  if (!isAsset && !(dev && url.pathname !== '/' && /^\/(@|pages\/|node_modules\/|src\/)/.test(url.pathname))) {
    // Any other path is a place inside the page: the page routes it itself.
    return { kind: 'page', page: url.hostname }
  }

  const segments = safeSegments(url.pathname)
  if (segments === null) return { kind: 'not-found' }
  const last = segments.at(-1) ?? ''
  if (isAsset) {
    return ASSET_EXTENSIONS.some((extension) => last.endsWith(extension))
      ? { kind: 'asset', path: segments.join('/') }
      : { kind: 'not-found' }
  }
  // `/@fs/` reads any file the dev server can see.
  return segments[0] === '@fs' ? { kind: 'not-found' } : { kind: 'dev', path: `/${segments.join('/')}${url.search}` }
}
