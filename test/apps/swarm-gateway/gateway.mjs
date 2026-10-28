// A Bee-API endpoint for the end-to-end suite: it holds the chunks of the
// sites and feeds a test builds, and answers `/chunks/<hex>` like a node does,
// and `/bytes/<hex>` with the joined bytes under a chunk.
// `/feeds/<owner>/<topic>` answers with the newest index header when asked to,
// and with a 501 otherwise, as a node without that route does. It logs every
// request, can flip a byte of any chunk, can answer a chunk with a redirect
// as a content filter does, can hold every chunk answer back until a test lets
// them go so a load stays open as long as the test needs, and listens on
// loopback on a port the OS picks.
import { createServer } from 'node:http'
import { buildFeedManifest, buildSite, feedKey, legacyUpdate, ownerOf, signFeedUpdate, buildFile } from './encode.mjs'

const HOST = '127.0.0.1'

/**
 * The bytes under the chunk at `address`, joined as a node's `/bytes` route joins them; undefined when a chunk is
 * missing or `skip` says so. Each chunk joined is added to `seen`.
 * @param {Map<string, Uint8Array>} store @param {string} address @param {(address: string) => boolean} skip @param {string[]} seen
 * @returns {Buffer | undefined}
 */
function joined (store, address, skip, seen) {
  const chunk = store.get(address)
  if (chunk === undefined || skip(address)) return undefined
  seen.push(address)
  const span = Buffer.from(chunk.subarray(0, 8))
  if (span[7] > 128) span[7] = 0
  const size = Number(span.readBigUInt64LE(0))
  const payload = Buffer.from(chunk.subarray(8))
  if (size <= 4096) return payload.subarray(0, size)
  const parts = []
  for (let i = 0, at = 0; at < size; i++) {
    const part = joined(store, payload.subarray(i * 32, (i + 1) * 32).toString('hex'), skip, seen)
    if (part === undefined) return undefined
    parts.push(part)
    at += part.length
  }
  return Buffer.concat(parts)
}

/**
 * @param {{ feedsRoute?: boolean, tamperAll?: boolean, holdChunks?: boolean }} [options] `feedsRoute`: answer `/feeds/...` with the newest index (default: a 501); `tamperAll`: flip a byte of every chunk served; `holdChunks`: keep every chunk answer back until `releaseChunks()`, as a node that is slow to answer does
 */
export async function startSwarmFixture (options = {}) {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map()
  /** @type {Map<string, bigint>} owner/topic -> the newest index published */
  const newest = new Map()
  const requests = []
  const tampered = new Set()
  const redirected = new Set()
  let tamperAll = options.tamperAll === true
  let holding = options.holdChunks === true
  /** @type {Array<() => void>} */
  const held = []
  let answered = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    requests.push(url.pathname)
    const chunk = /^\/chunks\/([0-9a-f]{64})$/.exec(url.pathname)
    if (chunk !== null) {
      const bytes = store.get(chunk[1])
      if (bytes === undefined) { res.writeHead(404).end('not found'); return }
      if (redirected.has(chunk[1])) { res.writeHead(302, { location: `http://${HOST}/forbidden` }).end(); return }
      const body = Buffer.from(bytes)
      if (tamperAll || tampered.has(chunk[1])) body[body.length - 1] ^= 0x01
      const answer = () => { answered++; res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body) }
      if (holding) held.push(answer)
      else answer()
      return
    }
    const subtree = /^\/bytes\/([0-9a-f]{64})$/.exec(url.pathname)
    if (subtree !== null) {
      // A chunk switched to tamper or redirect is not joined, so its leaf is asked for alone and the switch applies there.
      const seen = []
      const body = joined(store, subtree[1], (address) => tampered.has(address) || redirected.has(address), seen)
      if (body === undefined) { res.writeHead(404).end('not found'); return }
      if (tamperAll) body[Math.min(4096, body.length - 1)] ^= 0x01
      const answer = () => { answered += seen.length; res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body) }
      if (holding) held.push(answer)
      else answer()
      return
    }
    const feed = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(url.pathname)
    if (feed !== null) {
      const index = newest.get(feedKey(feed[1], feed[2]))
      if (options.feedsRoute !== true || index === undefined) { res.writeHead(options.feedsRoute === true ? 404 : 501).end('no'); return }
      res.writeHead(200, { 'content-type': 'application/json', 'swarm-feed-index': index.toString(16).padStart(16, '0') }).end('{}')
      return
    }
    res.writeHead(400).end('not a Bee request')
  })
  await new Promise((resolve) => { server.listen(0, HOST, resolve) })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())

  return {
    url: `http://${HOST}:${String(port)}`,
    store,
    requests,
    /** Stores a site and returns its root reference. @param {Record<string, string | Uint8Array>} files path -> content */
    addSite: (files, siteOptions = {}) => buildSite(files, store, siteOptions),
    /**
     * A feed owned by the key: its manifest's reference, and `publish`, which stores the next update naming `target`.
     * @param {{ privateKey: `0x${string}`, topic: string }} feed
     */
    addFeed: (feed) => {
      const owner = ownerOf(feed.privateKey)
      const key = feedKey(owner, feed.topic)
      return {
        owner,
        topic: feed.topic,
        manifest: buildFeedManifest({ owner, topic: feed.topic }, store),
        /** @param {string} target the reference the update names @returns {Promise<bigint>} its index */
        publish: async (target) => {
          const index = (newest.get(key) ?? -1n) + 1n
          const update = await signFeedUpdate({ privateKey: feed.privateKey, topic: feed.topic, index, wrapped: legacyUpdate(target, 1_700_000_000n + index) })
          store.set(update.address, update.chunk)
          newest.set(key, index)
          return index
        }
      }
    },
    /** How many chunks it has answered with their bytes so far, those joined into a `/bytes` answer included. */
    answeredChunks: () => answered,
    /** Answer the chunks held back so far, and every later one at once. */
    releaseChunks: () => { holding = false; for (const answer of held.splice(0)) answer() },
    /** Stores one file and returns its reference. */
    addFile: (bytes) => buildFile(bytes, store).ref,
    /** Serve this chunk with one byte flipped from now on. */
    tamper: (address) => { tampered.add(address) },
    /** Serve every chunk with one byte flipped, or stop. */
    setTamperAll: (on) => { tamperAll = on },
    /** Answer this chunk with a redirect, as a content filter does. */
    redirect: (address) => { redirected.add(address) },
    close: async () => {
      const closed = new Promise((resolve) => { server.close(() => { resolve(undefined) }) })
      server.closeAllConnections()
      await closed
    }
  }
}
