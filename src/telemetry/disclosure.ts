// What telemetry sends and when it may: the payloads exactly as they go on the wire (the Settings
// page shows them as literal JSON), the consent state, and the one guard every send consults. Pure:
// no electron, no I/O, no clock, no randomness. Every value the payloads need beyond the counted
// time is passed in, and everything produced is returned, never written anywhere.
import { SHELL_APP_ID, type AccountingState, type Period } from './accounting.js'
import type { Country } from './country.js'
import { classOfKey, reportedKey, UNLISTED } from './site-key.js'

export const PAYLOAD_SCHEMA = 4

/** What the install ID reads before the person has turned telemetry on: the machine is not read until then. */
export const INSTALL_ID_PLACEHOLDER = '(made when you turn this on)'

/** At most this many names in one report; the server refuses more. */
export const MAX_REPORTED_SITES = 300

export interface ClassSeconds {
  readonly web3: number
  readonly web25: number
  readonly web2: number
}

/** `POST /v1/usage`: the whole browser's time this month so far, and its split by kind of site. */
export interface UsagePayload {
  readonly schema: typeof PAYLOAD_SCHEMA
  readonly installId: string
  readonly stream: string
  readonly country: Country
  readonly version: string
  readonly period: Period
  readonly activeSec: number
  readonly backgroundSec: number
  readonly classes: ClassSeconds
}

/**
 * `POST /v1/sites`: seconds on each Web3 and Web2.5 site this month so far. It goes under the same
 * install ID and stream as the usage report, so a forged one can be told apart and erased.
 */
export interface SitesPayload {
  readonly schema: typeof PAYLOAD_SCHEMA
  readonly installId: string
  readonly stream: string
  readonly version: string
  readonly period: Period
  readonly sites: Readonly<Record<string, number>>
}

/** `POST /v1/erase`: a request to delete everything held under this install ID. */
export interface ErasePayload {
  readonly schema: typeof PAYLOAD_SCHEMA
  readonly installId: string
}

export type SentPayload = UsagePayload | SitesPayload
export type PayloadKind = 'usage' | 'sites'

export interface UsageMeta {
  readonly installId: string
  readonly stream: string
  readonly country: Country
  readonly version: string
  readonly period: Period
}

export interface SitesMeta {
  readonly installId: string
  readonly stream: string
  readonly version: string
  readonly period: Period
}

/** Whole seconds: accounting keeps fractions, and this is the one place they are rounded. */
function whole (seconds: number): number {
  return Math.round(seconds)
}

function classSeconds (state: AccountingState, period: Period): ClassSeconds {
  const sums = { web3: 0, web25: 0, web2: 0 }
  for (const [key, seconds] of Object.entries(state.perSite[period] ?? {})) {
    const kind = classOfKey(key)
    if (kind !== undefined) sums[kind] += seconds
  }
  return { web3: whole(sums.web3), web25: whole(sums.web25), web2: whole(sums.web2) }
}

/** Seconds per named Web3 and Web2.5 site, rounded, zeros dropped; the smallest names past the cap fold into their class's `(unlisted)`. */
function reportedSites (state: AccountingState, period: Period): Record<string, number> {
  const byLabel = new Map<string, number>()
  for (const [key, seconds] of Object.entries(state.perSite[period] ?? {})) {
    const kind = classOfKey(key)
    if (kind !== 'web3' && kind !== 'web25') continue
    const label = reportedKey(key)
    byLabel.set(label, (byLabel.get(label) ?? 0) + seconds)
  }
  const named = [...byLabel].filter(([label]) => !label.endsWith(`:${UNLISTED}`)).sort((a, b) => b[1] - a[1])
  const totals = new Map<string, number>([...byLabel].filter(([label]) => label.endsWith(`:${UNLISTED}`)))
  named.forEach(([label, seconds], index) => {
    // Two places stay free for the two `(unlisted)` labels.
    const key = index < MAX_REPORTED_SITES - 2 ? label : `${label.slice(0, label.indexOf(':'))}:${UNLISTED}`
    totals.set(key, (totals.get(key) ?? 0) + seconds)
  })
  const out: Record<string, number> = {}
  for (const [label, seconds] of totals) {
    const rounded = whole(seconds)
    if (rounded > 0) out[label] = rounded
  }
  return out
}

export function buildUsagePayload (state: AccountingState, meta: UsageMeta): UsagePayload {
  const totals = state.perApp[SHELL_APP_ID]?.[meta.period]
  return {
    schema: PAYLOAD_SCHEMA,
    installId: meta.installId,
    stream: meta.stream,
    country: meta.country,
    version: meta.version,
    period: meta.period,
    activeSec: whole(totals?.activeSec ?? 0),
    backgroundSec: whole(totals?.backgroundSec ?? 0),
    classes: classSeconds(state, meta.period)
  }
}

export function buildSitesPayload (state: AccountingState, meta: SitesMeta): SitesPayload {
  return { schema: PAYLOAD_SCHEMA, installId: meta.installId, stream: meta.stream, version: meta.version, period: meta.period, sites: reportedSites(state, meta.period) }
}

export function buildErasePayload (installId: string): ErasePayload {
  return { schema: PAYLOAD_SCHEMA, installId }
}

/** A sites report with no site in it says nothing, so none is sent. */
export function hasSites (payload: SitesPayload): boolean {
  return Object.keys(payload.sites).length > 0
}

// The consent state: undecided is a real third value

/** What a completed choice settles into. */
export type DecidedConsentState = 'accepted' | 'declined'

/** Three distinct values, not a boolean: a boolean has no room for "no choice yet" without overloading "declined". */
export type ConsentState = 'undecided' | DecidedConsentState

/** What a person who has not chosen starts in. */
export const initialConsentState: ConsentState = 'undecided'

/** The one function a send is required to consult first. Silence is not consent. */
export function mayTransmit (state: ConsentState): boolean {
  return state === 'accepted'
}
