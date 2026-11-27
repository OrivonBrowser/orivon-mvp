import type { Hex } from 'viem'
import { sameAddress, hashOf } from './hex.js'
import { CENSUS_KEYS, TOPICS } from './pins.js'
import type { Position } from './pins.js'
import { addressTopic, evaluateFreshness, holderOf, idTopic, latestWrite } from './freshness.js'
import type { NameLogs, NameReads } from './freshness.js'

// The census: what a name's records and history looked like at the block the bundle was cut at (its checkpoint). Scanning a
// name's logs from 2015 costs tens of thousands of node calls, so the bundle carries the answer up to the checkpoint and
// the resolver scans only what came after. This file reads the census, turns an entry into the logs it stands for so the
// freshness rule runs over history and tail together, and cuts an entry from a name's whole history (the census tool).
// What the census says is the bundle's word, as the pinned implementation is: DESIGN.md says why that is trusted.

export const CENSUS_FORMAT = 2

/** One text key of a name at the checkpoint. */
export interface KeyEntry {
  /** keccak-256 of the value stored then. */
  readonly valueHash: string
  /** The latest log that wrote the key, with the hash of the value it carries. */
  readonly log: (Position & { readonly valueHash: string }) | null
  /** Whether the freshness rule kept the key at the checkpoint. */
  readonly counts: boolean
  readonly reason: string
}

/** The registry's own `content` slot of a name at the checkpoint. */
export interface RegistryEntry {
  /** What the slot held, 0x and 64 hexadecimal digits. */
  readonly value: string
  /** The latest log of a direct `setContent` of that value, or null when there is none. */
  readonly set: Position | null
  readonly counts: boolean
  readonly reason: string
}

/** A name that had a content value, in a text key or in the registry's slot, at the checkpoint. */
export interface NameEntry {
  /** Who held it then. */
  readonly holder: string
  /** Whether the holder held a wrapper token. */
  readonly wrapped: boolean
  /** The token, for a wrapped name. */
  readonly id: string | null
  /** The latest change of holder, as the rule reads it for that state: a direct setter of the registry is none. */
  readonly holderChange: Position | null
  /** The latest change of controller. */
  readonly newController: Position | null
  /** The registry's slot, null when it was empty. */
  readonly registry: RegistryEntry | null
  readonly keys: Readonly<Record<string, KeyEntry>>
}

