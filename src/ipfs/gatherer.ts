// The IPFS DataGatherer: from a name's records to a mounted site whose every
// served byte was verified, with the DDOC report of one navigation.

import { ResolutionError } from '../resolution/records.js'
import type { NameRecord, PointerStep } from '../resolution/records.js'
import type { DataGatherer, DdocReport, MountedSite, Refusal } from '../resolution/providers.js'
import { pointerChainVerdict } from '../resolution/pointer-chain.js'
import { BlockSource } from './blockstore.js'
import type { ResolveTxt } from './dnslink.js'
import { GatewayPool } from './gateways.js'
import type { Fetch } from './gateways.js'
import { resolveIpnsKey } from './ipns.js'
import type { SequenceStore } from './ipns.js'
import { DEFAULT_LIMITS } from './limits.js'
import type { IpfsLimits } from './limits.js'
import { followPointer } from './pointers.js'
import { openPath } from './unixfs.js'
import { checkCidAccepted } from './verify-block.js'

export interface IpfsGathererOptions {
  readonly fetch: Fetch
  readonly gateways: readonly string[]
  /** w3name-style services, asked for an IPNS record after the gateways. */
  readonly ipnsNameServices?: readonly string[]
  readonly resolveTxt: ResolveTxt
  readonly ipnsSequences: SequenceStore
  readonly limits?: Partial<IpfsLimits>
}

const LOADABLE = new Set(['ipfs', 'ipns-key', 'dnslink'])

function loadable (records: readonly NameRecord[]): NameRecord | undefined {
  return records.find((r) => LOADABLE.has(r.pointer.kind))
}

function unverifiedReason (step: PointerStep | undefined): string {
  if (step === undefined) return 'no pointer to the content was proven'
  if (step.step === 'dnslink') return `via DNS: ${step.domain}`
  if (step.step === 'contenthash' && step.provenance.via === 'dns') return `name read from DNS: ${step.provenance.domain}`
  return 'a pointer to the content was not proven'
}

export function createIpfsGatherer (options: IpfsGathererOptions): DataGatherer {
  const limits: IpfsLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const pool = new GatewayPool(options.gateways, limits.gatewayConcurrency)
  const source = new BlockSource(options.fetch, pool, limits)
  const resolvers = {
    ipns: async (key: string, signal: AbortSignal, onRefusal: (refusal: Refusal) => void) =>
      await resolveIpnsKey(key, options.fetch, { pool, nameServices: options.ipnsNameServices ?? [] }, options.ipnsSequences, limits.blockTimeoutMs, signal, onRefusal),
    resolveTxt: options.resolveTxt,
    maxHops: limits.maxPointerHops
  }

  return {
    id: 'ipfs',
    supports: (records) => loadable(records) !== undefined,
    async mount (name, records, signal = new AbortController().signal): Promise<MountedSite> {
      const record = loadable(records)
      if (record === undefined) throw new ResolutionError('unsupported', `no record of ${name} names IPFS content`)
      const refusals: Refusal[] = []
      const onRefusal = (refusal: Refusal): void => { refusals.push(refusal) }
      const { root, steps } = await followPointer(record.pointer, resolvers, signal, onRefusal)
      try {
        checkCidAccepted(root)
      } catch (error) {
        throw new ResolutionError('unsupported', (error as Error).message)
      }
      const pointers: PointerStep[] = [{ step: 'contenthash', name, pointer: record.pointer, provenance: record.provenance }, ...steps]
      const chain = pointerChainVerdict(pointers)
      let failedResource: string | undefined

      /** Only a lie or a broken limit fails DDOC; nobody answering, or a missing path, does not. */
      const noteFailure = (error: unknown, path: string): never => {
        if (error instanceof ResolutionError && error.failure === 'unverifiable') failedResource ??= path
        throw error
      }

      return {
        gatherer: 'ipfs',
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
          if (!chain.verified) return { status: 'not-met', reason: unverifiedReason(chain.unverified), refusals: seen }
          return { status: 'met', refusals: seen }
        }
      }
    }
  }
}
