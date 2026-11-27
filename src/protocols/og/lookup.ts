import type { Hex } from 'viem'
import type { NameRecord } from '../resolution/records.js'
import { recordsOf } from './answer.js'
import type { Chain } from './chain.js'
import { entryOf, mergedLogs } from './census.js'
import type { Census } from './census.js'
import { evaluateFreshness, holderOf, idTopic, nameLogsOf } from './freshness.js'
import type { NameLogs, NameReads, Verdict } from './freshness.js'
import { guardResolver } from './guard.js'
import { sameAddress } from './hex.js'
import { newCall } from './launcher.js'
import type { Call } from './launcher.js'
import { keyOf } from './name.js'
import { CENSUS_KEYS, PROXY, REGISTRY, REGISTRY_CONTENT, TOPICS, WRAPPER } from './pins.js'
import { decodeRegistryCall, SETTERS } from './registry-calls.js'
import type { RegistryCall } from './registry-calls.js'
import { pinBlocks, readName } from './state.js'
import { OgRefusal, readTransactions, scanLogs } from './tail.js'
import type { Session } from './tail.js'

// Resolves a name under `.og` from the Linagee contracts on chain: `alice.og` is the registry key `alice`, held by whoever the
// registry (or the wrapper, for a wrapped name) says, with the text records the resolver stores for it. A record counts only
// when the holder could have written it and no one has since taken the name or the controller away (freshness.ts), and
// only while the resolver contract is the one this bundle was built against (guard.ts). The registry's own `content` slot is read
// with the rest and counts when a direct `setContent` of its value came after the last change of holder. Every read is made at one
// block. History up to the census checkpoint is the bundle's (census.ts); the rest, from the checkpoint to that block, is read from
// the node by name, window by window (tail.ts), within the time the call has, and the transaction behind each registry log of the
// name (what the call was) after it.

/** What one call brings. */
export interface Lookup {
  /** What the resolver remembers between calls. */
  readonly session: Session
  /** The bundle's census. */
  readonly census: Census
  /** Fires when the call is no longer wanted. */
  readonly signal?: AbortSignal | undefined
  /** Milliseconds since the epoch by which the call must have answered. */
  readonly deadlineAt?: number | undefined
}

const NAME_EVENTS = new Set<string>([TOPICS.changed, TOPICS.setTextRecord, TOPICS.newController])

/**
 * Every log of the name between the census checkpoint and `block`, by event: the registry's and the resolver's logs that carry the
 * name (one query), and for a wrapped name the wrapper's transfers of its token (a second).
 */
async function scanName (chain: Chain, lookup: Lookup, { label, key, tokenId, block, final, call }: { label: string, key: Hex, tokenId: string | null, block: number, final: number, call: Call }): Promise<NameLogs> {
  const { session, census, signal, deadlineAt } = lookup
  const from = census.block + 1
  const options = { deadlineAt, signal, what: `the recent history of ${label}.og`, call, final }
  const tokenTopic = tokenId === null ? null : idTopic(tokenId)
  const named = scanLogs(chain, session, {
    id: `name:${key}`,
    address: [REGISTRY, PROXY],
    topics: [null, key],
    from,
    to: block,
    accept: (log) => log.topics[1]?.toLowerCase() === key && NAME_EVENTS.has(log.topics[0]?.toLowerCase() ?? '') && (sameAddress(log.address, REGISTRY) || sameAddress(log.address, PROXY))
  }, options)
  const transfers = tokenTopic === null
    ? Promise.resolve([])
    : scanLogs(chain, session, {
      id: `token:${tokenId ?? ''}`,
      address: WRAPPER,
      topics: [TOPICS.transfer, null, null, tokenTopic],
      from,
      to: block,
      accept: (log) => sameAddress(log.address, WRAPPER) && log.topics[0]?.toLowerCase() === TOPICS.transfer && log.topics[3]?.toLowerCase() === tokenTopic
    }, options)
  const [found, moved] = await Promise.all([named, transfers])
  return nameLogsOf(found, moved)
}

/** How many transactions are asked at once: a name's changes number a few, and the newest decide. */
const CALL_ROUND = 4

const ZERO_SLOT = `0x${'0'.repeat(64)}`

/**
 * What each of the name's registry `Changed` logs after the checkpoint did, read from the transactions behind them, newest first and a
 * round at a time, until one is a change of holder: nothing before it can change the answer. The logs come back with `call` filled in.
 * A call that cannot be read is no setter: a transaction the node does not have, or one that could not be read in time, refuses the lookup.
 */
