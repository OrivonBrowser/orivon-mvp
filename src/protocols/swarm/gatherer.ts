// The Swarm DataGatherer: from a name's records to a mounted site whose every
// served byte was verified, with the DDOC report of its mount.

import { CID } from 'multiformats/cid'
import { ResolutionError } from '../resolution/records.js'
import type { NameRecord, PointerStep } from '../resolution/records.js'
import type { DataGatherer, DdocReport, GatherRange, GatheredFile, MountedSite, Refusal } from '../resolution/providers.js'
import { pathSegments } from '../resolution/path-segments.js'
import { BlockCache, NO_BLOCK_MEMORY } from '../gateways/cache.js'
import type { BlockMemory } from '../gateways/cache.js'
import { GatewayPool } from '../gateways/gateways.js'
import type { Fetch } from '../gateways/gateways.js'
import { ChunkSource } from './chunk-fetch.js'
import type { ChunkDeps } from './chunk-fetch.js'
import { feedOf, resolveFeed } from './feed.js'
import type { FeedIndexStore } from './feed.js'
import { openFile, readWhole } from './joiner.js'
import { decodeNode, lookup } from './mantaray.js'
import type { ManifestNode } from './mantaray.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { SwarmLimits } from './limits.js'
import { referenceCid, referenceOfCid } from './reference.js'
import type { RoutePace } from '../route-pace.js'

export interface SwarmGathererOptions {
  readonly fetch: Fetch
  /** Bee-API origins asked for `/chunks`, in order of preference; none means Swarm content cannot be opened. A local node is the intended one. */
  readonly endpoints: readonly string[]
  readonly feedIndexes: FeedIndexStore
  /** Held before each mount reads anything: the node the endpoints name may need starting. A rejection fails the mount as it is. */
  readonly beforeMount?: (signal: AbortSignal) => Promise<void>
  readonly limits?: Partial<SwarmLimits>
  /** The route these requests travel, which stretches every wait the limits were written for. Direct when unset. */
  readonly route?: RoutePace
  /** A line for the report log: how long a mount and a large file took, how many chunks came from disk, and a bulk read that fell back. No line names a site or an address. */
  readonly log?: (line: string) => void
  /** Where verified chunks are kept between mounts. The host gives one that also keeps them on disk; unset, they are kept in memory for the life of this gatherer. */
  readonly memory?: BlockMemory
}

const DEFAULT_INDEX_DOCUMENT = 'index.html'
/** A media type, optionally with a charset: nothing a header could be split on. */
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?charset=[a-z0-9_-]+)?$/i
const HAS_EXTENSION = /\.[^./]+$/
/** Manifest nodes kept for the life of one mount. */
const NODES_KEPT = 64
/** A file at least this large has its read time logged. */
const LOGGED_FILE_BYTES = 256 * 1024

/** ", N chunks from disk" for a log line, and nothing when none came from disk. */
function diskNote (chunks: number): string {
  return chunks > 0 ? `, ${String(chunks)} chunks from disk` : ''
}

/**
 * `memory` adding to `tally` each chunk its `recallKept` takes from disk. A lookup answers later and others run beside it,
 * so what counts is that it found a chunk, not a count taken before and after: each mount and each file read keeps a
 * tally of its own, whatever else is being read.
 */
function counted (memory: BlockMemory, tally: { chunks: number }): BlockMemory {
  const lookUp = memory.recallKept
  if (lookUp === undefined) return memory
  return {
    remember: (partition, key, block) => { memory.remember(partition, key, block) },
    recall: (partition, key) => memory.recall(partition, key),
    recallKept: async (partition, key) => {
      const found = await lookUp.call(memory, partition, key)
      if (found !== undefined) tally.chunks++
      return found
    },
    share: (partition, key, start) => memory.share(partition, key, start)
  }
}

function swarmRecord (records: readonly NameRecord[]): NameRecord | undefined {
  return records.find((r) => r.pointer.kind === 'swarm')
}

function rootOf (record: NameRecord): string {
  const cid = record.pointer.kind === 'swarm' ? record.pointer.cid : ''
  let reference: string | undefined
  try {
    reference = referenceOfCid(CID.parse(cid))
  } catch {
    reference = undefined
  }
  if (reference === undefined) throw new ResolutionError('unsupported', 'a Swarm contenthash that is not a keccak-256 reference')
  return reference
}

