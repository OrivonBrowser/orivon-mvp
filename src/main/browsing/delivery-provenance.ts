// ADR-0007's "the padlock is now misleading unless the UI corrects it" --
// this is the one truthful signal build step 4 owes the address bar: is the
// active tab's document actually being answered by Orivon's own pinned
// local cache (electron-serve.ts's protocol.handle registration), not a
// live network response. NOT the trust indicator (build step 7,
// mvp-scope.md Rule 4) -- one boolean, no grade, no score. See
// src/renderer/README.md's Design notes for the literal string this drives
// and why it is a separate query from the address-bar permissions badge.

import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCache } from '../../loader/electron-serve.js'

export interface DeliveryProvenance {
  readonly servedFromPinnedCache: boolean
}

const NOT_CACHED: DeliveryProvenance = { servedFromPinnedCache: false }

/**
 * `url`'s origin, asked of Electron's OWN protocol-handler registry
 * (`isOriginServedFromCache`) -- never the broker's `isRegisteredSync`,
 * which only means "a manifest is registered", not "this origin's own
 * scheme is actually being intercepted and answered from disk"
 * (`registerApp` and `registerServingFor` are two separate calls; see
 * src/loader/subsystem.ts's own header). Using the weaker signal here would
 * risk exactly what ADR-0007 calls unacceptable: showing "local cache,
 * pinned" for bytes that, this once, did not actually come from it.
 *
 * A `url` with no derivable origin (about:blank, a rejected navigation, the
 * dashboard) answers `false`, the same fail-closed default every other
 * provenance-adjacent check in this codebase uses.
 */
export async function deliveryProvenanceFor (url: string): Promise<DeliveryProvenance> {
  const origin = originFromUrl(url)
  if (origin === null) return NOT_CACHED
  return { servedFromPinnedCache: await isOriginServedFromCache(origin) }
}
