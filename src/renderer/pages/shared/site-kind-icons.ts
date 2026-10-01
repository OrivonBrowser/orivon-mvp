// One outline icon per kind of thing a site can be asked about or told it may
// not do. Every kind has one (the record is exhaustive), so a kind added to
// the table cannot reach a prompt, a chip or a Settings row without a mark.
// Same grid and stroke as ./icons.ts; the slash marks a kind as blocked.
import type { SiteKind } from '../../../main/site-settings/kinds.js'
import { downloadIcon, externalLinkIcon, mapPinIcon, speakerIcon } from './icons.js'
import { circle, line, path, rect, svg } from './svg-primitives.js'

function icon (build: (el: SVGSVGElement) => void): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.classList.add('icon')
  build(el)
  return el
}

export const SITE_KIND_ICONS: Readonly<Record<SiteKind, () => SVGSVGElement>> = {
  camera: () => icon((el) => { el.append(rect(2, 6, 14, 12, 3), path('M16 10.5l5.5-3v9l-5.5-3', '2')) }),
  microphone: () => icon((el) => { el.append(rect(9, 2, 6, 12, 3), path('M5 11a7 7 0 0 0 14 0', '2'), line(12, 18, 12, 22)) }),
  location: () => mapPinIcon(),
  clipboardRead: () => icon((el) => { el.append(rect(5, 4, 14, 18, 2), rect(9, 2, 6, 4, 1), line(9, 12, 15, 12), line(9, 16, 13, 16)) }),
  midi: () => icon((el) => {
    el.append(circle(12, 12, 9), circle(7.5, 12.5, 0.6), circle(9, 8.5, 0.6), circle(12, 7.5, 0.6), circle(15, 8.5, 0.6), circle(16.5, 12.5, 0.6), line(10.5, 16.5, 13.5, 16.5))
  }),
  idle: () => icon((el) => { el.append(path('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', '2')) }),
  windowManagement: () => icon((el) => { el.append(rect(3, 4, 12, 10, 2), path('M9 14v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-4', '2')) }),
  notifications: () => icon((el) => { el.append(path('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', '2'), path('M10.3 21a1.9 1.9 0 0 0 3.4 0', '2')) }),
  popups: () => externalLinkIcon(),
  javascript: () => icon((el) => { el.append(path('M8 7l-5 5 5 5', '2'), path('M16 7l5 5-5 5', '2'), line(14, 5, 10, 19)) }),
  images: () => icon((el) => { el.append(rect(3, 4, 18, 16, 2), circle(9, 10, 1.5), path('M21 16l-5-5-9 9', '2')) }),
  sound: () => speakerIcon(),
  autoDownloads: () => downloadIcon(),
  devices: () => icon((el) => { el.append(path('M12 3v12', '2'), path('M8 7l4-4 4 4', '2'), circle(12, 18, 2.5), rect(4, 12, 4, 4, 1), circle(19, 10, 2)) }),
  screenShare: () => icon((el) => { el.append(rect(2, 4, 20, 13, 2), line(8, 21, 16, 21), line(12, 17, 12, 21)) })
}

/** The kind's icon with a slash across it: the site was refused. */
export function blockedSiteKindIcon (kind: SiteKind): SVGSVGElement {
  const el = SITE_KIND_ICONS[kind]()
  el.append(line(3, 3, 21, 21))
  return el
}
