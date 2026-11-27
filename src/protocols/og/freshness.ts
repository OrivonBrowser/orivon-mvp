import type { Hex } from 'viem'
import { ZERO_ADDRESS, hashOf, sameAddress } from './hex.js'
import { REGISTRY_CONTENT, TOPICS, WRAPPER } from './pins.js'
import type { Position } from './pins.js'
import { SETTERS } from './registry-calls.js'
import type { RegistryCall } from './registry-calls.js'

// The freshness rule of a name's records, over the reads of one block and the logs of the name. A text record is
// the holder's only while no one else could have written it, and the resolver's `getTextRecord` cannot say who did, so
// the logs say it: a key counts when the controller is the holder (or there is none), and the latest log of that key
// carries the value now stored, after the latest change of holder and after the latest controller change. The registry's own
// `content` slot is held to the same rule, with the log of its own write: only the owner can write it, but a transfer leaves it
// to the next owner, so it counts when a direct `setContent` of the value now stored came after the latest change of holder. Pure: no
// network, no clock. The census tool and the resolver run this one function.

export interface LogLike {
  readonly blockNumber: number
  readonly logIndex: number
  readonly topics: readonly string[]
  readonly transactionHash?: string
  /**
   * For a registry `Changed` log whose transaction was read: the direct call it made about the name, or null for any other (a call
   * through a contract, an unknown selector, input that does not decode). A log with no `call` was not read, as the census's stand-in
   * for a change of holder is not, and an unread call is a change of holder.
   */
  readonly call?: RegistryCall | null
}

/** The logs of one name, each list of one event. */
export interface NameLogs {
  readonly setText: readonly LogLike[]
  readonly newController: readonly LogLike[]
  readonly registryChanged: readonly LogLike[]
  readonly wrapperTransfers: readonly LogLike[]
}

/** What the name's contracts say at one block. */
export interface NameReads {
  readonly registryOwner: string
  /** The wrapper's token for the name, 0 for none. */
  readonly nameToId: bigint
  /** The key the token stands for, or null when the read failed. */
  readonly idToName: string | null
  /** The token's holder, or null when there is no such token. */
  readonly ownerOf: string | null
  /** The account that may also write the name's records, the zero address for none, null when the read failed. */
  readonly controller: string | null
  /** The registry's own `content` slot: 0x and 64 hexadecimal digits, all zeros for none, null when the read failed. */
  readonly registryContent: string | null
  /** The text records, by key; null or empty for a key with no value. */
  readonly values: Readonly<Record<string, string | null>>
}

export type Reason = 'passes' | 'holder-is-the-wrapper-with-no-token' | 'controller-is-not-the-holder' | 'no-SetTextRecord-log' | 'latest-log-carries-another-value' | 'no-holder-change-log' | 'set-before-the-last-holder-change' | 'set-before-the-last-NewController'
/** Why the registry's slot does not count, besides `no-holder-change-log` and the reasons of a text key. */
export type RegistryReason = 'registry-content-no-holder' | 'registry-content-on-a-wrapped-name' | 'registry-content-no-setContent-log' | 'registry-content-set-before-the-last-holder-change'

export interface KeyVerdict {
  readonly counts: boolean
  readonly reason: Reason | RegistryReason | 'empty'
  readonly value?: string
  readonly writtenAt: Position | null
}

export interface Holder {
  readonly found: boolean
  readonly holder: string | null
  readonly wrapped: boolean
  readonly stranded: boolean
}

export interface Verdict extends Holder {
  readonly controllerOk: boolean
  readonly keys: Record<string, KeyVerdict>
  readonly registry: KeyVerdict
  /** The text keys that count, then `REGISTRY_CONTENT` when the slot does. */
  readonly records: string[]
  readonly holderChange?: Position | null
  readonly controllerChange?: Position | null
}

/** @param id a token id */
export const idTopic = (id: string | bigint): Hex => `0x${BigInt(id).toString(16).padStart(64, '0')}`

export const addressTopic = (address: string): Hex => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

/** A log's place as one number: block numbers stay under 2^27 and log indexes under a million, so it orders exactly in a double. */
const place = (log: { blockNumber: number, logIndex: number }): number => log.blockNumber * 1e6 + log.logIndex

function latest (logs: readonly LogLike[]): LogLike | null {
  return logs.reduce<LogLike | null>((best, log) => best === null || place(log) > place(best) ? log : best, null)
}

const is = (topic: string, wanted: string): boolean => topic.toLowerCase() === wanted

/** A name's logs by event: `found` is the registry's and the resolver's logs that carry the name, `moved` the wrapper's transfers of the name's token. */
export function nameLogsOf (found: readonly LogLike[], moved: readonly LogLike[]): NameLogs {
  const of = (topic: string): LogLike[] => found.filter((log) => is(log.topics[0] ?? '', topic))
  return { setText: of(TOPICS.setTextRecord), newController: of(TOPICS.newController), registryChanged: of(TOPICS.changed), wrapperTransfers: [...moved] }
}

/** The latest log that wrote `name`'s text key, or null. Logs of an unset carry the hash of the empty key, so they never match one. */
export const latestWrite = (logs: NameLogs, name: string): LogLike | null =>
  latest(logs.setText.filter((log) => is(log.topics[0] ?? '', TOPICS.setTextRecord) && is(log.topics[2] ?? '', hashOf(name))))

/**
 * Who holds the name: the registry owner, or for a name the wrapper holds, the holder of its token. A name the wrapper holds with no
 * token for it (or a token for another name) has no holder but the wrapper itself.
 */
