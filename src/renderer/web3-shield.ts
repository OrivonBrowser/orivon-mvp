// The Web3 Score shield and the Web2 / Web2.5 / Web3 mark, both painted from
// one displayed Website level. The shield is shared between the toolbar
// (`main.ts`) and the site-info popup's connection row
// (`site-info/main-view.ts`), so the two can never draw it differently; the
// mark sits only at the right end of the address pill.
//
// The shield never changes shape: the same outline a new tab shows, grey
// until a level is known, then stroked in that level's colour
// (`styles/web3-level.css`). Painting only sets attributes, so a repaint never
// rebuilds either element.

import { siteClassOfLevel } from '../trust/site-class.js'
import type { ScoreLevel } from '../trust/website-level.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import { path, svg } from './icons.js'

/** lucide's `shield` (ISC licence), the icon set `index.html`'s other toolbar buttons are drawn from. */
const SHIELD_PATH = 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'

export type Web3Mark = 'Web2' | 'Web2.5' | 'Web3'

/** Level 1 is Web2, Levels 2 and 3 are Web2.5, Level 4 is Web3. */
export function web3Mark (level: ScoreLevel): Web3Mark {
  const siteClass = siteClassOfLevel(level)
  return siteClass === 'web2' ? 'Web2' : siteClass === 'web3' ? 'Web3' : 'Web2.5'
}

/** Builds the shield element, in its "no level yet" state. */
export function web3Shield (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('web3-shield')
  el.append(path(SHIELD_PATH, '2'))
  return el
}

/** `null` is "no level yet": a new tab, or a query still in flight. */
export function paintShield (el: SVGSVGElement, level: ScoreLevel | null): void {
  if (level === null) delete el.dataset['level']
  else el.dataset['level'] = String(level)
}

/** Hidden with no level, so a new tab carries no mark at all. */
export function paintMark (el: HTMLElement, level: ScoreLevel | null): void {
  el.hidden = level === null
  if (level === null) {
    delete el.dataset['mark']
    el.textContent = ''
    return
  }
  const mark = web3Mark(level)
  el.dataset['mark'] = mark
  el.textContent = mark
}

/** The tooltip/`aria-label` text: the Website level, and anything that
 * makes it less than observed, a provider's judgement included (ADR-0006).
 * The popup's own connection row carries the fuller glance. */
export function shieldLabel (score: Web3Score | null): string {
  if (score === null) return 'Web3 Score'
  const base = `Website level ${String(score.level)} (${web3Mark(score.level)})`
  if (score.overridden) return `${base} (developer override)`
  const judged = score.judgedBy === undefined ? base : `${base}, judged by ${score.judgedBy}`
  return score.localDev ? `${judged} (developer mode)` : judged
}
