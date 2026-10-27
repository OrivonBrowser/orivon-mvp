/**
 * The parts of a Bee node's API this job uses (Bee 2.8: `openapi/Swarm.yaml`), each answered as plain data.
 * Every request carries a timeout; a refusal throws a `BeeError` with the HTTP status.
 */
import { openAsBlob } from 'node:fs'
import { hexToBytes } from 'viem'

export class BeeError extends Error {
  /** @param {string} message @param {number} status */
  constructor (message, status) {
    super(message)
    this.status = status
  }
}

/** Bee's 402 on an upload: the immutable batch has no free slot left in the bucket a chunk falls into. */
export class BatchFullError extends BeeError {}

/**
 * @typedef {{ id: string, found: boolean, usable: boolean, depth: number, bucketDepth: number, fill: number, ttl: number, immutable: boolean, label: string }} Stamp
 * ttl is the seconds the batch has left, Infinity when the chain price is zero; fill is utilization / 2^(depth - bucketDepth)
 */

/** @param {number} ms @returns {Promise<void>} */
export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The reason a request never got an answer, as Node reports it: the cause's code (ECONNREFUSED), else the message. @param {any} error @returns {string} */
export const reachFailure = (error) => String(error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error)

/** @param {string} id @param {any} body @returns {Stamp} */
function stampOf (id, body) {
  const depth = Number(body.depth)
  const bucketDepth = Number(body.bucketDepth ?? 16)
  const fill = body.utilization !== undefined ? Number(body.utilization) / 2 ** (depth - bucketDepth) : Number(body.utilizationRatio ?? 0)
  const ttl = Number(body.batchTTL)
  return { id, found: true, usable: body.usable === true, depth, bucketDepth, fill, ttl: ttl < 0 ? Infinity : ttl, immutable: body.immutableFlag === true, label: String(body.label ?? '') }
}

/**
 * @param {{ api: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void> }} config
 */