export function holderOf (key: string, reads: NameReads): Holder {
  const owner = reads.registryOwner
  if (owner === '' || sameAddress(owner, ZERO_ADDRESS)) return { found: false, holder: null, wrapped: false, stranded: false }
  if (!sameAddress(owner, WRAPPER)) return { found: true, holder: owner, wrapped: false, stranded: false }
  const issued = reads.nameToId !== 0n && reads.idToName !== null && reads.idToName.toLowerCase() === key && reads.ownerOf !== null
  return issued ? { found: true, holder: reads.ownerOf, wrapped: true, stranded: false } : { found: true, holder: owner, wrapped: false, stranded: true }
}

/** Whether a registry `Changed` log is the name changing hands: any but a direct call of a setter the owner made, so a call that was not read is one. */
const changesHolder = (log: LogLike): boolean => is(log.topics[0] ?? '', TOPICS.changed) && !(log.call !== undefined && log.call !== null && SETTERS.has(log.call.fn))

const ZERO_SLOT = `0x${'0'.repeat(64)}`

/**
 * Whether the registry's `content` slot counts. Only the owner writes it, but a transfer leaves the value to the next owner and nothing in
 * the slot says who wrote it, so it counts only when the name is unwrapped and a direct `setContent` of the value now stored, as the log of
 * the registry says, came after the latest change of holder. A write made through a contract has no such log and does not count.
 * @param holderChange the latest change of holder, for an unwrapped name
 */
function registryVerdict (reads: NameReads, held: Holder, logs: NameLogs, holderChange: LogLike | null): KeyVerdict {
  const value = reads.registryContent?.toLowerCase() ?? null
  if (value === null || value === ZERO_SLOT) return { counts: false, reason: 'empty', writtenAt: null }
  const at = (log: LogLike | null): Position | null => log === null ? null : { block: log.blockNumber, logIndex: log.logIndex }
  if (held.holder === null) return { counts: false, reason: 'registry-content-no-holder', value, writtenAt: null }
  if (held.wrapped || held.stranded) return { counts: false, reason: 'registry-content-on-a-wrapped-name', value, writtenAt: null }
  const written = latest(logs.registryChanged.filter((log) => is(log.topics[0] ?? '', TOPICS.changed) && log.call?.fn === 'setContent' && log.call.value.toLowerCase() === value))
  let reason: KeyVerdict['reason'] = 'passes'
  if (written === null) reason = 'registry-content-no-setContent-log'
  else if (holderChange === null) reason = 'no-holder-change-log'
  else if (place(written) <= place(holderChange)) reason = 'registry-content-set-before-the-last-holder-change'
  return { counts: reason === 'passes', reason, value, writtenAt: at(written) }
}

/** Which keys of `reads.values` count, and why each does or does not, and whether the registry's own `content` slot does. */
export function evaluateFreshness (key: string, reads: NameReads, logs: NameLogs): Verdict {
  const held = holderOf(key, reads)
  const { found, holder, wrapped, stranded } = held
  const keys: Record<string, KeyVerdict> = {}
  const records: string[] = []
  if (holder === null) return { found, wrapped, stranded, holder, controllerOk: false, keys, registry: registryVerdict(reads, held, logs, null), records }
  // A name the wrapper holds with no token has the wrapper for its holder, which never writes a text record: no key of it counts, whoever the controller is.
  const controllerOk = reads.controller !== null && (sameAddress(reads.controller, ZERO_ADDRESS) || sameAddress(reads.controller, holder))
  const changes = wrapped
    ? logs.wrapperTransfers.filter((log) => is(log.topics[0] ?? '', TOPICS.transfer) && is(log.topics[2] ?? '', addressTopic(holder)))
    : logs.registryChanged.filter(changesHolder)
  const holderChange = latest(changes)
  const controllerChange = latest(logs.newController.filter((log) => is(log.topics[0] ?? '', TOPICS.newController)))
  for (const [name, value] of Object.entries(reads.values)) {
    if (value === null || value === '') {
      keys[name] = { counts: false, reason: 'empty', writtenAt: null }
      continue
    }
    const written = latestWrite(logs, name)
    let reason: Reason = 'passes'
    if (stranded) reason = 'holder-is-the-wrapper-with-no-token'
    else if (!controllerOk) reason = 'controller-is-not-the-holder'
    else if (written === null) reason = 'no-SetTextRecord-log'
    else if (!is(written.topics[3] ?? '', hashOf(value))) reason = 'latest-log-carries-another-value'
    else if (holderChange === null) reason = 'no-holder-change-log'
    else if (place(written) <= place(holderChange)) reason = 'set-before-the-last-holder-change'
    else if (controllerChange !== null && place(written) <= place(controllerChange)) reason = 'set-before-the-last-NewController'
    keys[name] = { counts: reason === 'passes', reason, value, writtenAt: written === null ? null : { block: written.blockNumber, logIndex: written.logIndex } }
    if (reason === 'passes') records.push(name)
  }
  const registry = registryVerdict(reads, held, logs, wrapped ? null : holderChange)
  if (registry.counts) records.push(REGISTRY_CONTENT)
  return {
    found, wrapped, stranded, holder, controllerOk, keys, registry, records,
    holderChange: holderChange === null ? null : { block: holderChange.blockNumber, logIndex: holderChange.logIndex },
    controllerChange: controllerChange === null ? null : { block: controllerChange.blockNumber, logIndex: controllerChange.logIndex }
  }
}
