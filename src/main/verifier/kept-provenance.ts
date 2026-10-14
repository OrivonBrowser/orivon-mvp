// The last thing the verifier proved about each site a tab showed. The verifier host forgets a mount after ten
// minutes, a restart or a failed re-proof, and that is a failure to look, not evidence about the site: the Website
// level a site earned stays until a look shows otherwise (README.md's Design notes).

import type { SiteProvenance } from '../../protocols/verifier-host/protocol.js'

const MAX_SITES = 64

export interface KeptProvenance {
  /** `fresh` when the verifier answered now, else the last answer for `key`. `kept` says which. */
  readonly resolve: (key: string, fresh: SiteProvenance | null) => { readonly provenance: SiteProvenance | null, readonly kept: boolean }
  readonly forgetAll: () => void
}

export function createKeptProvenance (max: number = MAX_SITES): KeptProvenance {
  const last = new Map<string, SiteProvenance>()
  return {
    resolve (key, fresh) {
      if (fresh === null) {
        const before = last.get(key)
        return { provenance: before ?? null, kept: before !== undefined }
      }
      last.delete(key)
      last.set(key, fresh)
      if (last.size > max) last.delete(last.keys().next().value as string)
      return { provenance: fresh, kept: false }
    },
    forgetAll: () => { last.clear() }
  }
}

/** What the verifier last proved for each site shown, for the moments it cannot be asked. */
export const lastProvenance = createKeptProvenance()

/** Clearing site data, the cache or all history: no site is shown with a level it earned before. */
export function forgetKeptProvenance (): void {
  lastProvenance.forgetAll()
}
