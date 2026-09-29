// The five DOM-builder primitives every hand-drawn icon in Orivon is
// assembled from (code-guidelines.md Rule 3) -- one implementation, not a
// copy in the chrome's own icons.ts and again in each page's icon set.
// Lives under pages/shared/ (not the chrome's icons.ts) so an internal
// page's dev-mode request for it stays inside `/pages/...`, the one prefix
// route.ts serves an orivon:// page's own module graph from; the chrome
// view itself carries no such restriction and imports these back from here.
//
// Never innerHTML (security-model.md T1/T10/T12/T17): every element is
// built through createElementNS, even though none of this data is
// currently attacker-controlled.
const SVG_NS = 'http://www.w3.org/2000/svg'

export function svg (viewBox: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', viewBox)
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('aria-hidden', 'true')
  return el
}

export function path (d: string, strokeWidth: string): SVGPathElement {
  const el = document.createElementNS(SVG_NS, 'path')
  el.setAttribute('d', d)
  el.setAttribute('stroke-width', strokeWidth)
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  return el
}

export function circle (cx: number, cy: number, r: number): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, 'circle')
  el.setAttribute('cx', String(cx))
  el.setAttribute('cy', String(cy))
  el.setAttribute('r', String(r))
  el.setAttribute('stroke-width', '2')
  return el
}

export function rect (x: number, y: number, width: number, height: number, rx?: number): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect')
  el.setAttribute('x', String(x))
  el.setAttribute('y', String(y))
  el.setAttribute('width', String(width))
  el.setAttribute('height', String(height))
  if (rx !== undefined) el.setAttribute('rx', String(rx))
  el.setAttribute('stroke-width', '2')
  return el
}

export function line (x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line')
  el.setAttribute('x1', String(x1))
  el.setAttribute('y1', String(y1))
  el.setAttribute('x2', String(x2))
  el.setAttribute('y2', String(y2))
  el.setAttribute('stroke-width', '2')
  el.setAttribute('stroke-linecap', 'round')
  return el
}
