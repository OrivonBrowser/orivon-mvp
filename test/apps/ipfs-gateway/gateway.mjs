// A trustless IPFS gateway for the end-to-end suite, serving sites whose
// DAGs are built when it starts. It speaks `?format=raw` for blocks,
// `?format=ipns-record` for the signed IPNS records it publishes, and the
// JSON form of DNS-over-HTTPS for DNSLink TXT records, logs every request,
// and can flip a byte in any file's block so a test can watch the verifier
// refuse it. Plain HTTP on loopback, on a port the OS picks.
import { createServer } from 'node:http'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { importer } from 'ipfs-unixfs-importer'
import { createIPNSRecord, marshalIPNSRecord } from 'ipns'
import { base36 } from 'multiformats/bases/base36'
import { CID } from 'multiformats/cid'

const HOST = '127.0.0.1'

/**
 * @param {Record<string, Record<string, string | Uint8Array> | string>} sites site name -> path -> content (text, or bytes for a binary file); a string is a site whose root is that one file
 * @param {{ dnslinks?: Record<string, string>, ipnsKeys?: string[], blockDelayMs?: number, hang?: boolean }} [options] `dnslinks`: DNS name -> the site whose root its DNSLink names; `ipnsKeys`: sites to publish under a fresh signed IPNS key each (`keys` names them); `blockDelayMs`: how long each block answer waits, as a slow gateway's do; `hang`: answer nothing at all, as a dead gateway behind a proxy does
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
    if (typeof contents === 'string') {
      for await (const entry of importer([{ content: new TextEncoder().encode(contents) }], store, { cidVersion: 1, rawLeaves: true })) roots[site] = entry.cid.toString()
      continue
    }
    const candidates = Object.entries(contents).map(([path, content]) => ({ path, content: typeof content === 'string' ? new TextEncoder().encode(content) : content }))
    for await (const entry of importer(candidates, store, { wrapWithDirectory: true, cidVersion: 1, rawLeaves: true })) {
      if (entry.path === '') roots[site] = entry.cid.toString()
      else files.set(`${site}/${entry.path}`, entry.cid.toString())
    }
  }

  /** @type {Record<string, string>} site -> the IPNS key naming it */
  const keys = {}
  /** @type {Map<string, Uint8Array>} */
  const ipnsRecords = new Map()
  /** @type {Map<string, { key: Awaited<ReturnType<typeof generateKeyPair>>, name: string, sequence: bigint }>} site -> the key that names it, and the newest record's sequence */
  const ipnsState = new Map()
  for (const site of options.ipnsKeys ?? []) {
    const key = await generateKeyPair('Ed25519')
    const name = CID.createV1(0x72, key.publicKey.toMultihash()).toString(base36)
    ipnsRecords.set(name, marshalIPNSRecord(await createIPNSRecord(key, `/ipfs/${roots[site]}`, 1n, 60 * 60 * 1000)))
    ipnsState.set(site, { key, name, sequence: 1n })
    keys[site] = name
  }

  const requests = []
  const tampered = new Set()
  /** @type {Map<string, { status: number, times: number }>} block -> the next answers it fails with */
  const failures = new Map()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    requests.push(`${url.pathname}${url.search}`)
    if (options.hang === true) return
    const ipns = /^\/ipns\/([^/]+)$/.exec(url.pathname)
    if (ipns !== null && url.searchParams.get('format') === 'ipns-record') {
      const record = ipnsRecords.get(ipns[1])
      if (record === undefined) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, { 'content-type': 'application/vnd.ipfs.ipns-record' }).end(Buffer.from(record))
      return
    }
    const raw = /^\/ipfs\/([^/]+)$/.exec(url.pathname)
    if (raw !== null && url.searchParams.get('format') === 'raw') {
      const key = CID.parse(raw[1]).toString()
      const block = blocks.get(key)
      if (block === undefined) { res.writeHead(404).end('not found'); return }
      const scheduled = failures.get(key)
      if (scheduled !== undefined && scheduled.times > 0) {
        scheduled.times -= 1
        res.writeHead(scheduled.status).end('unwell')
        return
      }
      const body = Buffer.from(block)
      if (tampered.has(key)) body[body.length - 1] ^= 0x01
      const answer = () => { res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw' }).end(body) }
      if (options.blockDelayMs === undefined) answer()
      else setTimeout(answer, options.blockDelayMs)
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
    keys,
    requests,
    /** Publishes a newer record for the key that names `site`, pointing at `target`'s root: the name is republished, as every update of a published app is. */
    republish: async (site, target) => {
      const state = ipnsState.get(site)
      if (state === undefined) throw new Error(`${site} has no IPNS key`)
      state.sequence += 1n
      ipnsRecords.set(state.name, marshalIPNSRecord(await createIPNSRecord(state.key, `/ipfs/${roots[target]}`, state.sequence, 60 * 60 * 1000)))
    },
    /** The CID of the block holding this site's file, which is what a refusal of it names. */
    blockOf: (site, path) => {
      const cid = files.get(`${site}/${path}`)
      if (cid === undefined) throw new Error(`no file ${path} in ${site}`)
      return cid
    },
    /** Serve this site's file with one byte flipped from now on. */
    tamper: (site, path) => {
      const cid = files.get(`${site}/${path}`)
      if (cid === undefined) throw new Error(`no file ${path} in ${site}`)
      tampered.add(cid)
    },
    /** Answer this site's file with `status` for its next `times` requests, then serve it: a gateway that is briefly unwell. */
    failNext: (site, path, status, times = 1) => {
      const cid = files.get(`${site}/${path}`)
      if (cid === undefined) throw new Error(`no file ${path} in ${site}`)
      failures.set(cid, { status, times })
    },
    /** Gone at once, as a dead gateway is: open connections are cut, or a client that keeps reusing one holds close() open. */
    close: async () => {
      const closed = new Promise((resolve) => { server.close(() => { resolve(undefined) }) })
      server.closeAllConnections()
      await closed
    }
  }
}
