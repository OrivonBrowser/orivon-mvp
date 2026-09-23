// When an installed app was last checked for an update, and what lets the
// next check be a conditional request for its manifest. Persisted per origin
// through LoaderStorage, so the interval survives a restart. See README.md's
// Design notes ("An installed app is checked for an update at most once an
// interval") for what a 304 is trusted to mean.

import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import { parsePinRecord } from '../broker/policy/pin.js'
import type { FetchResponse } from './fetch-budget.js'
import type { LoaderStorage } from './storage.js'

/** A manifest response's own `ETag` and `Last-Modified`, as the server sent them. */
export interface ManifestValidators {
  readonly etag?: string
  readonly lastModified?: string
}

export interface UpdateCheckRecord {
  /** `now()` when the last check that was not rejected finished. */
  readonly checkedAt: number
  /**
   * The validators of the manifest pinned when the record was written, and
   * that manifest's leaf. Sent on the next check only while the pin still
   * holds that leaf, so a 304 always means "the manifest you have pinned".
   */
  readonly validators?: ManifestValidators
  readonly manifestLeaf?: string
}

/** Longer than any real ETag or HTTP date; bounds what an origin can make this store. */
const MAX_VALIDATOR_LENGTH = 1024

/** Printable ASCII only: a validator is sent back as a header value, where CR/LF would be header injection. */
function isHeaderSafe (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALIDATOR_LENGTH && /^[\x20-\x7e]+$/.test(value)
}

function validatorsOf (etag: unknown, lastModified: unknown): ManifestValidators | undefined {
  const validators = {
    ...(isHeaderSafe(etag) && { etag }),
    ...(isHeaderSafe(lastModified) && { lastModified })
  }
  return Object.keys(validators).length === 0 ? undefined : validators
}

/** The validators `response` carries that are safe to send back, or undefined if none are. */
export function validatorsFrom (response: FetchResponse): ManifestValidators | undefined {
  return validatorsOf(response.headers?.get('etag') ?? undefined, response.headers?.get('last-modified') ?? undefined)
}

/** The request headers that make a manifest fetch conditional on `validators`. */
export function conditionalHeaders (validators: ManifestValidators): Readonly<Record<string, string>> {
  return {
    ...(validators.etag !== undefined && { 'if-none-match': validators.etag }),
    ...(validators.lastModified !== undefined && { 'if-modified-since': validators.lastModified })
  }
}

/** True while a check at `checkedAt` is less than `intervalMs` old. A time in the future (the clock went back) is not recent. */
export function checkedRecently (checkedAt: number, now: number, intervalMs: number): boolean {
  const age = now - checkedAt
  return age >= 0 && age < intervalMs
}

/** A persisted record, read back from disk: anything malformed is no record at all, so the next check simply runs in full. */
export function parseUpdateCheckRecord (raw: unknown): UpdateCheckRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt)) return undefined
  const stored = typeof record.validators === 'object' && record.validators !== null ? record.validators as Record<string, unknown> : {}
  const validators = validatorsOf(stored.etag, stored.lastModified)
  const manifestLeaf = typeof record.manifestLeaf === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.manifestLeaf) ? record.manifestLeaf : undefined
  if (validators === undefined || manifestLeaf === undefined) return { checkedAt: record.checkedAt }
  return { checkedAt: record.checkedAt, validators, manifestLeaf }
}

/** `origin`'s stored check, or undefined when there is none worth trusting. Never throws. */
export async function loadCheckRecord (storage: LoaderStorage, origin: string): Promise<UpdateCheckRecord | undefined> {
  try {
    return parseUpdateCheckRecord(await storage.readUpdateCheck(origin))
  } catch {
    return undefined
  }
}

/** Best-effort: a lost write costs one extra check on the next visit, never correctness. */
export async function saveCheckRecord (storage: LoaderStorage, origin: string, record: UpdateCheckRecord | undefined): Promise<void> {
  try {
    await storage.writeUpdateCheck(origin, record)
  } catch (error) {
    console.error('[loader] could not record the last update check', origin, error)
  }
}

/** The pinned manifest's leaf, or undefined when there is no readable pin. */
export async function pinnedManifestLeaf (storage: LoaderStorage, origin: string): Promise<string | undefined> {
  return parsePinRecord(await storage.readPin(origin))?.assets.find((asset) => asset.path === MANIFEST_PATH)?.leaf
}

/** `record`'s validators, only while the pin still holds the manifest they were recorded with. */
export async function validatorsForPin (storage: LoaderStorage, origin: string, record: UpdateCheckRecord | undefined): Promise<ManifestValidators | undefined> {
  if (record?.validators === undefined || record.manifestLeaf === undefined) return undefined
  return await pinnedManifestLeaf(storage, origin) === record.manifestLeaf ? record.validators : undefined
}

/** A record for a check at `checkedAt`; `validators` and `manifestLeaf` only as a pair, and only for the manifest now pinned. */
export function checkRecord (checkedAt: number, validators: ManifestValidators | undefined, manifestLeaf: string | undefined): UpdateCheckRecord {
  return validators === undefined || manifestLeaf === undefined ? { checkedAt } : { checkedAt, validators, manifestLeaf }
}
