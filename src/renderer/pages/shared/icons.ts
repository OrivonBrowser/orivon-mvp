// Small outline icons for the shell's own pages: one per Settings nav entry,
// Settings' own sidebar mark, and History's header/empty-state/remove marks.
// Built on the shared primitives (./svg-primitives.js, also used by the
// chrome's own icons.ts) so every hand-drawn icon in Orivon is assembled the
// same way (code-guidelines.md Rule 3) -- never a copy of another
// application's icon set, and never an icon font.
import { circle, line, path, rect, svg } from './svg-primitives.js'

/** A 24x24 outline icon, sized by CSS (`.icon`) rather than an attribute, so a
 * caller can make one bigger (a page header) or smaller (a nav row) with one class. */
function icon (build: (el: SVGSVGElement) => void): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon')
  build(el)
  return el
}

/** Points of a regular polygon centred on (12, 12), for a shape drawn from angles
 * rather than a hand-typed path -- one formula, reused by every ring-like icon below. */
function polygon (sides: number, radius: number, startAngle: number): string {
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = startAngle + (2 * Math.PI * index) / sides
    const x = (12 + Math.cos(angle) * radius).toFixed(2)
    const y = (12 + Math.sin(angle) * radius).toFixed(2)
    return `${index === 0 ? 'M' : 'L'}${x} ${y}`
  })
  return `${points.join(' ')} Z`
}

/** Settings' own mark: a ring with the sidebar's title beside it, and the
 * "Appearance" row's own icon shares no shape with it (rays vs. a split circle),
 * so the two are never mistaken for one another next to each other. */
export function gearIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(circle(12, 12, 3))
    for (let tooth = 0; tooth < 8; tooth += 1) {
      const angle = (tooth * Math.PI) / 4
      el.append(line(
        Number((12 + Math.cos(angle) * 6.5).toFixed(2)), Number((12 + Math.sin(angle) * 6.5).toFixed(2)),
        Number((12 + Math.cos(angle) * 9.5).toFixed(2)), Number((12 + Math.sin(angle) * 9.5).toFixed(2))
      ))
    }
  })
}

export function appearanceIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 12, 8), line(12, 4, 12, 20)) })
}

export function searchGlassIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(10, 10, 6), line(14.5, 14.5, 20, 20)) })
}

export function tabsIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(3, 7, 14, 14, 2), rect(7, 3, 14, 14, 2)) })
}

export function profilesIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 8, 4), path('M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8', '2')) })
}

export function privacyIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M12 3 5 6v5c0 4.7 3 8.2 7 10 4-1.8 7-5.3 7-10V6z', '2')) })
}

export function appsIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(4, 4, 7, 7, 2), rect(13, 4, 7, 7, 2), rect(4, 13, 7, 7, 2), rect(13, 13, 7, 7, 2)) })
}

/** A hexagon, for the one section about the networks a page might come from. */
export function webIcon (): SVGSVGElement {
  return icon((el) => { el.append(path(polygon(6, 9, -Math.PI / 2), '2'), circle(12, 12, 2.5)) })
}

export function keyboardIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(rect(3, 6, 18, 12, 2))
    el.append(line(7, 10, 7.01, 10), line(12, 10, 12.01, 10), line(17, 10, 17.01, 10))
    el.append(rect(7, 14, 10, 2, 1))
  })
}

export function developerIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M8 8 3 12l5 4', '2'), path('M16 8l5 4-5 4', '2')) })
}

export function infoIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 12, 9), line(12, 11, 12, 16.5), line(12, 7.5, 12, 7.5)) })
}

export function clockIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 12, 9), line(12, 12, 12, 7), line(12, 12, 16, 13)) })
}

export function trashIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(line(4, 7, 20, 7), rect(9, 3.5, 6, 2.5, 1))
    el.append(path('M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7', '2'))
    el.append(line(10, 10.5, 10, 17), line(14, 10.5, 14, 17))
  })
}

/** The Private page's own mark: an abstract pair of glasses, for a window that
 * does not look like the rest of the profile it came from. */
export function privateIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(circle(7, 14, 3.2), circle(17, 14, 3.2), line(10.2, 14, 13.8, 14))
    el.append(line(3.8, 14, 2, 10.5), line(20.2, 14, 22, 10.5))
  })
}
