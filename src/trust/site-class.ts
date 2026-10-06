// The three names a Website level goes by when a surface groups sites rather than rating one:
// Level 1 is Web2, Levels 2 and 3 are Web2.5, Level 4 is Web3. The address bar's mark and the
// usage report both read it here, so the two can never disagree about which site is which.
import type { ScoreLevel } from './website-level.js'

export type SiteClass = 'web2' | 'web25' | 'web3'

export function siteClassOfLevel (level: ScoreLevel): SiteClass {
  if (level === 1) return 'web2'
  return level === 4 ? 'web3' : 'web25'
}
