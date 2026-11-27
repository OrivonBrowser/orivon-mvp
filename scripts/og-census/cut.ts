import { encodeFunctionData, parseAbi } from 'viem'
import type { Hex } from 'viem'
import { CENSUS_FORMAT, censusEntryOf } from '../../src/protocols/og/census.js'
import type { Census, NameEntry } from '../../src/protocols/og/census.js'
import type { Log, Transaction } from '../../src/protocols/og/chain.js'
import { holderOf, idTopic, nameLogsOf } from '../../src/protocols/og/freshness.js'
import { implementationIn, upgradesProblem } from '../../src/protocols/og/guard.js'
import { sameAddress } from '../../src/protocols/og/hex.js'
import { keyOf, ogLabelFromHost } from '../../src/protocols/og/name.js'
import { CENSUS_KEYS, DEPLOY_BLOCKS, IMPLEMENTATION, IMPLEMENTATION_SLOT, PROXY, REGISTRY, REGISTRY_CONTENT_FLOOR, TOPICS, WRAPPER } from '../../src/protocols/og/pins.js'
import { decodeRegistryCall } from '../../src/protocols/og/registry-calls.js'
import { readName, readTogether } from '../../src/protocols/og/state.js'
import { splitByKey } from './logs.js'
import type { CutChain } from './rpc.js'

// The census at one block: every name that had a content record, in a text key or the registry's `content` slot, and what the
// resolver's own rule makes of each (`censusEntryOf`). Everything is read from chain through the chain given, so two nodes that
// must agree make the file one anybody can cut again and get the same bytes.

export type Say = (line: string) => void

/** What a cut read for each name's history: the logs of every name together, by key. Kept so the read can be checked name by name. */
export interface SharedLogs {
  readonly keys: readonly Hex[]
  readonly logs: ReadonlyMap<string, readonly Log[]>
}

/** How many names' slots are read in one `aggregate3`. */
const SLOT_BATCH = 400

const contentAbi = parseAbi(['function content(bytes32) view returns (bytes32)'])

/**
 * The label a registry key stands for: its bytes up to the zeros that pad them, as text. Null for a key that is not `keyOf` of a label
 * the resolver answers (`ogLabelFromHost`: one label, ASCII, ENSIP-15 normal, at most 32 bytes).
 */
export function labelOfKey (key: string): string | null {
  const bytes = key.slice(2).replace(/(?:00)+$/, '')
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null
  let label: string
  try {
    label = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes.match(/../g) ?? [], (pair) => parseInt(pair, 16)))
  } catch {
    return null
  }
  try {
    if (ogLabelFromHost(`${label}.og`) !== label) return null
  } catch {
    return null
  }
  return keyOf(label) === key.toLowerCase() ? label : null
}

/**
 * The names whose registry `content` slot holds a value at `block`, found from the registry's `Changed` logs from
 * `REGISTRY_CONTENT_FLOOR` on: a slot is written by a call that logs the name, so any name with a value written after the floor is in them.
 */
export async function slotLabels (chain: CutChain, block: number, say: Say): Promise<string[]> {
  const changed = await chain.getLogs({ address: REGISTRY, topics: [TOPICS.changed], fromBlock: REGISTRY_CONTENT_FLOOR, toBlock: block })
  const keys = [...new Set(changed.map((log) => (log.topics[1] ?? '').toLowerCase()))].filter((key) => labelOfKey(key) !== null).sort()
  const labels: string[] = []
  for (let at = 0; at < keys.length; at += SLOT_BATCH) {
    const batch = keys.slice(at, at + SLOT_BATCH)
    const answers = await readTogether(chain, batch.map((key) => ({ to: REGISTRY, data: encodeFunctionData({ abi: contentAbi, functionName: 'content', args: [key as Hex] }) })), block)
    answers.forEach((data, index) => { if (data !== null && /[1-9a-f]/i.test(data.slice(2))) labels.push(labelOfKey(batch[index] ?? '') as string) })
  }
  say(`${String(changed.length)} registry Changed logs from block ${String(REGISTRY_CONTENT_FLOOR)}, on ${String(keys.length)} names this resolver can answer, ${String(labels.length)} with a value in the registry's content slot`)
  return labels
}

/** The proxy's upgrades up to `block`, which must be the pinned ones, ending at the pinned implementation. */
async function pinnedUpgrades (chain: CutChain, block: number, say: Say): Promise<Census['upgrades']> {
  const logs = await chain.getLogs({ address: PROXY, topics: [TOPICS.upgraded], fromBlock: DEPLOY_BLOCKS.proxy, toBlock: block })
  const upgrades = logs.map((log) => ({ block: log.blockNumber, logIndex: log.logIndex, implementation: `0x${(log.topics[1] ?? '').slice(26)}` }))
  const implementation = implementationIn(await chain.getStorageAt(PROXY, IMPLEMENTATION_SLOT, block))
  if (!sameAddress(implementation, IMPLEMENTATION)) throw new Error(`the proxy runs ${implementation} at block ${String(block)}, not the implementation this resolver is built for (${IMPLEMENTATION})`)
  const problem = upgradesProblem(upgrades)
  if (problem !== null) throw new Error(`the upgrades of the proxy are not the ones this resolver is built for: ${problem}`)
  say(`${String(upgrades.length)} upgrades of the resolver contract, the pinned ones, ending at the pinned implementation`)
  return upgrades
}

/** The labels with a text record ever written, and those with a value in the registry's slot, sorted. */
async function candidateLabels (chain: CutChain, block: number, say: Say): Promise<string[]> {
  const written = await chain.getLogs({ address: PROXY, topics: [TOPICS.setTextRecord], fromBlock: DEPLOY_BLOCKS.proxy, toBlock: block })
  const texted = [...new Set(written.map((log) => labelOfKey((log.topics[1] ?? '').toLowerCase())))].filter((label): label is string => label !== null)
  say(`${String(written.length)} SetTextRecord logs, on ${String(texted.length)} names this resolver can answer`)
  return [...new Set([...texted, ...await slotLabels(chain, block, say)])].sort()
}

