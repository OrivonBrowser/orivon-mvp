// Answers a request for an `orivon://` URL. Pure over its two inputs, the
// built renderer's files and the dev server: no Electron here, so every
// refusal is unit-tested under plain vitest.
import { isAbsolute, relative, resolve } from 'node:path'
import { routeInternalRequest } from './route.js'

export interface InternalServeOptions {
  /** The built renderer directory, `out/renderer`. */
  readonly rendererRoot: string
  /** electron-vite's dev server, when one is running. */
  readonly devServerUrl: string | undefined
  readonly readFile: (path: string) => Promise<Uint8Array>
  /** `accept` is forwarded from the page's own request: Vite's dev server
   * answers a CSS `<link>`'s fetch (`Accept: text/css,...`) with the plain
   * stylesheet, but a bare `fetch()` with no `Accept` gets back the
   * HMR-wrapping JS module it serves a script import instead -- the two are
   * different response bodies for the identical URL. */
  readonly fetchDev?: ((url: string, accept?: string) => Promise<Response>) | undefined
  /** Only consulted in development, for what `/@fs/` may read (route.ts):
   * the project's `src/` and `node_modules/`, already resolved to their real
   * paths by the caller (internal-session.ts), since a symlinked
   * `node_modules` -- this project's own parallel-worktree pattern -- would
   * otherwise never textually match what Vite itself reports. */
  readonly devFsRoots?: readonly string[]
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
}

/** What a page may load: its own files and inline styles, and data: images.
 * No network of its own: every fact on an internal page comes over IPC. */
export function internalCsp (devServerUrl: string | undefined): string {
  const connect = devServerUrl === undefined ? "'none'" : `ws://${new URL(devServerUrl).host}`
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/** Whether `url` names the dev server's own address -- the one thing a page
 * in this session may reach on the network besides `orivon://` itself, in
 * development: the HMR client's own WebSocket, which internal-session.ts's
 * network lock (a second lock on the same door `internalCsp` already
 * guards) otherwise refuses along with everything else. `false` whenever
 * there is no dev server at all (a built launch), the safe default. */
export function isDevServerRequest (url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl === undefined) return false
  try {
    return new URL(url).host === new URL(devServerUrl).host
  } catch {
    return false
  }
}

function extensionOf (path: string): string {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

function reply (body: BodyInit | null, status: number, contentType: string, devServerUrl: string | undefined): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'content-security-policy': internalCsp(devServerUrl),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store'
    }
  })
}

const notFound = (devServerUrl: string | undefined): Response => reply('Not found', 404, 'text/plain; charset=utf-8', devServerUrl)

/** Deep links (`orivon://settings/privacy`) resolve the page's relative asset
 * URLs against their own path; pinning the base keeps them right however deep
 * the link goes. Once built, every page's assets are flattened into one
 * `assets/` directory reached by a relative climb out of `pages/<page>/`, so
 * the root, `/`, is the right base at any depth (the default here). In
 * development the page's own HTML is unbundled -- `./main.ts`, `./style.css`,
 * relative to the page's own folder on the dev server -- so the base must be
 * that folder instead, `/pages/<page>/` (serve.ts's only other caller). */
export function withRootBase (html: string, base = '/'): string {
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (open) => `${open}<base href="${base}">`) : `<base href="${base}">${html}`
}

export function createInternalHandler (options: InternalServeOptions): (request: Request) => Promise<Response> {
  const { rendererRoot, devServerUrl } = options
  const fetchDev = options.fetchDev ?? (async (url: string, accept?: string) => await fetch(url, accept === undefined ? undefined : { headers: { accept } }))
  const root = resolve(rendererRoot)

  async function readInside (relativePath: string): Promise<Uint8Array | null> {
    const target = resolve(root, relativePath)
    const inside = relative(root, target)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
    try {
      return await options.readFile(target)
    } catch {
      return null
    }
  }

  return async (request) => {
    const route = routeInternalRequest(request.url, devServerUrl !== undefined, options.devFsRoots)
    switch (route.kind) {
      case 'not-found':
        return notFound(devServerUrl)
      case 'page': {
        let html: string
        if (devServerUrl === undefined) {
          const bytes = await readInside(`pages/${route.page}/index.html`)
          if (bytes === null) return notFound(devServerUrl)
          html = new TextDecoder().decode(bytes)
        } else {
          const upstream = await fetchDev(new URL(`/pages/${route.page}/index.html`, devServerUrl).toString())
          if (!upstream.ok) return notFound(devServerUrl)
          html = await upstream.text()
        }
        const base = devServerUrl === undefined ? '/' : `/pages/${route.page}/`
        return reply(withRootBase(html, base), 200, MIME['.html'] as string, devServerUrl)
      }
      case 'asset': {
        const bytes = await readInside(route.path)
        return bytes === null
          ? notFound(devServerUrl)
          : reply(bytes as BodyInit, 200, MIME[extensionOf(route.path)] ?? 'application/octet-stream', devServerUrl)
      }
      case 'dev': {
        if (devServerUrl === undefined) return notFound(devServerUrl)
        const upstream = await fetchDev(new URL(route.path, devServerUrl).toString(), request.headers.get('accept') ?? undefined)
        return reply(upstream.body, upstream.status, upstream.headers.get('content-type') ?? 'application/octet-stream', devServerUrl)
      }
    }
  }
}
