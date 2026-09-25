// The light client's root of trust: a finalized beacon block root. The
// release ships one; after each sync the host reports a newer one, stored
// here. The newer of the two is used, and neither past MAX_CHECKPOINT_AGE:
// the light client itself only warns about an old one.

import { BLOCK_ROOT_PATTERN } from '../../verifier-host/protocol.js'

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

export type CheckpointSource = 'release' | 'this-install'

export type CheckpointChoice =
  | { readonly ok: true, readonly checkpoint: Checkpoint, readonly source: CheckpointSource, readonly ageSeconds: number }
  /** Every checkpoint is dated after this computer's clock. */
  | { readonly ok: false, readonly problem: 'clock-behind' }
  | { readonly ok: false, readonly problem: 'too-old', readonly source: CheckpointSource, readonly ageSeconds: number }

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

export function chooseCheckpoint (shipped: Checkpoint, stored: Checkpoint | undefined, nowSeconds: number, maxAgeSeconds = MAX_CHECKPOINT_AGE_SECONDS): CheckpointChoice {
  const candidates: Array<{ checkpoint: Checkpoint, source: CheckpointSource }> = [{ checkpoint: shipped, source: 'release' }]
  if (stored !== undefined) candidates.push({ checkpoint: stored, source: 'this-install' })
  const usable = candidates.filter(({ checkpoint }) => checkpoint.timestamp <= nowSeconds + FUTURE_TOLERANCE_SECONDS)
  if (usable.length === 0) return { ok: false, problem: 'clock-behind' }
  // Ties go to the release's: two beacon APIs agreed on it before it shipped.
  const newest = usable.reduce((a, b) => b.checkpoint.timestamp > a.checkpoint.timestamp ? b : a)
  const ageSeconds = Math.max(0, nowSeconds - newest.checkpoint.timestamp)
  if (ageSeconds > maxAgeSeconds) return { ok: false, problem: 'too-old', source: newest.source, ageSeconds }
  return { ok: true, checkpoint: newest.checkpoint, source: newest.source, ageSeconds }
}
