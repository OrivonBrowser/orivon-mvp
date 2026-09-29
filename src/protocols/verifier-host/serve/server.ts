// The loopback TLS server every protocol host resolves to: a `.eth` name, or
// `<name>.<scheme>.orivon` for an address. It serves only those hosts, on
// the default port, only GET and HEAD, and only bytes a gatherer verified;
// anything it cannot verify becomes an error page.

import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { ResolutionError } from '../../resolution/records.js'
import type { GatheredFile } from '../../resolution/providers.js'
import { MAX_ADDRESS_NAME } from '../../address.js'
import type { ProtocolAddresses } from '../../address.js'
import type { ProtocolRegistry } from '../../registry.js'
import { contentTypeFor } from '../../../loader/serve/content-type.js'
import { parseRange } from '../../../loader/serve/range.js'
import { CONTENT_ROOT_HEADER, PARTITION_HEADER } from '../../../loader/fetch/content-root.js'
import type { RunCertificate } from './certificate.js'
import { ERROR_PAGE_CSP, renderErrorPage } from './error-pages.js'
import type { Sites } from './sites.js'

/** A file up to this size is read and verified whole before its first byte is sent, so a failure is an error page, never half a document. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/**
 * Every response says the page came from the public internet, whatever
 * loopback address served it, so a protocol's page never gains a local page's
 * reach once Chromium enforces Local Network Access (A252).
 */
const PUBLIC_ADDRESS_CSP = 'treat-as-public-address'

/** Served content, and the error page shown in its place, may be framed only by their own origin: nothing else has a reason to embed either. */
const FRAME_ANCESTORS_SELF_CSP = "frame-ancestors 'self'"

/** A host with no port or the default one: every other port would be another origin for the same name. */
const HOST = /^([\x21-\x39\x3b-\x7e]+)(?::443)?$/

function hostOf (req: IncomingMessage, addresses: ProtocolAddresses): string | undefined {
  const host = HOST.exec(req.headers.host?.toLowerCase() ?? '')?.[1]
  if (host === undefined || !addresses.routesToVerifier(host)) return undefined
  // The name the TLS handshake was for must be the name the request is for.
  const servername = (req.socket as TLSSocket).servername
  if (typeof servername === 'string' && servername.toLowerCase() !== host) return undefined
  return host
}

/** An origin, as the shell names a request's top-level page; nothing else is taken as a partition. */
const PARTITION = /^[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]{1,253}$/

/**
 * The cache this request may use, or undefined for none at all:
 * - the one the shell named for the request's top-level page;
 * - the name's own, for a request no page started (the browser's favicon
 *   fetch, the loader), which Chromium marks `Sec-Fetch-Site: none`, or one
 *   the name's own worker made, marked `same-origin`: neither mark can be
 *   forged, and the shell strips any partition a frameless request set;
 * - otherwise none: the request is served, and nothing it fetched is kept.
 */
function partitionOf (req: IncomingMessage, host: string): string | undefined {
  const named = req.headers[PARTITION_HEADER]
  if (typeof named === 'string' && PARTITION.test(named)) return named
  const site = req.headers['sec-fetch-site']
  return site === 'none' || site === 'same-origin' ? `https://${host}` : undefined
}

/** The path of an origin-form request target. `//x/y` would read as an authority, so it is refused, not reinterpreted. */
function pathOf (target: string | undefined, host: string): URL | undefined {
  if (target === undefined || !target.startsWith('/') || target.startsWith('//')) return undefined
  try {
    return new URL(target, `https://${host}`)
  } catch {
    return undefined
  }
}

