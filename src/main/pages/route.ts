// Which file an `orivon://` request is allowed to read. The one place a
// request's path becomes a path on disk, so it is pure and refuses by default:
// a page is one of a fixed few and an asset is only ever a plain file under
// `assets/`. `routeShell` below does the same for the shell's own renderer
// entries on `orivon-shell:`.
import { isAbsolute, relative, resolve } from 'node:path'
import { INTERNAL_SCHEME, isInternalPageId } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'
import { DEFAULT_SESSION_ENTRIES, SHELL_HOST, SHELL_SCHEME, SHELL_SESSION_ENTRIES, shellEntryFile, shellEntryUrl } from '../shell/shell-session.js'

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
  // Held to the roots in any casing, not only the one spelling the dev server reads today.
  if (segments[0]?.toLowerCase() === '@fs' && !fsPathAllowed(segments, devFsRoots)) return { kind: 'not-found' }
  return { kind: 'dev', path: `/${segments.join('/')}${url.search}` }
}

export type ShellRoute =
  /** `path` is relative to the built renderer directory and safe to join to it. */
  | { readonly kind: 'file', readonly path: string, readonly html: boolean }
  | { readonly kind: 'not-found' }

/** Which session asks: the shell's own, or the default one the new-tab page shares with websites. */
export type ShellSessionKind = 'shell' | 'default'

const SHELL_ASSET_EXTENSIONS = [...ASSET_EXTENSIONS, '.woff', '.ttf']
const SHELL_PAGES = new Set(SHELL_SESSION_ENTRIES.map(shellEntryFile))
const DEFAULT_PAGES = new Set(DEFAULT_SESSION_ENTRIES.map(shellEntryFile))

/**
 * Which file of the built renderer an `orivon-shell://renderer/<path>` request may read, in `session`. The shell's
 * session reads its own pages and every file under `assets/` of a listed type; the default session reads the
 * new-tab page and exactly `defaultFiles` (what that page's build reaches, `reachableFiles`), so a website that
 * names another path learns nothing about the build. Anything else, and every other host, is refused; the query
 * and fragment are ignored.
 */
export function routeShell (requestUrl: string, session: ShellSessionKind, defaultFiles: ReadonlySet<string> = new Set()): ShellRoute {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { kind: 'not-found' }
  }
  if (url.protocol !== `${SHELL_SCHEME}:` || url.hostname !== SHELL_HOST) return { kind: 'not-found' }
  if (url.port !== '' || url.username !== '' || url.password !== '') return { kind: 'not-found' }
  const segments = safeSegments(url.pathname)
  if (segments === null || segments.length === 0) return { kind: 'not-found' }
  const path = segments.join('/')
  const html = path.endsWith('.html')
  if (session === 'default') {
    return defaultFiles.has(path) || DEFAULT_PAGES.has(path) ? { kind: 'file', path, html } : { kind: 'not-found' }
  }
  if (SHELL_PAGES.has(path)) return { kind: 'file', path, html: true }
  const isAsset = path.startsWith('assets/') && SHELL_ASSET_EXTENSIONS.some((extension) => path.endsWith(extension))
  return isAsset ? { kind: 'file', path, html: false } : { kind: 'not-found' }
}

/** One entry of Vite's `.vite/manifest.json`. */
export interface ManifestChunk {
  readonly file: string
  readonly imports?: readonly string[] | undefined
  readonly dynamicImports?: readonly string[] | undefined
  readonly css?: readonly string[] | undefined
  readonly assets?: readonly string[] | undefined
}

/** Every file `entry` (a manifest key) can load: its own, its imports' and dynamic imports' at any depth, and their styles and assets. */
export function reachableFiles (manifest: Readonly<Record<string, ManifestChunk>>, entry: string): Set<string> {
  const files = new Set<string>()
  const seen = new Set<string>()
  const pending = [entry]
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const chunk = manifest[key]
    if (chunk === undefined || seen.has(key)) continue
    seen.add(key)
    files.add(chunk.file)
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file)
    pending.push(...(chunk.imports ?? []), ...(chunk.dynamicImports ?? []))
  }
  return files
}

/** What `shellRequestAllowed` reads of a default-session request: its resource type and the frame that made it. */
export interface ShellRequest {
  /** Electron's `resourceType` (`mainFrame`, `subFrame`, `script`, `stylesheet`, `image`, `xhr`, ...). */
  readonly resourceType: string
  /** The frame that started the request; null when none is known. */
  readonly frame: { readonly url: string, readonly isTopFrame: boolean } | null
}

/**
 * Whether a request on the `orivon-shell:` scheme in the default session may proceed. That session is shared
 * with websites, and the scheme is `standard`, so Chromium lets any page load its files as a script, style or
 * image (measured, ADR-0059): only the new-tab page's own top frame may do so. A main-frame navigation passes
 * here whichever web contents makes it, since the tab itself loads the new-tab page and Back returns to it; a
 * page that tries to send a tab there is stopped earlier, by the tab's `will-frame-navigate` and `will-redirect`
 * (../shell/tab-view.ts). A web contents that is no tab (an extension's popup or background page) is not stopped
 * and shows the page without its bridge (ADR-0059).
 */
export function shellRequestAllowed (request: ShellRequest): boolean {
  if (request.resourceType === 'mainFrame') return true
  const { frame } = request
  return frame !== null && frame.isTopFrame && frame.url.split(/[?#]/)[0] === shellEntryUrl('newtab')
}

/** What the request's `frame` offers; reading either field of a frame that is gone can throw. */
export interface ShellRequestDetails {
  readonly resourceType: string
  readonly frame?: { readonly url: string, readonly parent: unknown } | null
}

/** `shellRequestAllowed` for Electron's request details, refusing a request whose frame cannot be read: a frame
 * that is being torn down must not let through what the gate exists to stop. */
export function shellDetailsAllowed (details: ShellRequestDetails): boolean {
  try {
    const frame = details.frame ?? null
    return shellRequestAllowed({
      resourceType: details.resourceType,
      frame: frame === null ? null : { url: frame.url, isTopFrame: frame.parent === null }
    })
  } catch {
    return false
  }
}
