// Hand-drawn inline SVG, no icon library (Rule 8; src/renderer/README.md).
// Path data hand-ported from lucide's own icon set (ISC licence,
// https://lucide.dev) onto its default attributes -- the SAME shield path
// index.html's own `#web3-score-btn` already uses, so this popup's Web3
// Score icon can never drift from the toolbar's.

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg (viewBox: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', viewBox)
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '2')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  el.setAttribute('aria-hidden', 'true')
  return el
}

function path (d: string): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path')
  el.setAttribute('d', d)
  return el
}

export function shieldIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-shield')
  el.append(path('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'))
  return el
}

export function chevronIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-chevron')
  el.append(path('m9 18 6-6-6-6'))
  return el
}

export function backIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon-back')
  el.append(path('m15 18-6-6 6-6'))
  return el
}
