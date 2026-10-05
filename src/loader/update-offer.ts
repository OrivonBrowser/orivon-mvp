// The update offers a person ticked "Don't ask again for this version" on, kept per app beside its
// pin (`apps/<hash>/update-offer.json`). A verified offer and an unverified one for the same CID are
// different questions, so each is recorded as its own entry: ticking the notice never silences the
// question a later score would turn it into. Read back from disk, so parsed like any untrusted file.

import type { LoaderStorage } from './cache/storage.js'

export interface QuietOffer {
  readonly cid: string
  readonly verified: boolean
}

export interface UpdateOfferRecord {
  readonly quiet: readonly QuietOffer[]
}

export const MAX_QUIET_OFFERS = 16

const CID = /^b[a-z2-7]{20,200}$/

function parseQuiet (entry: unknown): QuietOffer | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const { cid, verified } = entry as Record<string, unknown>
  return typeof cid === 'string' && CID.test(cid) && typeof verified === 'boolean' ? { cid, verified } : undefined
}

export function parseUpdateOffer (raw: unknown): UpdateOfferRecord {
  if (typeof raw !== 'object' || raw === null) return { quiet: [] }
  const quiet = (raw as Record<string, unknown>).quiet
  if (!Array.isArray(quiet)) return { quiet: [] }
  const entries = quiet.flatMap((entry) => parseQuiet(entry) ?? [])
  return { quiet: entries.slice(-MAX_QUIET_OFFERS) }
}

export function isQuiet (record: UpdateOfferRecord, cid: string, verified: boolean): boolean {
  return record.quiet.some((entry) => entry.cid === cid && entry.verified === verified)
}

/** `record` with `offer` added as the newest entry, the oldest dropped past the cap. */
export function withQuiet (record: UpdateOfferRecord, offer: QuietOffer): UpdateOfferRecord {
  if (isQuiet(record, offer.cid, offer.verified)) return record
  return { quiet: [...record.quiet, offer].slice(-MAX_QUIET_OFFERS) }
}

/** `origin`'s record, read through `storage`; never throws. */
export async function readQuietOffers (storage: Pick<LoaderStorage, 'readUpdateOffer'>, origin: string): Promise<UpdateOfferRecord> {
  try {
    return parseUpdateOffer(await storage.readUpdateOffer(origin))
  } catch {
    return { quiet: [] }
  }
}

/** Best effort: a lost write costs one more question, never correctness. */
export async function writeQuietOffer (storage: Pick<LoaderStorage, 'readUpdateOffer' | 'writeUpdateOffer'>, origin: string, offer: QuietOffer): Promise<void> {
  try {
    await storage.writeUpdateOffer(origin, withQuiet(await readQuietOffers(storage, origin), offer))
  } catch (error) {
    console.error('[loader] could not record a quiet update offer', origin, error)
  }
}
