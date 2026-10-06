// The consent a person gave, kept once per computer user (consent.json in the telemetry home), not
// once per profile: one switch for every profile and for source and installed runs alike. Pure; the
// file read and write live in system-store.ts.
import type { ConsentState } from './disclosure.js'

/**
 * Bump on any change to what is sent or to the notice that describes it: an acceptance given under an
 * older version no longer counts, so nothing is sent until the person chooses again.
 */
export const NOTICE_VERSION = 3

export type ConsentSource = 'welcome' | 'settings'

export interface ConsentRecord {
  readonly state: ConsentState
  readonly atMs: number
  readonly noticeVersion: number
  readonly source: ConsentSource
  /** Whether the person ever accepted: only then can anything have been sent under an install ID, and so be deleted. */
  readonly everAccepted: boolean
}

export const UNDECIDED: ConsentRecord = { state: 'undecided', atMs: 0, noticeVersion: 0, source: 'welcome', everAccepted: false }

/** After a refusal, no surface asks again for this long. */
export const NO_REASK_MS = 183 * 24 * 60 * 60 * 1000

/** Reads consent.json's text; anything unreadable or malformed is no choice at all. */
export function parseConsentRecord (raw: string | undefined): ConsentRecord {
  if (raw === undefined) return UNDECIDED
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return UNDECIDED
  }
  if (typeof data !== 'object' || data === null) return UNDECIDED
  const obj = data as Record<string, unknown>
  if (obj['state'] !== 'accepted' && obj['state'] !== 'declined') return UNDECIDED
  if (typeof obj['atMs'] !== 'number' || !Number.isFinite(obj['atMs'])) return UNDECIDED
  if (typeof obj['noticeVersion'] !== 'number') return UNDECIDED
  const source: ConsentSource = obj['source'] === 'settings' ? 'settings' : 'welcome'
  const everAccepted = obj['state'] === 'accepted' || obj['everAccepted'] === true
  return { state: obj['state'], atMs: obj['atMs'], noticeVersion: obj['noticeVersion'], source, everAccepted }
}

export function serializeConsentRecord (record: ConsentRecord): string {
  return JSON.stringify(record, null, 2)
}

/** What counts now: an acceptance given under another notice version reads as no choice. */
export function effectiveConsent (record: ConsentRecord, noticeVersion: number = NOTICE_VERSION): ConsentState {
  if (record.state === 'accepted' && record.noticeVersion !== noticeVersion) return 'undecided'
  return record.state
}

export function recordChoice (state: 'accepted' | 'declined', atMs: number, source: ConsentSource, noticeVersion: number = NOTICE_VERSION, previous: ConsentRecord = UNDECIDED): ConsentRecord {
  return { state, atMs, noticeVersion, source, everAccepted: state === 'accepted' || previous.everAccepted }
}

/** Whether any surface may put the question to the person now. */
export function mayAskAgain (record: ConsentRecord, nowMs: number, noticeVersion: number = NOTICE_VERSION): boolean {
  const state = effectiveConsent(record, noticeVersion)
  if (state === 'undecided') return true
  if (state === 'accepted') return false
  return nowMs - record.atMs >= NO_REASK_MS
}

/** The welcome screen's box: shown only while the system consent is open and no refusal is recent. */
export function shouldOfferAtWelcome (record: ConsentRecord, nowMs: number, noticeVersion: number = NOTICE_VERSION): boolean {
  return effectiveConsent(record, noticeVersion) === 'undecided' && mayAskAgain(record, nowMs, noticeVersion)
}
