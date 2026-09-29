// Which file an `orivon://` request is allowed to read. The one place a
// request's path becomes a path on disk, so it is pure and refuses by default:
// a page is one of a fixed few and an asset is only ever a plain file under
// `assets/`.
import { isAbsolute, relative, resolve } from 'node:path'
import { INTERNAL_SCHEME, isInternalPageId } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'

export type InternalRoute =
  | { readonly kind: 'page', readonly page: InternalPageId }
  /** `path` is relative to the built renderer directory and safe to join to it. */
  | { readonly kind: 'asset', readonly path: string }
  /** Development only: a path the dev server serves, e.g. `/@vite/client`, or
   * `/@fs/<file>` once `fsPathAllowed` below has cleared it. */
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
  // A `%` left after decoding once is a second layer of encoding, which a later URL parse would read as `..`.
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('%')) return null
  const segments = decoded.split('/').slice(1)
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? segments : null
}

/** Vite's `/@fs/<path>` convention: the rest of the segments are a POSIX
 * absolute path, except on Windows where a drive letter (`C:`) is kept as
 * the first one instead of a leading slash -- `resolve` below reads it
 * correctly there since Node's own path module is platform-aware. */
function fsPathFromSegments (segments: readonly string[]): string {
  const rest = segments.slice(1).join('/')
  return /^[a-zA-Z]:$/.test(segments[1] ?? '') ? rest : `/${rest}`
}

/** Whether an `/@fs/` request may reach the dev server: only a path that sits
 * inside one of `devFsRoots` -- the project's own `src/` and `node_modules/`
 * (T43, security-model.md's boundary), passed in already resolved to real
 * paths by the caller, since Vite itself reports a request's path with any
 * symlink resolved (a `node_modules` shared between this project's parallel
 * worktrees is exactly such a symlink). `safeSegments` has already refused a
 * literal `..` segment and a second layer of encoding; this refuses a path
 * with neither that still names a file outside every given root. An empty
 * `devFsRoots` -- the default -- refuses every `/@fs/` request. */
function fsPathAllowed (segments: readonly string[], devFsRoots: readonly string[]): boolean {
  const target = resolve(fsPathFromSegments(segments))
  return devFsRoots.some((root) => {
    const rel = relative(root, target)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/** `dev` is true when the renderer is served by the dev server, whose module
 * paths (`/@vite/client`, `/pages/...`) are not under `assets/`. */
export function routeInternalRequest (requestUrl: string, dev = false, devFsRoots: readonly string[] = []): InternalRoute {
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
  if (segments[0] === '@fs' && !fsPathAllowed(segments, devFsRoots)) return { kind: 'not-found' }
  return { kind: 'dev', path: `/${segments.join('/')}${url.search}` }
}
