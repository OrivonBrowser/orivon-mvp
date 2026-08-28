// Icons built at runtime, one per dynamic list item (a tab, a bookmark) --
// the toolbar's fixed icons live as static inline SVG in index.html
// instead, the same split the previous version of this file already used
// for the tab strip's close icon.
//
// Never innerHTML (security-model.md T1/T10/T12/T17) -- every element
// here is built through createElementNS, even though none of this data
// is currently attacker-controlled.
//
// Path data for globeIcon/closeIcon is hand-ported from lucide's `globe`
// and `x` icons (ISC licence, https://lucide.dev) onto their own default
// attributes (24x24 viewBox, stroke-width 2, round caps/joins) -- this
// keeps the exact glyph shape used in orivon-browser-v2 (visual reference
// only, ADR-0002) without adding lucide-react or any icon library as a
// dependency (Rule 8; ADR-0002 -- TypeScript only, this renderer has no
// framework).

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg (viewBox: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', viewBox)
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('aria-hidden', 'true')
  return el
}

function path (d: string, strokeWidth: string): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path')
  el.setAttribute('d', d)
  el.setAttribute('stroke-width', strokeWidth)
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  return el
}

/** Generic favicon stand-in -- used for bookmarks-bar items (which never
 * carry a real favicon) and as the tab strip's fallback when a tab has
 * no real favicon yet, or its favicon fails to load (main.ts). Real tab
 * favicons themselves are fetched by src/main/favicon.ts. */
export function globeIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M21.54 15H17a2 2 0 0 0-2 2v4.54', '2'),
    path('M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17', '2'),
    path('M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05', '2'),
    circle(12, 12, 10)
  )
  return el
}

function circle (cx: number, cy: number, r: number): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, 'circle')
  el.setAttribute('cx', String(cx))
  el.setAttribute('cy', String(cy))
  el.setAttribute('r', String(r))
  el.setAttribute('stroke-width', '2')
  return el
}

/** The tab strip's close (x) button. Ported from main.ts, unchanged --
 * moved here so every runtime-built icon lives in one file. */
export function closeIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(path('M18 6 6 18', '2.5'), path('m6 6 12 12', '2.5'))
  return el
}