/**
 * Every registry and resolver log of the names, read once for all of them: topic 1 as a list of keys, over the whole life of the registry.
 * A name asked alone would take the same read again for each.
 */
async function sharedLogsOf (chain: CutChain, keys: readonly Hex[], block: number, say: Say): Promise<SharedLogs> {
  say(`reading the registry and resolver logs of ${String(keys.length)} names together, blocks ${String(DEPLOY_BLOCKS.registry)} to ${String(block)}`)
  // An empty list of topics matches every log, so no names is no read.
  const logs = keys.length === 0 ? [] : await chain.getLogs({ address: [REGISTRY, PROXY], topics: [null, keys], fromBlock: DEPLOY_BLOCKS.registry, toBlock: block })
  say(`${String(logs.length)} logs on ${String(keys.length)} names`)
  return { keys, logs: splitByKey(logs, keys) }
}

/**
 * The registry `Changed` logs of a name with the call each made, read from its transaction. A transaction a node does not have, or that
 * is not in its log's block, stops the cut: the call behind a log is not guessed.
 * @param seen transactions read already, by hash
 */
async function withCalls (chain: CutChain, key: Hex, logs: readonly Log[], seen: Map<string, Transaction>): Promise<(Log & { call: ReturnType<typeof decodeRegistryCall> })[]> {
  const out = []
  for (const log of logs) {
    let tx = seen.get(log.transactionHash)
    if (tx === undefined) {
      const found = await chain.getTransaction(log.transactionHash)
      if (found === null) throw new Error(`the nodes have no transaction ${log.transactionHash}, which logged a change of ${key} at block ${String(log.blockNumber)}`)
      seen.set(log.transactionHash, tx = found)
    }
    if (tx.blockNumber !== log.blockNumber) throw new Error(`transaction ${log.transactionHash} is in block ${String(tx.blockNumber)}, not in block ${String(log.blockNumber)}, where its log of ${key} is`)
    out.push({ ...log, call: decodeRegistryCall(tx, key) })
  }
  return out
}

const NAME_EVENTS: readonly string[] = [TOPICS.changed, TOPICS.setTextRecord, TOPICS.newController]
const topicOf = (log: Log): string => (log.topics[0] ?? '').toLowerCase()

/** One name's entry at `block`: null for a name nobody holds or that had no content value. */
async function entryAt (chain: CutChain, key: Hex, block: number, logs: readonly Log[], seen: Map<string, Transaction>): Promise<NameEntry | null> {
  const reads = await readName(chain, key, block, CENSUS_KEYS)
  const { found, wrapped } = holderOf(key, reads)
  if (!found) return null
  const everything = logs.filter((log) => NAME_EVENTS.includes(topicOf(log)))
  const named = [...everything.filter((log) => topicOf(log) !== TOPICS.changed), ...await withCalls(chain, key, everything.filter((log) => topicOf(log) === TOPICS.changed), seen)]
  const moved = wrapped
    ? (await chain.getLogs({ address: WRAPPER, topics: [TOPICS.transfer, null, null, idTopic(reads.nameToId)], fromBlock: DEPLOY_BLOCKS.wrapper, toBlock: block })).filter((log) => topicOf(log) === TOPICS.transfer)
    : []
  return censusEntryOf(key, reads, nameLogsOf(named, moved))
}

/**
 * The census at `block`. Stops with the reason when the chain's history is not the one the resolver is built for (another
 * implementation, another list of upgrades), a name's transaction cannot be read, or the nodes disagree.
 * @param chain two nodes that agree, each log query read in ranges
 */
export async function cutCensus (chain: CutChain, { block }: { block: number }, say: Say = () => {}): Promise<{ census: Census, shared: SharedLogs }> {
  const head = await chain.getBlock(block)
  if (head === null) throw new Error(`the nodes have no block ${String(block)}`)
  const upgrades = await pinnedUpgrades(chain, block, say)
  const labels = await candidateLabels(chain, block, say)
  const shared = await sharedLogsOf(chain, labels.map(keyOf), block, say)
  const seen = new Map<string, Transaction>()
  const names: Record<string, NameEntry> = {}
  for (const label of labels) {
    const key = keyOf(label)
    const entry = await entryAt(chain, key, block, shared.logs.get(key.toLowerCase()) ?? [], seen)
    if (entry === null) continue
    names[label] = entry
    const parts = Object.entries(entry.keys).map(([name, one]) => `${name} ${one.counts ? 'counts' : one.reason}`)
    if (entry.registry !== null) parts.push(`registry content ${entry.registry.counts ? 'counts' : entry.registry.reason}`)
    say(`${label}: ${parts.join(', ')}`)
  }
  return { census: { format: CENSUS_FORMAT, block: head.number, blockHash: head.hash, implementation: IMPLEMENTATION, upgrades, names }, shared }
}

/** The file's text for a census: two-space JSON, so a cut at the same block is the same bytes. */
export const censusText = (census: Census): string => `${JSON.stringify(census, null, 2)}\n`

/** The newest block both nodes call finalized. `cutCensus` asks both for its hash and stops if they differ. */
export async function sharedFinalized (nodes: readonly CutChain[]): Promise<number> {
  const heads = await Promise.all(nodes.map((node) => node.getBlock('finalized')))
  const lowest = Math.min(...heads.map((head) => head?.number ?? 0))
  if (lowest === 0) throw new Error('a node has no finalized block')
  return lowest
}
