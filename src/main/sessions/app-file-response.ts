// The bytes of an app's own file for an `orivon-file:` URL (ADR-0070), with the `Range` handling a media
// element seeks with. No Electron here: the Electron half, which redirects a request to such a URL and
// registers the scheme, is ./app-files-by-url.ts.

import { createHmac, randomBytes } from 'node:crypto'
import type { Broker } from '../../broker/broker-contracts.js'
import { appFileUrl, parseAppFileUrl } from '../../broker/policy/app-files-by-url.js'
import { contentTypeFor } from '../../loader/serve/content-type.js'
import { parseRange } from '../../loader/serve/range.js'

export interface AppFileServer {
  /** The URL a verified request for `encodedPath` of `origin`'s files is redirected to. */
  readonly urlFor: (origin: string, encodedPath: string) => string
  /** The response for a request to a URL `urlFor` made; 404 for anything else. */
  readonly serve: (request: Request, broker: Broker) => Promise<Response>
}

/** A server whose URLs only it can make: the MAC key is random per server, so a URL never outlives the process. */
export function createAppFileServer (key: Uint8Array = randomBytes(32)): AppFileServer {
  const mac = (text: string): string => createHmac('sha256', key).update(text).digest('hex')
  return {
    urlFor: (origin, encodedPath) => appFileUrl(origin, encodedPath, mac),
    serve: async (request, broker) => await serveAppFile(request, broker, mac)
  }
}

const notFound = (): Response => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })

/**
 * The file behind an `orivon-file:` URL this process made, with the `Range` handling a media element
 * seeks with. The handle comes from `Broker.fs.open`, which confines the path and checks the `fs` grant
 * again, so a grant withdrawn since the redirect ends the response.
 */
async function serveAppFile (request: Request, broker: Broker, mac: (text: string) => string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const target = parseAppFileUrl(request.url, mac)
  if (target === null) return notFound()
  let handle: Awaited<ReturnType<Broker['fs']['open']>>
  try {
    handle = await broker.fs.open(target.origin, target.path, 'r')
  } catch {
    return notFound()
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await handle.close().catch(() => {})
  }
  try {
    const info = await handle.stat()
    if (!info.isFile) {
      await close()
      return notFound()
    }
    const range = parseRange(request.headers.get('range'), info.size)
    // The URL is reachable to the app's own page, so the response must run nothing if it is navigated to as a document.
    const common = {
      'content-type': contentTypeFor(target.path),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'access-control-allow-origin': target.origin,
      'cross-origin-resource-policy': 'cross-origin'
    }
    if (range.kind === 'unsatisfiable') {
      await close()
      return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${String(info.size)}` } })
    }
    const { start, end } = range.kind === 'none' ? { start: 0, end: info.size - 1 } : range.range
    const headers: Record<string, string> = { ...common, 'content-length': String(info.size === 0 ? 0 : end - start + 1) }
    if (range.kind === 'satisfiable') headers['content-range'] = `bytes ${String(start)}-${String(end)}/${String(info.size)}`
    const status = range.kind === 'satisfiable' ? 206 : 200
    if (request.method === 'HEAD' || info.size === 0) {
      await close()
      return new Response(null, { status, headers })
    }
    const reader = handle.readable({ start, end: end + 1 }).getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull (controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            controller.close()
            await close()
          } else {
            controller.enqueue(chunk.value)
          }
        } catch (error) {
          controller.error(error)
          await close()
        }
      },
      async cancel (reason) {
        await reader.cancel(reason).catch(() => {})
        await close()
      }
    }, { highWaterMark: 0 }) // the default of 1 would pull, and so read the file, before anyone asks
    return new Response(body, { status, headers })
  } catch {
    await close()
    return notFound()
  }
}