function sendError (res: ServerResponse, shown: string, error: unknown): void {
  const failure = error instanceof ResolutionError ? error.failure : 'unavailable'
  const detail = error instanceof Error ? error.message : String(error)
  const { status, html } = renderErrorPage(failure, shown, detail)
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `${ERROR_PAGE_CSP}; ${PUBLIC_ADDRESS_CSP}; ${FRAME_ANCESTORS_SELF_CSP}`,
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

/** True once the socket can take more, false if the client went away first: a closed socket never drains. */
async function drained (res: ServerResponse): Promise<boolean> {
  return await new Promise((resolve) => {
    const settle = (writable: boolean): void => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      resolve(writable)
    }
    const onDrain = (): void => { settle(true) }
    const onClose = (): void => { settle(false) }
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

async function sendBody (res: ServerResponse, status: number, headers: Record<string, string>, file: GatheredFile, length: number): Promise<void> {
  if (length <= MAX_BUFFERED_BYTES) {
    const bytes = await collect(file.body)
    res.writeHead(status, headers).end(bytes)
    return
  }
  // Too large to hold: stream it, and cut the connection on a failure, so
  // Content-Length tells Chromium the response is incomplete. Leaving the
  // loop early ends the body's generator, which releases its blocks.
  res.writeHead(status, headers)
  try {
    for await (const chunk of file.body) {
      if (res.destroyed) break
      if (!res.write(chunk) && !await drained(res)) break
    }
    res.end()
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * `https://ipfs.orivon/<name>/<path>`, where a typed or linked `ipfs://` address
 * lands: redirected to the origin of the name's canonical spelling, so one
 * site has one origin however its address was written. No page runs here.
 */
function redirectToCanonical (registry: ProtocolRegistry, scheme: string, url: URL, res: ServerResponse): void {
  const [, written = '', path = '/'] = /^\/([^/]*)(\/.*)?$/.exec(url.pathname) ?? []
  const shown = `${scheme}://${written.slice(0, MAX_ADDRESS_NAME)}`
  try {
    const decoded = decodeURIComponent(written)
    // Any page can send one of these, and a protocol's parser may be slow on a long string.
    if (decoded.length > MAX_ADDRESS_NAME) throw new ResolutionError('invalid-name', `${scheme}:// names are at most ${String(MAX_ADDRESS_NAME)} characters`)
    const name = registry.canonicalName(scheme, decoded)
    const origin = registry.addresses.originFor(scheme, name)
    if (origin === undefined) throw new ResolutionError('unsupported', `${scheme}://${name} is too long, or not lowercase, to be a host of its own`)
    res.writeHead(301, { location: `${origin}${path}${url.search}`, 'cache-control': 'no-store', 'content-security-policy': `${ERROR_PAGE_CSP}; ${PUBLIC_ADDRESS_CSP}; ${FRAME_ANCESTORS_SELF_CSP}` }).end()
  } catch (error) {
    sendError(res, shown, error instanceof URIError ? new ResolutionError('invalid-name', `${shown} is not a valid address`) : error)
  }
}

async function handle (registry: ProtocolRegistry, sites: Sites, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = hostOf(req, registry.addresses)
  if (host === undefined || (registry.addresses.servedName(host) === undefined && registry.addresses.schemeEndpoint(host) === undefined)) {
    res.writeHead(421, { 'content-type': 'text/plain' }).end("this server answers only the names and addresses Orivon's protocols serve")
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end('only GET and HEAD')
    return
  }
  const url = pathOf(req.url, host)
  if (url === undefined) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('not a path this server serves')
    return
  }
  const scheme = registry.addresses.schemeEndpoint(host)
  if (scheme !== undefined) {
    redirectToCanonical(registry, scheme, url, res)
    return
  }
  const shown = registry.addresses.displayOrigin(`https://${host}`)
  // Whatever this request set going stops when its client leaves.
  const left = new AbortController()
  res.once('close', () => { left.abort(new Error('the client went away')) })
  let file: GatheredFile
  let root: string
  try {
    const { site } = await sites.get(host, partitionOf(req, host))
    root = site.root.cid
    const etag = `"${root}"`
    // One install reads one root: a request naming another means the name moved on mid-load.
    const expected = req.headers[CONTENT_ROOT_HEADER]
    if (typeof expected === 'string' && expected !== root) {
      res.writeHead(409, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(`${host} now points to ${root}, not ${expected}`)
      return
    }
    // Before any file is opened: an unchanged root answers with no gateway asked.
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' }).end()
      return
    }
    file = await site.open(url.pathname, undefined, left.signal)
    if (!url.pathname.endsWith('/') && file.servedPath.endsWith('/index.html') && !url.pathname.endsWith('/index.html')) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-cache' }).end()
      return
    }
    const common: Record<string, string> = {
      'content-type': contentTypeFor(file.servedPath),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      // Revalidated every time: a name can point elsewhere tomorrow, and the root CID says whether it has.
      'cache-control': 'no-cache',
      'content-security-policy': `${PUBLIC_ADDRESS_CSP}; ${FRAME_ANCESTORS_SELF_CSP}`,
      etag
    }
    const range = parseRange(req.headers.range ?? null, file.size)
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { ...common, 'content-range': `bytes */${String(file.size)}` }).end()
      return
    }
    if (range.kind === 'satisfiable') file = await site.open(url.pathname, range.range, left.signal)
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
    else sendError(res, shown, error)
  }
}

export function createVerifierServer (registry: ProtocolRegistry, sites: Sites, certificate: RunCertificate): Server {
  return createServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    // A rejection left unobserved would end the host process, and with it every protocol's page.
    handle(registry, sites, req, res).catch((error: unknown) => {
      console.error('[verifier] request failed:', error)
      if (res.headersSent) res.destroy()
      else res.writeHead(500, { 'content-type': 'text/plain' }).end('the verifier failed on this request')
    })
  })
}