export function beeClient ({ api, fetchFn = fetch, sleep = defaultSleep }) {
  const base = api.replace(/\/+$/, '')

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ headers?: Record<string, string>, body?: BodyInit, timeout?: number }} [init]
   * @returns {Promise<Response>}
   */
  const send = async (method, path, { headers = {}, body, timeout = 120_000 } = {}) => {
    try {
      return await fetchFn(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeout) })
    } catch (error) {
      throw new BeeError(`cannot reach Bee at ${base} (${reachFailure(error)})`, 0)
    }
  }

  /**
   * A request whose failure is an error. `retries` waits and tries again on the answers Bee gives when it is busy with
   * another transaction (429) or still syncing (503); `full` reads a 402 as a batch with no room left.
   * @param {string} method
   * @param {string} path
   * @param {{ headers?: Record<string, string>, body?: BodyInit, timeout?: number, retries?: number, full?: boolean }} [init]
   * @returns {Promise<Response>}
   */
  async function call (method, path, init = {}) {
    for (let attempt = 1; ; attempt++) {
      const response = await send(method, path, init)
      if (response.ok) return response
      const text = await response.text().catch(() => '')
      if ((response.status === 429 || response.status === 503) && attempt <= (init.retries ?? 0)) {
        await sleep(15_000 * attempt)
        continue
      }
      let detail = text.slice(0, 200)
      try { detail = String(JSON.parse(text).message ?? detail) } catch { /* not JSON */ }
      const message = `Bee ${method} ${path.split('?')[0]} answered ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`
      throw init.full === true && response.status === 402 ? new BatchFullError(message, 402) : new BeeError(message, response.status)
    }
  }

  /** @param {string} method @param {string} path @param {Parameters<typeof call>[2]} [init] @returns {Promise<any>} */
  const json = async (method, path, init) => (await call(method, path, init)).json()
  /** @param {string} id */
  const batchHeader = (id) => ({ 'swarm-postage-batch-id': id })

  return {
    /** @returns {Promise<{ address: string, bzz: bigint, xdai: bigint }>} the node's wallet: BZZ in PLUR (1 BZZ = 1e16), xDAI in wei */
    async wallet () {
      const body = await json('GET', '/wallet')
      return { address: String(body.walletAddress), bzz: BigInt(body.bzzBalance ?? 0), xdai: BigInt(body.nativeTokenBalance ?? 0) }
    },
    /**
     * Why the node cannot be used yet, or null when it can: Bee answers /readiness only once it has started, and a node
     * with no peers cannot push a chunk anywhere.
     * @returns {Promise<string | null>}
     */
    async notReady () {
      const readiness = await send('GET', '/readiness', { timeout: 30_000 })
      await readiness.body?.cancel()
      if (!readiness.ok) return `Bee answered ${String(readiness.status)} on /readiness: it is still starting`
      const connected = Number((await json('GET', '/topology', { timeout: 30_000 })).connected ?? 0)
      return connected > 0 ? null : 'Bee has no peers yet'
    },
    /** @returns {Promise<string>} the node's Ethereum address */
    async ethereumAddress () {
      return String((await json('GET', '/addresses')).ethereum)
    },
    /** @returns {Promise<bigint>} PLUR per chunk per block */
    async price () {
      return BigInt((await json('GET', '/chainstate')).currentPrice)
    },
    /**
     * A batch as the node sees it. A batch neither `/stamps` nor `/batches` knows is `found: false` (expired or never
     * existed); one that is known but not usable (still confirming) is `found: true, usable: false`.
     * @param {string} id
     * @returns {Promise<Stamp>}
     */
    async stamp (id) {
      const response = await send('GET', `/stamps/${id}`)
      if (response.status === 200) return stampOf(id, await response.json())
      await response.body?.cancel()
      if (response.status === 400) return { id, found: true, usable: false, depth: 0, bucketDepth: 16, fill: 0, ttl: 0, immutable: true, label: '' }
      if (response.status !== 404) throw new BeeError(`Bee GET /stamps/${id} answered ${String(response.status)}`, response.status)
      const onChain = await send('GET', `/batches/${id}`)
      await onChain.body?.cancel()
      return { id, found: onChain.status !== 404, usable: false, depth: 0, bucketDepth: 16, fill: 0, ttl: 0, immutable: true, label: '' }
    },
    /**
     * Buys an immutable batch: `amount` is PLUR per chunk, the cost amount x 2^depth. Waits for the transaction.
     * @param {{ amount: bigint, depth: number, label: string }} batch
     * @returns {Promise<string>} the batch id
     */
    async buyBatch ({ amount, depth, label }) {
      const body = await json('POST', `/stamps/${String(amount)}/${String(depth)}?label=${encodeURIComponent(label)}`, { headers: { immutable: 'true' }, timeout: 900_000, retries: 3 })
      return String(body.batchID)
    },
    /** @param {string} id @param {bigint} amount PLUR per chunk added */
    async topUp (id, amount) {
      await call('PATCH', `/stamps/topup/${id}/${String(amount)}`, { timeout: 900_000, retries: 3 })
    },
    /** @param {string} id @param {number} depth the new, larger depth */
    async dilute (id, depth) {
      await call('PATCH', `/stamps/dilute/${id}/${String(depth)}`, { timeout: 900_000, retries: 3 })
    },
    /** @returns {Promise<number>} a new upload tag */
    async createTag () {
      return Number((await json('POST', '/tags')).uid)
    },
    /** @param {number} uid @returns {Promise<{ split: number, seen: number, synced: number }>} */
    async tag (uid) {
      const body = await json('GET', `/tags/${String(uid)}`)
      return { split: Number(body.split ?? 0), seen: Number(body.seen ?? 0), synced: Number(body.synced ?? 0) }
    },
    /**
     * A site as a collection: the tar is sent from its file, and the chunks are pushed to the network in the background
     * under `tag`. Never sends an error document: Orivon refuses a manifest that names one.
     * @param {{ file: string, batch: string, tag: number }} upload
     * @returns {Promise<string>} the root reference
     */
    async uploadSite ({ file, batch, tag }) {
      const headers = { ...batchHeader(batch), 'content-type': 'application/x-tar', 'swarm-collection': 'true', 'swarm-index-document': 'index.html', 'swarm-tag': String(tag), 'swarm-deferred-upload': 'true' }
      return String((await json('POST', '/bzz', { headers, body: await openAsBlob(file), timeout: 1_800_000, full: true })).reference)
    },
    /**
     * A signed single-owner chunk, pushed to the network before the request answers.
     * @param {{ owner: string, identifier: string, signature: string, data: string, batch: string }} soc
     * @returns {Promise<string>} the chunk's address
     */
    async uploadSoc ({ owner, identifier, signature, data, batch }) {
      const body = await json('POST', `/soc/${owner}/${identifier}?sig=${signature}`, { headers: { ...batchHeader(batch), 'content-type': 'application/octet-stream' }, body: hexToBytes(`0x${data}`), full: true })
      return String(body.reference)
    },
    /**
     * Creates the feed's root manifest: the reference ENS points at. The same owner and topic always give the same one.
     * @param {{ owner: string, topic: string, batch: string }} feed
     * @returns {Promise<string>}
     */
    async createFeed ({ owner, topic, batch }) {
      return String((await json('POST', `/feeds/${owner}/${topic}?type=sequence`, { headers: batchHeader(batch), full: true })).reference)
    },
    /**
     * The newest update index the node's own lookup finds (it stops at the first missing index), null for a feed
     * with no update.
     * @param {{ owner: string, topic: string }} feed
     * @returns {Promise<number | null>}
     */
    async feedIndex ({ owner, topic }) {
      const response = await send('GET', `/feeds/${owner}/${topic}`, { headers: { 'swarm-only-root-chunk': 'true' } })
      await response.body?.cancel()
      if (response.status === 404) return null
      if (!response.ok) throw new BeeError(`Bee GET /feeds answered ${String(response.status)}`, response.status)
      const header = response.headers.get('swarm-feed-index')
      if (header === null || !/^[0-9a-fA-F]{1,16}$/.test(header)) throw new BeeError('Bee GET /feeds sent no swarm-feed-index', 502)
      return Number(BigInt(`0x${header}`))
    },
    /**
     * Whether the chunk of a feed update exists in the network.
     * @param {{ owner: string, identifier: string }} chunk
     * @returns {Promise<boolean>}
     */
    async socExists ({ owner, identifier }) {
      const response = await send('GET', `/soc/${owner}/${identifier}`, { headers: { 'swarm-chunk-retrieval-timeout': '10s' } })
      await response.body?.cancel()
      if (response.status === 404) return false
      if (!response.ok) throw new BeeError(`Bee GET /soc answered ${String(response.status)}`, response.status)
      return true
    }
  }
}
