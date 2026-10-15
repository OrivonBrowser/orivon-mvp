// The IPFS DataGatherer: from a name's records to a mounted site whose every
// served byte was verified, with the DDOC report of its mount.

import { ResolutionError } from '../resolution/records.js'
import type { NameRecord, PointerStep } from '../resolution/records.js'
import type { DataGatherer, DdocReport, MountedSite, Refusal } from '../resolution/providers.js'
import { BlockSource } from './blockstore.js'
import { BlockCache, NO_BLOCK_MEMORY } from '../gateways/cache.js'
import type { ResolveTxt } from './dnslink.js'
import { GatewayPool } from '../gateways/gateways.js'
import type { Fetch } from '../gateways/gateways.js'
import { resolveIpnsKey } from './ipns.js'
import type { SequenceStore, VerifiedIpnsRecord } from './ipns.js'
import { retryOn } from './block-fetch.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { IpfsLimits } from './limits.js'
import { retryWhileWanted } from '../gateways/fetch-passes.js'
import type { PatientRetry } from '../gateways/fetch-passes.js'
import type { RoutePace } from '../route-pace.js'
import { followPointer } from './pointers.js'
import type { PointerResolvers } from './pointers.js'
import { openPath } from './unixfs.js'
import { checkCidAccepted } from './verify-block.js'

export interface IpfsGathererOptions {
  readonly fetch: Fetch
  readonly gateways: readonly string[]
  /** w3name-style services, asked for an IPNS record after the gateways; a function is read at each lookup, for a list the person can change while the host runs. */
  readonly ipnsNameServices?: readonly string[] | (() => readonly string[])
  readonly resolveTxt: ResolveTxt
  readonly ipnsSequences: SequenceStore
  readonly limits?: Partial<IpfsLimits>
  /**
   * `gateways` is the one node Orivon runs on this computer, not public gateways: its mounts say so, a bad answer
   * costs it a pause rather than the session, a 5xx is its answer that it found nothing, its one endpoint takes the
   * concurrency three gateways would, and its waits are sized for the lookups it makes itself.
   */
  readonly localNode?: boolean
  /** The route these requests travel, which stretches every wait the limits below were written for. Direct when unset. */
  readonly route?: RoutePace
  /**
   * For a local node that keeps blocks between runs: the header and the key a mount in a partition sends it, on every
   * request to `gateways` and to no other source, so the node's store holds what each partition fetched apart from
   * every other's and never a plain origin. A mount with no partition sends none, and the node then keeps nothing.
   */
  readonly storeKey?: { readonly header: string, readonly key: (partition: string) => string }
}

/** What the one endpoint of a local node takes at once: what three gateways would, since each block it lacks is a lookup of its own. */
export const LOCAL_NODE_CONCURRENCY = 12
/** How long a local node that sent a bad block is not asked again. */
export const LOCAL_NODE_QUARANTINE_MS = 30_000
/**
 * How long a block may take from a local node. Measured against the real node: a block with a provider arrives in
 * 0.3 to 2.3 s, and a lookup that finds nothing ends in 25 to 93 s with a 404 or 504. Forty-five seconds is about
 * twenty times the slowest success and ends a hopeless lookup well before its worst case; the node remembers an
 * empty lookup for 30 s, so asking again within that answers at once.
 */
export const LOCAL_NODE_BLOCK_TIMEOUT_MS = 45_000
/**
 * How long the real node holds on to a failed lookup, and so how long a block it could not give is not asked for
 * again: it remembers an empty lookup for about 30 s and answers it again at once, and a peer that cuts the first
 * handshake makes it mark every provider bad for 30 s, answering a misleading instant 404 meanwhile. Two seconds
 * more than that, so the retry never lands on the last moment of the memory.
 */
export const LOCAL_NODE_MISS_MEMORY_MS = 32_000
/**
 * A block the node could not give is asked for again, a file's page loading whole instead of missing its
 * stylesheet. Twice: a lookup the memory made fail instantly is cured by one wait; a second covers a network
 * that only just connected. A retry starts no later than 90 s after the first try began: two quick failures
 * (0 s, 32 s, 64 s) get both retries, a first try that spent its whole 45 s timeout gets one (45 s + 32 s),
 * and no file waits longer than about two minutes (77 s + a last 45 s) before it is called missing.
 */
export const LOCAL_NODE_BLOCK_RETRY: PatientRetry = { waitMs: LOCAL_NODE_MISS_MEMORY_MS, maxRetries: 2, startByMs: 90_000 }
/** How long an IPNS record may take from a local node on a direct connection (about 10 s measured): short enough that a name service is asked within a mount's 25 s when the node has nothing. A slower route stretches it, as it does every wait here. */
export const LOCAL_NODE_RECORD_TIMEOUT_MS = 15_000