async function readCalls (chain: Chain, lookup: Lookup, { label, key, tail, final, head, call }: { label: string, key: Hex, tail: NameLogs, final: number, head: number, call: Call }): Promise<NameLogs> {
  const { session, signal, deadlineAt } = lookup
  const newest = [...tail.registryChanged].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
  const calls = new Map<unknown, RegistryCall | null>()
  for (let at = 0; at < newest.length; at += CALL_ROUND) {
    const round = newest.slice(at, at + CALL_ROUND)
    const wanted = round.map((log) => ({ hash: log.transactionHash ?? '', blockNumber: log.blockNumber }))
    const transactions = await readTransactions(chain, session, wanted, { deadlineAt, signal, what: `what the registry did to ${label}.og`, call, final, head })
    let moved = false
    round.forEach((log, index) => {
      const tx = transactions[index]
      // A transaction from another block than its log's is not the one that logged it.
      const read = tx !== undefined && tx.blockNumber === log.blockNumber ? decodeRegistryCall(tx, key) : null
      calls.set(log, read)
      if (read === null || !SETTERS.has(read.fn)) moved = true
    })
    if (moved) break
  }
  return { ...tail, registryChanged: tail.registryChanged.map((log) => calls.has(log) ? { ...log, call: calls.get(log) ?? null } : log) }
}

/** A name as the resolver sees it, with the reasons behind every record. */
export interface Inspection {
  readonly label: string
  /** The registry key. */
  readonly key: Hex
  /** The block every read was made at. */
  readonly block: number
  /** What the contracts said at `block`. */
  readonly reads: NameReads
  readonly holder: ReturnType<typeof holderOf>
  /** Which keys count and why, and whether the registry's slot does; null for a name that is not there, or when `refusal` is set. */
  readonly verdict: Verdict | null
  /** Why the records could not be vouched for: the resolver contract changed, or the history or a transaction in it could not be read in time. */
  readonly refusal: OgRefusal | null
}

/**
 * Everything `resolveOg` knows about a name, before it makes an answer of it. The history is read only when a record needs it.
 * @param label a label that passed `ogLabelFromHost`
 * @param keys the text keys to read, every one an answer is made of by default
 */
export async function inspectOg (chain: Chain, label: string, lookup: Lookup, keys: readonly string[] = CENSUS_KEYS): Promise<Inspection> {
  const { session, census, signal, deadlineAt } = lookup
  const key = keyOf(label)
  const pinned = await pinBlocks(chain)
  const block = Math.max(pinned.block, census.block)
  const { final } = pinned
  const call = newCall()
  signal?.throwIfAborted()
  const reads = await readName(chain, key, block, keys)
  const holder = holderOf(key, reads)
  const base = { label, key, block, reads, holder }
  if (!holder.found || holder.holder === null) return { ...base, verdict: null, refusal: null }
  // With nothing to vouch for there is nothing to read: no text record (or a controller that is not the holder, or a name the wrapper holds
  // with no token, which keep every record out whatever the logs say) and no value in the registry's slot (or a wrapped name's, which never counts).
  const empty: NameLogs = { setText: [], newController: [], registryChanged: [], wrapperTransfers: [] }
  const early = evaluateFreshness(key, reads, empty)
  const texts = !(keys.every((text) => (reads.values[text] ?? '') === '') || !early.controllerOk || holder.stranded)
  const slot = !holder.wrapped && !holder.stranded && reads.registryContent !== null && reads.registryContent !== ZERO_SLOT
  if (!texts && !slot) return { ...base, verdict: early, refusal: null }
  try {
    // The resolver contract's upgrades matter to its text records only.
    const [tail] = await Promise.all([
      scanName(chain, lookup, { label, key, tokenId: holder.wrapped ? String(reads.nameToId) : null, block, final, call }),
      texts ? guardResolver(chain, session, { block, final, call, checkpoint: census.block, implementation: census.implementation, upgrades: census.upgrades, deadlineAt, signal }) : undefined
    ])
    // A wrapped name's holder change is the wrapper's transfer, which no registry call tells.
    const read = holder.wrapped ? tail : await readCalls(chain, lookup, { label, key, tail, final, head: block, call })
    return { ...base, verdict: evaluateFreshness(key, reads, mergedLogs({ key, reads, entry: entryOf(census, label), checkpoint: census.block, tail: read })), refusal: null }
  } catch (error) {
    if (error instanceof OgRefusal) return { ...base, verdict: null, refusal: error }
    throw error
  }
}

/**
 * A name's records at one block: those that count, as pointers. Empty for a name that is not there, has none, or none that count.
 * Throws an `OgRefusal` when the answer cannot be given safely or in time, and what the node threw when it cannot be asked.
 * @param label a label that passed `ogLabelFromHost`
 */
export async function resolveOg (chain: Chain, label: string, lookup: Lookup): Promise<NameRecord[]> {
  const found = await inspectOg(chain, label, lookup)
  if (found.refusal !== null) throw found.refusal
  if (found.verdict === null) return []
  const counted = found.verdict.records.map((name) => [name, name === REGISTRY_CONTENT ? found.reads.registryContent : found.reads.values[name]] as const)
  return recordsOf(Object.fromEntries(counted), found.block)
}
