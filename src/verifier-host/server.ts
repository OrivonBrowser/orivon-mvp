// The loopback TLS server every `*.eth` host resolves to. It serves only
// `.eth` hosts, only GET and HEAD, and only bytes the gatherer verified;
// anything it cannot verify becomes one of four error pages.

import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { ResolutionError } from '../resolution/records.js'
import type { GatheredFile } from '../resolution/providers.js'
import { contentTypeFor } from '../loader/serve-content-type.js'
import { parseRange } from '../loader/serve-range.js'
import type { RunCertificate } from './certificate.js'
import { ERROR_PAGE_CSP, pageFor, renderErrorPage } from './error-pages.js'
import type { Sites } from './sites.js'

/** A file up to this size is read and verified whole before its first byte is sent, so a failure is an error page, never half a document. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

const ETH_HOST = /^[\x21-\x7e]+\.eth$/

function hostOf (req: IncomingMessage): string | undefined {
  const header = req.headers.host?.toLowerCase().replace(/:\d+$/, '')
  if (header === undefined || !ETH_HOST.test(header)) return undefined
  // The name the TLS handshake was for must be the name the request is for.
  const servername = (req.socket as TLSSocket).servername
  if (typeof servername === 'string' && servername.toLowerCase() !== header) return undefined
  return header
}

function sendError (res: ServerResponse, host: string, error: unknown): void {
  const failure = error instanceof ResolutionError ? error.failure : 'unavailable'
  const detail = error instanceof Error ? error.message : String(error)
  const { status, html } = renderErrorPage(pageFor(failure), host, detail)
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': ERROR_PAGE_CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  }
  if (failure === 'not-synced') headers['retry-after'] = '10'
  res.writeHead(status, headers).end(html)
}

async function collect (body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function sendBody (res: ServerResponse, status: number, headers: Record<string, string>, file: GatheredFile, length: number): Promise<void> {
  if (length <= MAX_BUFFERED_BYTES) {
    const bytes = await collect(file.body)
    res.writeHead(status, headers).end(bytes)
    return
  }
  // Too large to hold: stream it, and cut the connection on a failure, so
  // Content-Length tells Chromium the response is incomplete.
  res.writeHead(status, headers)
  try {
    for await (const chunk of file.body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
    }
    res.end()
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

async function handle (sites: Sites, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = hostOf(req)
  if (host === undefined) {
    res.writeHead(421, { 'content-type': 'text/plain' }).end('this server answers only .eth names')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('only GET and HEAD')
    return
  }
  const url = new URL(req.url ?? '/', `https://${host}`)
  let file: GatheredFile
  let root: string
  try {
    const { site } = await sites.get(host)
    root = site.root.cid
    file = await site.open(url.pathname)
    if (!url.pathname.endsWith('/') && file.servedPath.endsWith('/index.html') && !url.pathname.endsWith('/index.html')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-cache' }).end()
      return
    }
    const etag = `"${root}"`
    const common: Record<string, string> = {
      'content-type': contentTypeFor(file.servedPath),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      // Revalidated every time: a name can point elsewhere tomorrow, and the root CID says whether it has.
      'cache-control': 'no-cache',
      etag
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, common).end()
      return
    }
    const range = parseRange(req.headers.range ?? null, file.size)
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { ...common, 'content-range': `bytes */${String(file.size)}` }).end()
      return
    }
    if (range.kind === 'satisfiable') file = await site.open(url.pathname, range.range)
    const length = range.kind === 'satisfiable' ? range.range.end - range.range.start + 1 : file.size
    const headers: Record<string, string> = { ...common, 'content-length': String(length) }
    if (range.kind === 'satisfiable') headers['content-range'] = `bytes ${String(range.range.start)}-${String(range.range.end)}/${String(file.size)}`
    const status = range.kind === 'satisfiable' ? 206 : 200
    if (req.method === 'HEAD') {
      res.writeHead(status, headers).end()
      return
    }
    await sendBody(res, status, headers, file, length)
  } catch (error) {
    if (res.headersSent) res.destroy()
    else sendError(res, host, error)
  }
}

export function createEthServer (sites: Sites, certificate: RunCertificate): Server {
  return createServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    void handle(sites, req, res)
  })
}