const LOADABLE = new Set(['ipfs', 'ipns-key', 'dnslink'])

function loadable (records: readonly NameRecord[]): NameRecord | undefined {
  return records.find((r) => LOADABLE.has(r.pointer.kind))
}

export function createIpfsGatherer (options: IpfsGathererOptions): DataGatherer {
  const local = options.localNode === true
  const limits: IpfsLimits = { ...DEFAULT_LIMITS, ...(local && { perGatewayConcurrency: LOCAL_NODE_CONCURRENCY, blockTimeoutMs: LOCAL_NODE_BLOCK_TIMEOUT_MS, recordTimeoutMs: LOCAL_NODE_RECORD_TIMEOUT_MS, blockRetry: LOCAL_NODE_BLOCK_RETRY }), ...options.limits }
  const pool = new GatewayPool(options.gateways, limits.perGatewayConcurrency, Date.now, { ...(local && { lieQuarantineMs: LOCAL_NODE_QUARANTINE_MS, serverErrorsAreAnswers: true }), ...(options.route !== undefined && { route: options.route }) })
  const cache = new BlockCache()
  const nodeOrigins = new Set(options.gateways.map((gateway) => new URL(gateway).origin))

  /** The fetch a mount in `partition` uses: with the partition's store key on each request to the node, and nothing added anywhere else. */
  const fetchFor = (partition: string | undefined): Fetch => {
    const keyed = options.storeKey
    if (keyed === undefined || partition === undefined) return options.fetch
    const value = keyed.key(partition)
    return async (url, init) => await options.fetch(url, nodeOrigins.has(new URL(url).origin) ? { ...init, headers: { ...init.headers, [keyed.header]: value } } : init)
  }

  const resolversFor = (fetch: Fetch): PointerResolvers => ({
    ipns: async (key: string, signal: AbortSignal, onRefusal: (refusal: Refusal) => void) => {
      const named = options.ipnsNameServices
      const once = async (): Promise<VerifiedIpnsRecord> => await resolveIpnsKey(key, fetch, { pool, nameServices: typeof named === 'function' ? named() : named ?? [] }, options.ipnsSequences, limits, signal, onRefusal)
      // A node that found no record answers the same for as long as it remembers the miss, as it does for a block.
      return limits.blockRetry === undefined ? await once() : await retryWhileWanted(once, retryOn(limits.blockRetry, pool.route), () => pool.now(), signal)
    },
    resolveTxt: options.resolveTxt,
    maxHops: limits.maxPointerHops
  })

  return {
    id: 'ipfs',
    supports: (records) => loadable(records) !== undefined,
    async mount (name, records, signal = new AbortController().signal, partition?: string): Promise<MountedSite> {
      const fetch = fetchFor(partition)
      const source = partition === undefined ? new BlockSource(fetch, pool, limits, NO_BLOCK_MEMORY) : new BlockSource(fetch, pool, limits, cache, partition)
      const record = loadable(records)
      if (record === undefined) throw new ResolutionError('unsupported', `no record of ${name} names IPFS content`)
      const refusals: Refusal[] = []
      const onRefusal = (refusal: Refusal): void => { refusals.push(refusal) }
      const { root, steps } = await followPointer(record.pointer, resolversFor(fetch), signal, onRefusal)
      try {
        checkCidAccepted(root)
      } catch (error) {
        throw new ResolutionError('unsupported', (error as Error).message)
      }
      const pointers: PointerStep[] = [{ step: 'contenthash', name, pointer: record.pointer, provenance: record.provenance }, ...steps]
      let failedResource: string | undefined

      /** Only a lie or a broken limit fails DDOC; nobody answering, or a missing path, does not. */
      const noteFailure = (error: unknown, path: string): never => {
        if (error instanceof ResolutionError && error.failure === 'unverifiable') failedResource ??= path
        throw error
      }

      return {
        gatherer: 'ipfs',
        servedFrom: { kind: local ? 'node' : 'gateways' },
        root: { kind: 'ipfs', cid: root.toString() },
        pointers,
        async open (path, range, openSignal = signal) {
          let file
          try {
            file = await openPath(source, root, path, range, openSignal, onRefusal)
          } catch (error) {
            return noteFailure(error, path)
          }
          const body = file.body
          return {
            servedPath: file.servedPath,
            size: file.size,
            ...(file.contentType !== undefined && { contentType: file.contentType }),
            body: (async function * () {
              try {
                yield * body
              } catch (error) {
                noteFailure(error, path)
              }
            })()
          }
        },
        ddoc (): DdocReport {
          const seen = [...refusals]
          if (failedResource !== undefined) return { status: 'failed', resource: failedResource, refusals: seen }
          return { status: 'met', refusals: seen }
        }
      }
    }
  }
}
