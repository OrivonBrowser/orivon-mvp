// The Web3 Score shield -- shared between the toolbar (`main.ts`) and the
// site-info popup's connection row (`site-info/main-view.ts`), so the two
// can never draw it differently (matching `site-info/icons.ts`'s own header
// on why THAT copy exists: one implementation, one place a colour or shape
// could drift from the other).
//
// Two shapes, not one recoloured: with no level yet (a new tab, or a query
// still in flight) it stays today's plain grey outline, unchanged from
// before this level-coloured shield existed. Once a level is known it
// switches to a wider, filled badge -- L1/L4 carry a bold "Web2"/"Web3"
// label, L2/L3 stay plain (owner decision: the filled shape is the legible
// one at toolbar size, the outline is not). `paintShield` rebuilds the
// shield's children on every call rather than mutating in place: repaints
// only happen on a tab switch or a load finishing, never per frame, so the
// cost of a full rebuild is not one this file needs to avoid.
//
// The shield no longer signals whether a page is served from Orivon's own
// pinned cache (ADR-0007's old "running from local cache, pinned" state).
// That returns with a future "store this Web3site locally" affordance, not
// here (owner, see ADR-0007's amendment) -- so there is no tooltip text to
// preserve for it, and none is added back.

import type { ScoreLevel } from '../trust/website-level.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import { path, svg } from './icons.js'

/** Hand-drawn (Rule 8; README.md), NOT lucide's shield -- that one is
 * narrow (24x24) and reads poorly widened. Flat top, rounded corners,
 * tapering to a point at the bottom centre, in a 28x20 box. */
const WIDE_SHIELD_PATH = 'M3 0 L25 0 Q28 0 28 3 L28 9 C28 14 22 15.5 14 20 C6 15.5 0 14 0 9 L0 3 Q0 0 3 0 Z'

/** Today's narrow outline shield (`index.html`'s former static markup),
 * unchanged -- kept for the "no level yet" state only. */
const NARROW_SHIELD_PATH = 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'

function widePath (level: ScoreLevel): SVGPathElement {
  const el = path(WIDE_SHIELD_PATH, '0')
  el.classList.add('web3-shield-fill')
  el.dataset['level'] = String(level)
  return el
}

function wideLabel (level: 1 | 4): SVGTextElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'text')
  el.setAttribute('x', '14')
  el.setAttribute('y', '8')
  el.classList.add('web3-shield-label')
  el.textContent = level === 1 ? 'Web2' : 'Web3'
  return el
}

/** Builds the shield element, in its "no level yet" state -- call
 * `paintShield` to show a real level once one is known. */
export function web3Shield (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('web3-shield')
  el.append(path(NARROW_SHIELD_PATH, '2'))
  return el
}

/** Repaints an existing shield element to show `level`, or back to the
 * plain outline for `null` (no level yet). */
export function paintShield (el: SVGSVGElement, level: ScoreLevel | null): void {
  el.replaceChildren()
  if (level === null) {
    el.classList.remove('leveled')
    el.setAttribute('viewBox', '0 0 24 24')
    el.append(path(NARROW_SHIELD_PATH, '2'))
    return
  }
  el.classList.add('leveled')
  el.setAttribute('viewBox', '0 0 28 20')
  el.append(widePath(level))
  if (level === 1 || level === 4) el.append(wideLabel(level))
}

/** The shield's tooltip/`aria-label` text -- the Website level alone. The
 * popup's own connection row carries the fuller glance (level, delivery,
 * connection) already; this is the toolbar's smaller surface. */
export function shieldLabel (score: Web3Score | null): string {
  if (score === null) return 'Web3 Score'
  const ends = score.level === 1 ? ' (Web2)' : score.level === 4 ? ' (Web3)' : ''
  const base = `Website level ${String(score.level)}${ends}`
  return score.overridden ? `${base} (developer override)` : base
}
