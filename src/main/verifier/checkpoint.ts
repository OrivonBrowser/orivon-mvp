// The light client's root of trust: a finalized beacon block root. The
// release ships one; after each sync the host reports a newer one, stored
// here; when both have aged out, one fetched at run time from beacon servers
// that agreed (checkpoint-fetch.ts) is stored in the same place. The newest
// is used, and none past MAX_CHECKPOINT_AGE: the light client itself only
// warns about an old one.

import { BLOCK_ROOT_PATTERN } from '../../protocols/verifier-host/protocol.js'

export const MAINNET_GENESIS_SECONDS = 1_606_824_023
export const SECONDS_PER_SLOT = 12

/** Helios's own limit for mainnet, which its JavaScript build does not enforce. */
export const MAX_CHECKPOINT_AGE_SECONDS = 14 * 24 * 60 * 60

/** A clock this far behind a checkpoint's own time is wrong, and so is any age computed from it. */
export const FUTURE_TOLERANCE_SECONDS = 15 * 60

export interface Checkpoint {
  readonly root: string
  /** Unix seconds of the checkpoint's slot. */
  readonly timestamp: number
}

/** What this install stored: the light client's own newer one, or one fetched at run time, with the servers that agreed on it. */
export interface StoredCheckpoint extends Checkpoint {
  readonly fetchedFrom?: readonly string[]
}

export type CheckpointSource = 'release' | 'this-install' | 'fetched'

export type CheckpointChoice =
  | { readonly ok: true, readonly checkpoint: Checkpoint, readonly source: CheckpointSource, readonly ageSeconds: number, readonly fetchedFrom?: readonly string[] }
  /** Every checkpoint is dated after this computer's clock. */
  | { readonly ok: false, readonly problem: 'clock-behind' }
  | { readonly ok: false, readonly problem: 'too-old', readonly source: CheckpointSource, readonly ageSeconds: number, readonly fetchedFrom?: readonly string[] }

export function slotTimestamp (slot: number): number {
  return MAINNET_GENESIS_SECONDS + slot * SECONDS_PER_SLOT
}

/** The file stored in the profile, or undefined when it is missing or malformed. */
export function parseCheckpoint (value: unknown): Checkpoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { root, timestamp } = value as { root?: unknown, timestamp?: unknown }
  if (typeof root !== 'string' || !BLOCK_ROOT_PATTERN.test(root)) return undefined
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < MAINNET_GENESIS_SECONDS) return undefined
  return { root, timestamp }
}

/** The stored file, with the servers that agreed on it when it was fetched at run time. */
export function parseStoredCheckpoint (value: unknown): StoredCheckpoint | undefined {
  const checkpoint = parseCheckpoint(value)
  if (checkpoint === undefined) return undefined
  const { fetchedFrom } = value as { fetchedFrom?: unknown }
  const servers = Array.isArray(fetchedFrom) && fetchedFrom.length > 0 && fetchedFrom.length <= 8 && fetchedFrom.every((s) => typeof s === 'string' && s.length <= 200 && /^https?:\/\/[\w.-]+(:\d+)?$/.test(s))
    ? fetchedFrom as string[]
    : undefined
  return servers === undefined ? checkpoint : { ...checkpoint, fetchedFrom: servers }
}

export function chooseCheckpoint (shipped: Checkpoint, stored: StoredCheckpoint | undefined, nowSeconds: number, maxAgeSeconds = MAX_CHECKPOINT_AGE_SECONDS): CheckpointChoice {
  const candidates: Array<{ checkpoint: Checkpoint, source: CheckpointSource, fetchedFrom?: readonly string[] }> = [{ checkpoint: shipped, source: 'release' }]
  if (stored !== undefined) {
    const { fetchedFrom, ...checkpoint } = stored
    candidates.push(fetchedFrom === undefined ? { checkpoint, source: 'this-install' } : { checkpoint, source: 'fetched', fetchedFrom })
  }
  const usable = candidates.filter(({ checkpoint }) => checkpoint.timestamp <= nowSeconds + FUTURE_TOLERANCE_SECONDS)
  if (usable.length === 0) return { ok: false, problem: 'clock-behind' }
  // Ties go to the release's: two beacon APIs agreed on it before it shipped.
  const newest = usable.reduce((a, b) => b.checkpoint.timestamp > a.checkpoint.timestamp ? b : a)
  const ageSeconds = Math.max(0, nowSeconds - newest.checkpoint.timestamp)
  const fetchedFrom = newest.fetchedFrom === undefined ? {} : { fetchedFrom: newest.fetchedFrom }
  if (ageSeconds > maxAgeSeconds) return { ok: false, problem: 'too-old', source: newest.source, ageSeconds, ...fetchedFrom }
  return { ok: true, checkpoint: newest.checkpoint, source: newest.source, ageSeconds, ...fetchedFrom }
}
