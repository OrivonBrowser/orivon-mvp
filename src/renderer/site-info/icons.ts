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

/** An arch-shaped portal: the tunnel in the address bar's button (`../index.html` draws the same shape) and the logo-less SOCKS5 row. */
export function tunnelIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-tunnel')
  el.append(path('M4 21V11a8 8 0 0 1 16 0v10', '2'), path('M9 21v-9a3 3 0 0 1 6 0v9', '2'), path('M2 21h20', '2'))
  return el
}