export interface Census {
  readonly format: number
  readonly block: number
  readonly blockHash: string
  readonly implementation: string
  readonly upgrades: readonly (Position & { readonly implementation: string })[]
  readonly names: Readonly<Record<string, NameEntry>>
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The census a bundle carries, checked for shape: a malformed one is a broken bundle, and it fails every lookup that needs it
 * rather than guessing.
 * @param raw the parsed census.json
 */
export function readCensus (raw: unknown): Census {
  if (!isObject(raw) || raw['format'] !== CENSUS_FORMAT) throw new Error('the census is not in a format this resolver reads')
  const { block, blockHash, implementation, upgrades, names } = raw
  if (!Number.isSafeInteger(block) || typeof blockHash !== 'string' || typeof implementation !== 'string' || !Array.isArray(upgrades) || !isObject(names)) throw new Error('the census lacks a block, an implementation or names')
  return raw as unknown as Census
}

/** The name's entry, or null for a name that had no content value, in a text key or the registry's slot, at the checkpoint. */
export const entryOf = (census: Census, label: string): NameEntry | null => Object.hasOwn(census.names, label) ? census.names[label] ?? null : null

const ZERO_TOPIC: Hex = `0x${'0'.repeat(64)}`

/**
 * The logs the freshness rule reads for a name now: the tail the node returned for (checkpoint, block], and what the census says
 * of everything before, as the logs it stands for. A census entry gives the holder at the checkpoint, so it stands for the change
 * of holder only while the holder is still that one; any other holder must show a change of its own in the tail. A name with no
 * entry had no content value at the checkpoint, so any record it has was written after it, and a change of holder or controller
 * before the checkpoint is before that record: a change before the checkpoint stands for the holder having been the holder then. The latest
 * `setContent` the census saw stands as that call, wherever the holder is now: a holder who changed since shows a change of his own in the
 * tail, which comes after it.
 */
export function mergedLogs ({ key, reads, entry, checkpoint, tail }: { key: Hex, reads: NameReads, entry: NameEntry | null, checkpoint: number, tail: NameLogs }): NameLogs {
  const logs = { setText: [...tail.setText], newController: [...tail.newController], registryChanged: [...tail.registryChanged], wrapperTransfers: [...tail.wrapperTransfers] }
  const { holder, wrapped } = holderOf(key, reads)
  if (holder === null) return logs
  const id = String(reads.nameToId)
  const sameHolder = entry === null || (sameAddress(entry.holder, holder) && entry.wrapped === wrapped && (!wrapped || entry.id === id))
  if (sameHolder) {
    const at = entry?.holderChange
    const place = at === undefined || at === null ? { blockNumber: checkpoint, logIndex: -1 } : { blockNumber: at.block, logIndex: at.logIndex }
    if (wrapped) logs.wrapperTransfers.push({ ...place, topics: [TOPICS.transfer, ZERO_TOPIC, addressTopic(holder), idTopic(id)] })
    else logs.registryChanged.push({ ...place, topics: [TOPICS.changed, key] })
  }
  if (entry === null) return logs
  const set = entry.registry?.set
  if (entry.registry !== null && set !== undefined && set !== null) {
    logs.registryChanged.push({ blockNumber: set.block, logIndex: set.logIndex, topics: [TOPICS.changed, key], call: { fn: 'setContent', value: entry.registry.value } })
  }
  if (entry.newController !== null) logs.newController.push({ blockNumber: entry.newController.block, logIndex: entry.newController.logIndex, topics: [TOPICS.newController, key, ZERO_TOPIC] })
  for (const [name, one] of Object.entries(entry.keys)) {
    if (one.log !== null) logs.setText.push({ blockNumber: one.log.block, logIndex: one.log.logIndex, topics: [TOPICS.setTextRecord, key, hashOf(name), one.log.valueHash] })
  }
  return logs
}

/**
 * A name's entry at a block, from its state then and every log it ever had: the census tool's cut of one name.
 * @param reads the state at the block, `values` holding every key of `CENSUS_KEYS`
 * @param logs every log of the name up to the block, the registry's with the call each made (`call`)
 * @returns null for a name that is not there or had no content value, in a text key or in the registry's slot
 */
export function censusEntryOf (key: Hex, reads: NameReads, logs: NameLogs): NameEntry | null {
  const verdict = evaluateFreshness(key, reads, logs)
  if (!verdict.found || verdict.holder === null) return null
  const keys: Record<string, KeyEntry> = {}
  for (const name of CENSUS_KEYS) {
    const value = reads.values[name]
    const one = verdict.keys[name]
    if (value === null || value === undefined || value === '' || one === undefined) continue
    const written = latestWrite(logs, name)
    keys[name] = {
      valueHash: hashOf(value),
      log: written === null ? null : { block: written.blockNumber, logIndex: written.logIndex, valueHash: written.topics[3] ?? '' },
      counts: one.counts,
      reason: one.reason
    }
  }
  const slot = verdict.registry
  const registry = slot.reason === 'empty' || slot.value === undefined
    ? null
    : { value: slot.value, set: slot.writtenAt, counts: slot.counts, reason: slot.reason }
  if (Object.keys(keys).length === 0 && registry === null) return null
  return {
    holder: verdict.holder,
    wrapped: verdict.wrapped,
    id: verdict.wrapped ? String(reads.nameToId) : null,
    holderChange: verdict.holderChange ?? null,
    newController: verdict.controllerChange ?? null,
    registry,
    keys
  }
}