export function createSwarmGatherer (options: SwarmGathererOptions): DataGatherer {
  const limits: SwarmLimits = { ...DEFAULT_LIMITS, ...options.limits }
  /** No pool without an endpoint: the host starts with none configured, and each mount then says why nothing loads. */
  const deps: ChunkDeps | undefined = options.endpoints.length === 0
    ? undefined
    : { fetch: options.fetch, pool: new GatewayPool(options.endpoints, limits.perEndpointConcurrency, Date.now, options.route === undefined ? {} : { route: options.route }), limits, ...(options.log !== undefined && { log: options.log }) }
  const memory: BlockMemory = options.memory ?? new BlockCache()

  return {
    id: 'swarm',
    supports: (records) => swarmRecord(records) !== undefined,
    async mount (name, records, signal = new AbortController().signal, partition?: string): Promise<MountedSite> {
      const record = swarmRecord(records)
      if (record === undefined) throw new ResolutionError('unsupported', `no record of ${name} names Swarm content`)
      if (deps === undefined) throw new ResolutionError('unavailable', 'this build has no Swarm node to load from yet, so Swarm content cannot be opened')
      const startedAt = Date.now()
      await options.beforeMount?.(signal)
      const nodeReadyAt = Date.now()
      const fromDisk = { chunks: 0 }
      const sourceOf = (tally: { chunks: number }): ChunkSource => partition === undefined ? new ChunkSource(deps, NO_BLOCK_MEMORY) : new ChunkSource(deps, counted(memory, tally), partition)
      const source = sourceOf(fromDisk)
      const refusals: Refusal[] = []
      const onRefusal = (refusal: Refusal): void => { refusals.push(refusal) }
      const nodes = new Map<string, ManifestNode>()

      /** Nodes are read under whichever request asked, and kept only once whole. */
      const loaderFor = (forSignal: AbortSignal) => async (reference: string): Promise<ManifestNode> => {
        const kept = nodes.get(reference)
        if (kept !== undefined) return kept
        const file = await openFile(async (address) => await source.get(address, forSignal, onRefusal), reference, { maxBytes: limits.maxManifestNodeBytes, maxTreeDepth: limits.maxTreeDepth }, (parent, leaves) => source.leaves(parent, leaves, forSignal, onRefusal))
        const node = decodeNode(await readWhole(file, limits.maxManifestNodeBytes))
        if (nodes.size < NODES_KEPT) nodes.set(reference, node)
        return node
      }

      let root = rootOf(record)
      const pointers: PointerStep[] = [{ step: 'contenthash', name, pointer: record.pointer, provenance: record.provenance }]
      let indexDocument = DEFAULT_INDEX_DOCUMENT
      for (let hops = 0; ; hops++) {
        const entry = await lookup(root, '/', loaderFor(signal), limits.maxNodesPerLookup, false)
        const feed = feedOf(entry?.metadata)
        if (feed === undefined) {
          indexDocument = entry?.metadata?.['website-index-document'] ?? DEFAULT_INDEX_DOCUMENT
          break
        }
        if (hops >= limits.maxPointerHops) throw new ResolutionError('unverifiable', `more than ${String(limits.maxPointerHops)} feeds between a name and its content`)
        const resolved = await resolveFeed(feed, deps, options.feedIndexes, signal, onRefusal)
        pointers.push(resolved.step)
        root = resolved.root
      }
      options.log?.(`swarm: a site mounted in ${String(Date.now() - startedAt)} ms (the node ready after ${String(nodeReadyAt - startedAt)} ms, ${String(pointers.length - 1)} feeds followed${diskNote(fromDisk.chunks)})`)
      let failedResource: string | undefined

      /** Only a lie or a broken limit fails DDOC; nobody answering, or a missing path, does not. */
      const noteFailure = (error: unknown, path: string): never => {
        if (error instanceof ResolutionError && error.failure === 'unverifiable') failedResource ??= path
        throw error
      }

      async function openUnchecked (path: string, range: GatherRange | undefined, openSignal: AbortSignal, fileSource: ChunkSource): Promise<GatheredFile> {
        const segments = pathSegments(path)
        if (segments === undefined) throw new ResolutionError('not-found', `${path} is not a path this site can hold`)
        const load = loaderFor(openSignal)
        const directory = segments.length === 0 || path.endsWith('/')
        const base = segments.join('/')
        const asIndex = `${base === '' ? '' : `${base}/`}${indexDocument}`
        let served = directory ? asIndex : base
        let found = await lookup(root, served, load, limits.maxNodesPerLookup)
        if (found?.entry === undefined && !directory) {
          served = asIndex
          found = await lookup(root, served, load, limits.maxNodesPerLookup)
        }
        if (found?.entry === undefined) throw new ResolutionError('not-found', `${path} is not in this site`)
        const file = await openFile(async (address) => await fileSource.get(address, openSignal, onRefusal), found.entry, { maxBytes: limits.maxBytesPerOpen, maxTreeDepth: limits.maxTreeDepth }, (parent, leaves) => fileSource.leaves(parent, leaves, openSignal, onRefusal))
        const declared = found.metadata?.['Content-Type']
        const contentType = declared !== undefined && CONTENT_TYPE.test(declared) && !HAS_EXTENSION.test(served) ? declared : undefined
        return {
          servedPath: `/${served}`,
          size: file.size,
          ...(contentType !== undefined && { contentType }),
          body: file.read(range)
        }
      }

      return {
        gatherer: 'swarm',
        root: { kind: 'swarm', cid: referenceCid(root) },
        pointers,
        async open (path, range, openSignal = signal) {
          let file: GatheredFile
          const fileDisk = { chunks: 0 }
          try {
            file = await openUnchecked(path, range, openSignal, sourceOf(fileDisk))
          } catch (error) {
            return noteFailure(error, path)
          }
          const body = file.body
          const openedAt = Date.now()
          return {
            ...file,
            body: (async function * () {
              let read = 0
              try {
                for await (const part of body) {
                  read += part.length
                  yield part
                }
                if (read >= LOGGED_FILE_BYTES) options.log?.(`swarm: a file read, ${String(read)} bytes in ${String(Date.now() - openedAt)} ms${diskNote(fileDisk.chunks)}`)
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
