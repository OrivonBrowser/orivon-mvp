// A trustless IPFS gateway for the end-to-end suite, serving sites whose
// DAGs are built when it starts. It speaks `?format=raw` for blocks and the
// JSON form of DNS-over-HTTPS for DNSLink TXT records, logs every request,
// and can flip a byte in any file's block so a test can watch the verifier
// refuse it. Plain HTTP on loopback, on a port the OS picks.
import { createServer } from 'node:http'
import { importer } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'

const HOST = '127.0.0.1'

/**
 * @param {Record<string, Record<string, string>>} sites site name -> path -> content
 * @param {{ dnslinks?: Record<string, string> }} [options] DNS name -> the site whose root its DNSLink names
 */
export async function startFixtureGateway (sites, options = {}) {
  /** @type {Map<string, Uint8Array>} */
  const blocks = new Map()
  /** @type {Record<string, string>} */
  const roots = {}
  /** @type {Map<string, string>} site/path -> the CID of that file's root block */
  const files = new Map()
  const store = { put: async (cid, bytes) => { blocks.set(cid.toString(), bytes); return cid } }

  for (const [site, contents] of Object.entries(sites)) {
    const candidates = Object.entries(contents).map(([path, content]) => ({ path, content: new TextEncoder().encode(content) }))
    for await (const entry of importer(candidates, store, { wrapWithDirectory: true, cidVersion: 1, rawLeaves: true })) {
      if (entry.path === '') roots[site] = entry.cid.toString()
      else files.set(`${site}/${entry.path}`, entry.cid.toString())
    }
  }

  const requests = []
  const tampered = new Set()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    requests.push(`${url.pathname}${url.search}`)
    const raw = /^\/ipfs\/([^/]+)$/.exec(url.pathname)
    if (raw !== null && url.searchParams.get('format') === 'raw') {
      const key = CID.parse(raw[1]).toString()
      const block = blocks.get(key)
      if (block === undefined) { res.writeHead(404).end('not found'); return }
      const body = Buffer.from(block)
      if (tampered.has(key)) body[body.length - 1] ^= 0x01
      res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw' }).end(body)
      return
    }
    if (url.pathname === '/dns-query') {
      const name = url.searchParams.get('name') ?? ''
      const site = options.dnslinks?.[name.replace(/^_dnslink\./, '')]
      const answer = site === undefined ? [] : [{ type: 16, data: `"dnslink=/ipfs/${roots[site]}"` }]
      res.writeHead(200, { 'content-type': 'application/dns-json' }).end(JSON.stringify({ Status: 0, Answer: answer }))
      return
    }
    res.writeHead(400).end('not a trustless request')
  })
  await new Promise((resolve) => { server.listen(0, HOST, resolve) })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())

  return {
    url: `http://${HOST}:${String(port)}`,
    roots,
    requests,
    /** Serve this site's file with one byte flipped from now on. */
    tamper: (site, path) => {
      const cid = files.get(`${site}/${path}`)
      if (cid === undefined) throw new Error(`no file ${path} in ${site}`)
      tampered.add(cid)
    },
    close: async () => { await new Promise((resolve) => { server.close(() => { resolve(undefined) }) }) }
  }
}
