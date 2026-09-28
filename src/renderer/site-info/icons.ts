// Hand-drawn inline SVG, no icon library (Rule 8; src/renderer/README.md).
// Path data hand-ported from lucide's own icon set (ISC licence,
// https://lucide.dev) onto its default attributes. `svg`/`path` come from
// `../icons.js` -- one pair of primitives, not a second copy here
// (code-guidelines.md Rule 3). The Web3 Score shield itself lives in
// `../web3-shield.ts`, shared with the toolbar so the two can never draw it
// differently.

import { path, svg } from '../icons.js'

export function chevronIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-chevron')
  el.append(path('m9 18 6-6-6-6', '2'))
  return el
}

export function backIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-back')
  el.append(path('m15 18-6-6 6-6', '2'))
  return el
}
