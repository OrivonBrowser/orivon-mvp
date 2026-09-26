// The site-info popover's Web3 Score page: the Website level this browser
// can observe (1 or 2; `../../trust/website-level.ts`), and beneath it the
// evidence it rests on. Pure -- no `electron`, and no `../../loader/electron-
// serve.js` import: the caller (../permissions/site-info-controller.ts)
// already reads `Loader.pinFor`, the loader's `isOriginServedFromCacheSync`/
// `pinCoverageFor` and the verifier's evidence for a `.eth` name, so this
// file takes what those return rather than reaching for them itself.
// Connections and operations stay unobserved: the broker keeps no
// connection log (`src/trust/README.md`), and the popover says so.

import { deliveryLadder } from '../../trust/delivery-ladder.js'
import type { DeliveryLadderResult, DeliveryLevel, PinCoverageEvidence } from '../../trust/delivery-ladder.js'
import { ddocVerdict } from '../../trust/ddoc.js'
import type { DdocVerdict, PublishedTree } from '../../trust/ddoc.js'
import { displayedLevel, websiteLevel } from '../../trust/website-level.js'
import type { ScoreLevel, WebsiteLevel } from '../../trust/website-level.js'
import type { PinRecord } from '../../broker/policy/pin.js'
import type { EvidenceRow, NameEvidence } from '../verifier/name-evidence.js'

export type ConnectionState = 'secure' | 'insecure' | 'cached'

export interface SiteTrust {
  readonly connection: ConnectionState
  readonly level: WebsiteLevel
  readonly delivery: DeliveryLadderResult
  /** `undefined` when never pinned -- mirrors `delivery.evidence.pinned`, split out so a caller need not reach into delivery evidence for what is really identity, not a trust fact. */
  readonly pin: { readonly bundleHash: string, readonly version: string, readonly pinnedAt: number } | undefined
  /** The pinned bundle against the hash tree the site published with it (ADR-0029). */
  readonly ddoc: DdocVerdict
  /** How a `.eth` name led to this page's content; `undefined` for any other origin. */
  readonly name: { readonly line: string, readonly rows: readonly EvidenceRow[] } | undefined
  /** A developer-only override of the Website level (`../dev/score-levels.ts`), for previewing
   * Level 3/4 before a real Web3 Score provider exists. `undefined` outside developer mode, or
   * when this origin has none. Never folded into `level` above -- `level.level` stays exactly
   * what this browser observed. */
  readonly levelOverride: ScoreLevel | undefined
  /** `level.level`, or `levelOverride` when one exists -- what every surface should actually
   * show (`../../trust/website-level.js`'s `displayedLevel`). */
  readonly displayedLevel: ScoreLevel
  /** The same override mechanism, for the Delivery level (`../../trust/delivery-ladder.js`). */
  readonly deliveryOverride: DeliveryLevel | undefined
  /** `delivery.level`, or `deliveryOverride` when one exists. */
  readonly displayedDelivery: DeliveryLevel
}

/** The toolbar shield's own IPC reply -- the smallest slice of `SiteTrust` it needs, so the
 * chrome view never has to reach into the full popover payload (evidence rows, pin details) it
 * has no use for. `overridden`/`deliveryOverridden` let the shield's tooltip name a developer
 * override rather than presenting it as observed (ADR-0006). */
export interface Web3Score {
  readonly level: ScoreLevel
  readonly overridden: boolean
  readonly delivery: DeliveryLevel
  readonly deliveryOverridden: boolean
}

export function web3Score (trust: SiteTrust | null): Web3Score | null {
  if (trust === null) return null
  return {
    level: trust.displayedLevel,
    overridden: trust.levelOverride !== undefined,
    delivery: trust.displayedDelivery,
    deliveryOverridden: trust.deliveryOverride !== undefined
  }
}

/**
 * `origin` decides `connection`'s scheme half exactly the way the toolbar's
 * own dot does (`src/renderer/main.ts`'s `applyConnectionDot`: a plain
 * string-prefix check on the same canonical origin form
 * `originFromUrl` produces) -- so the two can never disagree about what an
 * ordinary `https://`/`http://` origin is. `cached` overrides both: a
 * cached app is neither claim, the same reasoning `updateAddressDot`'s own
 * `.cached` state already applies (ADR-0007).
 *
 * `currentFetchMatchesPin` is always `null`: this function runs against an
 * ALREADY-SERVED tab, with no live fetch in progress to compare against
 * the pin -- that comparison already happened, once, when the bundle was
 * installed or last served (`decideAndRoute`/`serve/verify.ts`). Claiming
 * a match here would be a guess dressed as an observation, exactly what
 * ADR-0006 exists to prevent. `pinHasChanged` is always `false`: `PinRecord`
 * keeps no history of a prior hash, so there is nothing here to claim
 * either way -- callers must not render this field (no rung reads it; see
 * `deliveryLadder` in `delivery-ladder.js`).
 *
 * `levelOverride`/`deliveryOverride` come from `../dev/score-levels.ts`, read
 * by the caller so this function stays free of `devModeEnabled()` --
 * matching every other optional fact here, supplied rather than fetched.
 */
export function buildSiteTrust (
  origin: string,
  pin: PinRecord | null,
  servedFromCache: boolean,
  pinCoverage: PinCoverageEvidence | undefined,
  published: PublishedTree | undefined,
  now: number,
  name?: NameEvidence,
  levelOverride?: ScoreLevel,
  deliveryOverride?: DeliveryLevel
): SiteTrust {
  const connection: ConnectionState = servedFromCache ? 'cached' : origin.startsWith('https://') ? 'secure' : 'insecure'

  const delivery = deliveryLadder({
    everPinned: pin !== null,
    pinnedAt: pin?.pinnedAt ?? null,
    now,
    deliveryMethod: servedFromCache ? 'served-from-pinned-cache' : 'fetched-each-load',
    currentFetchMatchesPin: null,
    pinHasChanged: false,
    addressIsContentAddressed: name?.content !== undefined,
    nameResolvedTrustlessly: name?.nameProven ?? false,
    // Omitted, never set to `undefined`, when there is none to report --
    // `exactOptionalPropertyTypes` treats those as different things for an
    // optional-alone field, and `DeliveryHistoryInput.pinCoverage` is one.
    ...(pinCoverage !== undefined ? { pinCoverage } : {})
  })

  const ddoc = ddocVerdict(pin, published)
  const level = websiteLevel(name?.content, ddoc, pin?.bundleHash, servedFromCache)
  return {
    connection,
    level,
    delivery,
    pin: pin === null ? undefined : { bundleHash: pin.bundleHash, version: pin.version, pinnedAt: pin.pinnedAt },
    ddoc,
    name: name === undefined ? undefined : { line: name.line, rows: name.rows },
    levelOverride,
    displayedLevel: displayedLevel(level.level, levelOverride),
    deliveryOverride,
    displayedDelivery: deliveryOverride ?? delivery.level
  }
}
