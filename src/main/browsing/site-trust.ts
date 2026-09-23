// The site-info popover's Web3 Score page: delivery evidence only, never a
// grade (ADR-0006, ARCHITECTURE.md's "trust is shown as observed behaviour,
// never as a grade"). Pure -- no `electron`, and no `../../loader/electron-
// serve.js` import: the caller (./site-info-ipc.js) already has to read
// `Loader.pinFor` and the loader's `isOriginServedFromCacheSync`/
// `pinCoverageFor` for other reasons, so this file takes what those return
// rather than reaching for them itself (matches `../../trust/`'s own rule
// of never importing another stream's internals one level further out).
//
// THE FIRST PRODUCTION CALLER OF `deliveryLadder`
// (`../../trust/delivery-ladder.js`) -- `src/trust/` has shipped since
// build step 6 opened with no caller anywhere in `src/` (A181,
// docs/open-questions.md). This is that caller, scoped to what a popover
// can honestly show without a connection log (`src/trust/README.md`'s own
// "Connections" and "Operations" stay unbuilt -- the popover renders them
// as "Not observed yet", never a guess).

import { deliveryLadder } from '../../trust/delivery-ladder.js'
import type { DeliveryLadderResult, PinCoverageEvidence } from '../../trust/delivery-ladder.js'
import type { PinRecord } from '../../broker/policy/pin.js'

export type ConnectionState = 'secure' | 'insecure' | 'cached'

export interface SiteTrust {
  readonly connection: ConnectionState
  readonly delivery: DeliveryLadderResult
  /** `undefined` when never pinned -- mirrors `delivery.evidence.pinned`, split out so a caller need not reach into delivery evidence for what is really identity, not a trust fact. */
  readonly pin: { readonly bundleHash: string, readonly version: string, readonly pinnedAt: number } | undefined
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
 * installed or last served (`decideAndRoute`/`serve-verify.ts`). Claiming
 * a match here would be a guess dressed as an observation, exactly what
 * ADR-0006 exists to prevent. `pinHasChanged` is always `false`: `PinRecord`
 * keeps no history of a prior hash, so there is nothing here to claim
 * either way -- callers must not render this field (no rung reads it; see
 * `metRung` in `delivery-ladder.js`).
 */
export function buildSiteTrust (
  origin: string,
  pin: PinRecord | null,
  servedFromCache: boolean,
  pinCoverage: PinCoverageEvidence | undefined,
  now: number
): SiteTrust {
  const connection: ConnectionState = servedFromCache ? 'cached' : origin.startsWith('https://') ? 'secure' : 'insecure'

  const delivery = deliveryLadder({
    everPinned: pin !== null,
    pinnedAt: pin?.pinnedAt ?? null,
    now,
    deliveryMethod: servedFromCache ? 'served-from-pinned-cache' : 'fetched-each-load',
    currentFetchMatchesPin: null,
    pinHasChanged: false,
    addressIsContentAddressed: false,
    nameResolvedTrustlessly: false,
    // Omitted, never set to `undefined`, when there is none to report --
    // `exactOptionalPropertyTypes` treats those as different things for an
    // optional-alone field, and `DeliveryHistoryInput.pinCoverage` is one.
    ...(pinCoverage !== undefined ? { pinCoverage } : {})
  })

  return {
    connection,
    delivery,
    pin: pin === null ? undefined : { bundleHash: pin.bundleHash, version: pin.version, pinnedAt: pin.pinnedAt }
  }
}
