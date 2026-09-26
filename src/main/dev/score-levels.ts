// Developer-only overrides of the Web3 Score levels (queue: web3-score-shield
// lane). No provider and no peer-to-peer fetch exist in this build, so
// Website Level 3/4 and Delivery Level 3 are unreachable by any real site --
// this file lets an origin's DISPLAYED level be forced, for previewing the
// shield and panel, exactly the way `./eth-resolver.ts` lets a fake `.eth`
// name stand in for a real one: only in developer mode
// (`devModeEnabled()`, `ORIVON_DEV_ORIGINS=1`, set only by `scripts/dev.mjs`),
// from one named env var, read once, logged loudly. An override is never
// wired to window.orivon, IPC or any renderer-reachable surface for its OWN
// effect -- it only changes what `../browsing/site-trust.ts` reports back
// out, the same "reachable only from code already running in this process"
// posture as everything else in this directory.
//
// One file, one gate, for BOTH axes (website and delivery) rather than two
// dev modules for the same idea (code-guidelines.md Rule 3) -- a real
// provider will eventually answer both anyway.

import { readFileSync } from 'node:fs'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { DeliveryLevel } from '../../trust/delivery-ladder.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import { devModeEnabled } from './dev-mode.js'

export interface ScoreLevelOverrides {
  readonly website: ReadonlyMap<string, ScoreLevel>
  readonly delivery: ReadonlyMap<string, DeliveryLevel>
}

const NONE: ScoreLevelOverrides = { website: new Map(), delivery: new Map() }

function isScoreLevel (value: unknown): value is ScoreLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
}

function isDeliveryLevel (value: unknown): value is DeliveryLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3
}

/**
 * `{ "<origin>": { website?, delivery? } }` to two maps, keyed by the SAME
 * canonical origin `originFromUrl` produces everywhere else in this
 * codebase. A key kept only if it round-trips (`originFromUrl(key) ===
 * key`) -- this file reads a map from OUTSIDE this process, and a key that
 * does not already match the canonical form would otherwise silently miss
 * every real lookup rather than fail loudly once, here.
 */
function validOverrides (raw: Readonly<Record<string, unknown>>): { website: Map<string, ScoreLevel>, delivery: Map<string, DeliveryLevel>, accepted: string[], dropped: string[] } {
  const website = new Map<string, ScoreLevel>()
  const delivery = new Map<string, DeliveryLevel>()
  const accepted: string[] = []
  const dropped: string[] = []

  for (const [origin, value] of Object.entries(raw)) {
    if (originFromUrl(origin) !== origin || typeof value !== 'object' || value === null || Array.isArray(value)) {
      dropped.push(origin)
      continue
    }
    const entry = value as Record<string, unknown>
    const parts: string[] = []
    if ('website' in entry) {
      if (isScoreLevel(entry['website'])) {
        website.set(origin, entry['website'])
        parts.push(`website=L${String(entry['website'])}`)
      } else {
        dropped.push(`${origin} (website)`)
      }
    }
    if ('delivery' in entry) {
      if (isDeliveryLevel(entry['delivery'])) {
        delivery.set(origin, entry['delivery'])
        parts.push(`delivery=D${String(entry['delivery'])}`)
      } else {
        dropped.push(`${origin} (delivery)`)
      }
    }
    if (parts.length > 0) accepted.push(`${origin}: ${parts.join(', ')}`)
  }

  return { website, delivery, accepted, dropped }
}

/**
 * The overrides file's entries, read once. Empty unless `devModeEnabled()`
 * and `ORIVON_SCORE_LEVELS_FILE` are both set, which is every run that is
 * not demonstrating this one feature. A broken or missing file is reported
 * once, loudly, and changes nothing else about how the shell starts --
 * matching `./eth-resolver.ts`'s `readDevEthNames`.
 */
export function readScoreLevelOverrides (): ScoreLevelOverrides {
  if (!devModeEnabled()) return NONE
  const path = process.env['ORIVON_SCORE_LEVELS_FILE']
  if (path === undefined) return NONE
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object of "origin": { website?, delivery? }')
    }
    const { website, delivery, accepted, dropped } = validOverrides(parsed as Record<string, unknown>)
    if (accepted.length > 0) console.error(`[orivon] Web3 Score level overrides active (ORIVON_DEV_ORIGINS=1): ${accepted.join('; ')}`)
    if (dropped.length > 0) console.error(`[orivon] ${path} dropped these entries (bad origin or level): ${dropped.join(', ')}`)
    return { website, delivery }
  } catch (error) {
    console.error(`[orivon] ORIVON_SCORE_LEVELS_FILE (${path}) could not be read as an overrides map:`, error)
    return NONE
  }
}

let cached: ScoreLevelOverrides | undefined

/** `readScoreLevelOverrides()`, read once per run: the file is read at startup and never again. */
function scoreLevelOverrides (): ScoreLevelOverrides {
  cached ??= readScoreLevelOverrides()
  return cached
}

export function scoreLevelOverrideFor (origin: string): ScoreLevel | undefined {
  return scoreLevelOverrides().website.get(origin)
}

export function deliveryLevelOverrideFor (origin: string): DeliveryLevel | undefined {
  return scoreLevelOverrides().delivery.get(origin)
}
