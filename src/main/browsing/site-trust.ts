// The site-info popover's Web3 Score page: the Website level this browser
// can observe (1 or 2; `../../trust/website-level.ts`), and beneath it the
// evidence it rests on. Pure -- no `electron`, and no `../../loader/electron-
// serve.js` import: the caller (../permissions/site-info-controller.ts)
// already reads `Loader.pinFor`, the loader's `isOriginServedFromCacheSync`/
// `pinCoverageFor` and the verifier's evidence for a `.eth` name, so this
// file takes what those return rather than reaching for them itself.
// Connections and operations stay unobserved: the broker keeps no
// connection log (`src/trust/README.md`). A Web3 Score provider's verdict is
// added afterwards by `withProviderVerdict`, judged, never observed.

import { deliveryLadder } from '../../trust/delivery-ladder.js'
import type { DeliveryLadderResult, DeliveryLevel, PinCoverageEvidence } from '../../trust/delivery-ladder.js'
import { ddocVerdict } from '../../trust/ddoc.js'
import type { DdocVerdict, PublishedTree } from '../../trust/ddoc.js'
import { displayedLevel, websiteLevel } from '../../trust/website-level.js'
import type { ScoreLevel, WebsiteLevel } from '../../trust/website-level.js'
import { scoreIdOf } from '../../trust/score-provider.js'
import { domainBinding, judgedLevelCounts, originHost } from '../../trust/domain-binding.js'
import type { DomainBinding, HomeFacts } from '../../trust/domain-binding.js'
import { canonicalCid } from '../../protocols/ipfs/names.js'
import type { ProviderVerdict } from '../../trust/score-provider.js'
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
  /** What the chosen Web3 Score provider said about this page's content identity. */
  readonly judged: ProviderVerdict
  /** `displayedLevel` is that provider's judged Level 3 or 4, not what this browser observed. */
  readonly judgedShown: boolean
  /** Whether the manifest of this page's content names this address as its home (`../../trust/domain-binding.ts`). */
  readonly binding: DomainBinding
  /** The `domain` that manifest names, when it names one. */
  readonly homeDomain: string | undefined
  /** A provider judged this content Level 3 or 4, but not at this address, so the level is not counted here. */
  readonly judgedElsewhere: boolean
  /** The manifest of this page's content was still being read; asking again soon gets the answer. */
  readonly homePending: boolean
  /** `level.level`, a judged level over it, or `levelOverride` -- what every surface should
   * actually show (`../../trust/website-level.js`'s `displayedLevel`). */
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
  /** The provider whose judgement `level` is, when it is one. */
  readonly judgedBy: string | undefined
  /** The provider was still being asked; asking again soon gets its answer. */
  readonly pending: boolean
  readonly delivery: DeliveryLevel
  readonly deliveryOverridden: boolean
  /** The level rests on a DDOC counted only because a local origin is running in developer mode. */
  readonly localDev: boolean
}

export function web3Score (trust: SiteTrust | null): Web3Score | null {
  if (trust === null) return null
  const overridden = trust.levelOverride !== undefined
  return {
    level: trust.displayedLevel,
    overridden,
    judgedBy: trust.judgedShown && trust.judged.status === 'judged' ? trust.judged.provider.name : undefined,
    pending: trust.judged.status === 'pending' || trust.homePending,
    delivery: trust.displayedDelivery,
    deliveryOverridden: trust.deliveryOverride !== undefined,
    localDev: trust.ddoc.status === 'local-dev'
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
 * `levelOverride`/`deliveryOverride` come from `../dev/score-levels.ts`, and
 * `localDevHash` from `../dev/local-ddoc.ts`, read by the caller so this
 * function stays free of `devModeEnabled()` -- matching every other optional
 * fact here, supplied rather than fetched.
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
  deliveryOverride?: DeliveryLevel,
  localDevHash?: string
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

  const ddoc = ddocVerdict(pin, published, localDevHash !== undefined)
  const level = websiteLevel(name?.content, ddoc, pin?.bundleHash ?? localDevHash, servedFromCache)
  return {
    connection,
    level,
    delivery,
    pin: pin === null ? undefined : { bundleHash: pin.bundleHash, version: pin.version, pinnedAt: pin.pinnedAt },
    ddoc,
    name: name === undefined ? undefined : { line: name.line, rows: name.rows },
    levelOverride,
    judged: { status: 'off' },
    judgedShown: false,
    binding: 'not-applicable',
    homeDomain: undefined,
    judgedElsewhere: false,
    homePending: false,
    displayedLevel: displayedLevel(level.level, levelOverride),
    deliveryOverride,
    displayedDelivery: deliveryOverride ?? delivery.level
  }
}

/** The page's content identity, in the form a Web3 Score provider files it under, when DDOC holds:
 * a judged level describes the files an identifier names, and only Level 2 shows those were served. */
export function providerIdFor (trust: SiteTrust): string | undefined {
  const { level, assessable } = trust.level
  if (level !== 2 || assessable === undefined) return undefined
  // A root reached through IPNS or a DNSLink can be a CIDv0; a provider files CIDs as v1.
  const value = assessable.kind === 'cid' ? canonicalCid(assessable.value) : assessable.value
  return value === undefined ? undefined : scoreIdOf({ kind: assessable.kind, value })
}

/** What the page's own manifest says about where it lives: its binding at this origin, and the name it gives. */
export interface Home {
  readonly binding: DomainBinding
  readonly domain: string | undefined
  /** The manifest was still being read. */
  readonly pending?: boolean
}

export function homeAt (origin: string, facts: HomeFacts, pending = false): Home {
  return { binding: domainBinding(originHost(origin), facts), domain: facts.kind === 'app' ? facts.domain : undefined, pending }
}

/**
 * A judged level counts only where `home` binds it (ADR-0055). Where it does not, the
 * verdict stays on the trust for the page to explain, and the displayed level is what this
 * browser observed.
 */
export function withProviderVerdict (trust: SiteTrust, judged: ProviderVerdict, home: Home): SiteTrust {
  const judgedLevel = judged.status === 'judged' ? judged.evaluation.trustlessity.level : undefined
  const counted = judgedLevelCounts(home.binding)
  const shown = displayedLevel(trust.level.level, trust.levelOverride, counted ? judgedLevel : undefined)
  const observedOrOverride = displayedLevel(trust.level.level, trust.levelOverride)
  const wouldShow = displayedLevel(trust.level.level, trust.levelOverride, judgedLevel) !== observedOrOverride
  return {
    ...trust,
    judged,
    judgedShown: shown !== observedOrOverride,
    judgedElsewhere: !counted && wouldShow,
    binding: home.binding,
    homeDomain: home.domain,
    homePending: home.pending === true,
    displayedLevel: shown
  }
}
