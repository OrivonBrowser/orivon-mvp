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

// The icons the shared UI kit and the feature pages draw beyond Settings' own
// set: file and folder marks, list and toolbar controls, and states (locked,
// muted, warning). Same grid and stroke as the ones above.

export function downloadIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', '2'), path('M7 10l5 5 5-5', '2'), path('M12 15V3', '2')) })
}

export function folderIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z', '2')) })
}

export function folderOpenIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M6 14l1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-1.9 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2', '2'))
  })
}

export function fileIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', '2'), path('M14 2v4a2 2 0 0 0 2 2h4', '2')) })
}

/** The ribbon of the toolbar's bookmark button. Outline only; a caller that wants it filled (a bookmarked page) sets `fill: currentColor` on it. */
export function bookmarkIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z', '2')) })
}

/** An import: a folder with an arrow going in. */
export function importIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1', '2'), path('M2 13h10', '2'), path('m9 16 3-3-3-3', '2')) })
}

/** A pulse line: the task manager's mark. */
export function activityIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2', '2')) })
}

export function chevronRightIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M9 18l6-6-6-6', '2')) })
}

export function chevronDownIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M6 9l6 6 6-6', '2')) })
}

export function closeIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M18 6L6 18', '2'), path('M6 6l12 12', '2')) })
}

export function checkIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M20 6L9 17l-5-5', '2')) })
}

export function plusIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M5 12h14', '2'), path('M12 5v14', '2')) })
}

export function moreIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1)) })
}

export function pinIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M12 17v5', '2'))
    el.append(path('M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z', '2'))
  })
}

export function speakerIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M11 5L6 9H2v6h4l5 4V5z', '2'), path('M15.5 8.5a5 5 0 0 1 0 7', '2'), path('M19 5a10 10 0 0 1 0 14', '2')) })
}

export function speakerOffIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M11 5L6 9H2v6h4l5 4V5z', '2'), path('M22 9l-6 6', '2'), path('M16 9l6 6', '2')) })
}

export function warningIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M21.7 18l-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z', '2'), path('M12 9v4', '2'), path('M12 17h.01', '2')) })
}

export function lockIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(3, 11, 18, 11, 2), path('M7 11V7a5 5 0 0 1 10 0v4', '2')) })
}

export function keyIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4', '2')) })
}

/** Three sliders, for the section of per-site choices. */
export function slidersIcon (): SVGSVGElement {
  return icon((el) => { el.append(line(4, 7, 20, 7), line(4, 12, 20, 12), line(4, 17, 20, 17), circle(9, 7, 2), circle(15, 12, 2), circle(8, 17, 2)) })
}

/** A map pin, for the section of saved addresses. */
export function mapPinIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z', '2'), circle(12, 10, 3)) })
}

export function printerIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M6 9V2h12v7', '2'), path('M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', '2'), rect(6, 14, 12, 8))
  })
}

export function externalLinkIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M15 3h6v6', '2'), path('M10 14L21 3', '2'), path('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', '2')) })
}

export function copyIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(8, 8, 14, 14, 2), path('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2', '2')) })
}

export function pencilIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', '2'), path('M15 5l4 4', '2')) })
}

export function refreshIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8', '2'), path('M21 3v5h-5', '2')) })
}

export function homeIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', '2'), path('M9 22V12h6v10', '2')) })
}

export function panelRightIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(3, 3, 18, 18, 2), path('M15 3v18', '2')) })
}

export function panelLeftIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(3, 3, 18, 18, 2), path('M9 3v18', '2')) })
}

export function puzzleIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M19.4 7.9c-.05.32.06.65.29.88l1.57 1.57a2.4 2.4 0 0 1 0 3.4l-1.6 1.6a1 1 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.2 3.2c.45.17.86.5.93.97a1 1 0 0 1-.28.84l-1.6 1.6a2.4 2.4 0 0 1-3.4 0l-1.57-1.57a1 1 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.47-.18.9-.53.97-1.02a1 1 0 0 0-.29-.88L2.7 13.7a2.4 2.4 0 0 1 0-3.4l1.53-1.53c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92L10.3 2.7a2.4 2.4 0 0 1 3.4 0l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.47.18-.9.53-.97 1.02z', '2'))
  })
}

export function pauseIcon (): SVGSVGElement {
  return icon((el) => { el.append(rect(14, 4, 4, 16, 1), rect(6, 4, 4, 16, 1)) })
}

export function playIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M6 3l14 9-14 9z', '2')) })
}

export function eyeIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z', '2'), circle(12, 12, 3)) })
}

export function eyeOffIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M9.9 9.9a3 3 0 1 0 4.2 4.2', '2'), path('M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7', '2'))
    el.append(path('M6.6 6.6A13.2 13.2 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6', '2'), path('M2 2l20 20', '2'))
  })
}

export function arrowUpIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M5 12l7-7 7 7', '2'), path('M12 19V5', '2')) })
}

export function arrowLeftIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M19 12H5', '2'), path('M12 19l-7-7 7-7', '2')) })
}

export function arrowDownIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M12 5v14', '2'), path('M19 12l-7 7-7-7', '2')) })
}

export function minusIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M5 12h14', '2')) })
}

/** Four corners: the full-screen control. */
export function maximizeIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M8 3H5a2 2 0 0 0-2 2v3', '2'), path('M21 8V5a2 2 0 0 0-2-2h-3', '2'))
    el.append(path('M3 16v3a2 2 0 0 0 2 2h3', '2'), path('M16 21h3a2 2 0 0 0 2-2v-3', '2'))
  })
}

export function moonIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z', '2')) })
}

export function bookOpenIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M12 7v14', '2'))
    el.append(path('M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z', '2'))
  })
}

/** A page with three lines of text: reader view, which the open book of the reading list must not be mistaken for. */
export function readerIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', '2'))
    el.append(path('M9 8h6', '2'), path('M9 12h6', '2'), path('M9 16h4', '2'))
  })
}

/** A dial, for the section about how much the browser uses. */
export function gaugeIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M12 14l4-4', '2'), path('M3.34 19a10 10 0 1 1 17.32 0', '2')) })
}

/** A person with open arms in a circle, for the section of accessibility choices. */
export function accessibilityIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(circle(12, 12, 10), circle(12, 7.5, 1), path('M7 10.5l5 1 5-1', '2'), path('M12 11.5v3', '2'), path('M9.5 18l2.5-3.5 2.5 3.5', '2'))
  })
}

export function leafIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z', '2'), path('M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12', '2'))
  })
}

export function userRoundIcon (): SVGSVGElement {
  return icon((el) => { el.append(circle(12, 8, 5), path('M20 21a8 8 0 0 0-16 0', '2')) })
}

export function typeIcon (): SVGSVGElement {
  return icon((el) => { el.append(path('M12 4v16', '2'), path('M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', '2'), path('M9 20h6', '2')) })
}

/** A character of one script beside a character of another, for the section of languages. */
export function languagesIcon (): SVGSVGElement {
  return icon((el) => {
    el.append(path('M5 8l6 6', '2'), path('M4 14l6-6 2-3', '2'), path('M2 5h12', '2'), path('M7 2h1', '2'), path('M22 22l-5-10-5 10', '2'), path('M14 18h6', '2'))
  })
}
