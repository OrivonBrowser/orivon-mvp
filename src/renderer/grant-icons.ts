// One icon per permission a grant row can represent, for the left side of
// every row in the site-info popup and the all-sites panel (owner request).
// Hand-drawn inline SVG, no icon library (Rule 8; README.md) -- path data
// hand-ported from lucide's own icon set (ISC licence, https://lucide.dev,
// v1.48.0) onto its default attributes, the same discipline `icons.ts` and
// `site-info/icons.ts` already follow.
//
// An EXHAUSTIVE Record, not a switch with a default -- a 15th CapabilityKind
// added to src/contracts/ without a line here fails `npm run typecheck`
// rather than silently rendering nothing.
//
// Never innerHTML (security-model.md T1/T10/T12/T17); `aria-hidden`, no
// `<title>` -- the row's own text carries the accessible name, and
// `test/e2e-site-permissions.test.ts` reads `.permission-message`'s exact
// textContent, which an icon must never add to.

import type { CapabilityKind } from '../contracts/index.js'
import type { PickedPathRow } from '../main/permissions/permissions.js'
import { circle, globeIcon, line, path, rect, svg } from './icons.js'

/** Every kind a grant row can represent: a capability, a picked file or
 * folder, or a site's remembered notification answer (permissions.ts's
 * `SiteNotificationRow`, the one row kind with no `CapabilityKind` at all). */
export type GrantIconKind = CapabilityKind | PickedPathRow['kind'] | 'notifications'

function monitorIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(rect(2, 3, 20, 14, 2), line(8, 21, 16, 21), line(12, 17, 12, 21))
  return el
}

function radioTowerIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M4.9 16.1C1 12.2 1 5.8 4.9 1.9', '2'),
    path('M7.8 4.7a6.14 6.14 0 0 0-.8 7.5', '2'),
    circle(12, 9, 2),
    path('M16.2 4.8c2 2 2.26 5.11.8 7.47', '2'),
    path('M19.1 1.9a9.96 9.96 0 0 1 0 14.1', '2'),
    path('M9.5 18h5', '2'),
    path('m8 22 4-11 4 11', '2')
  )
  return el
}

function hardDriveIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M10 16h.01', '2'),
    path('M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', '2'),
    path('M21.946 12.013H2.054', '2'),
    path('M6 16h.01', '2')
  )
  return el
}

function fingerprintIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4', '2'),
    path('M14 13.12c0 2.38 0 6.38-1 8.88', '2'),
    path('M17.29 21.02c.12-.6.43-2.3.5-3.02', '2'),
    path('M2 12a10 10 0 0 1 18-6', '2'),
    path('M2 16h.01', '2'),
    path('M21.8 16c.2-2 .131-5.354 0-6', '2'),
    path('M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2', '2'),
    path('M8.65 22c.21-.66.45-1.32.57-2', '2'),
    path('M9 6.8a6 6 0 0 1 9 5.2v2', '2')
  )
  return el
}

function appWindowIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(rect(2, 4, 20, 16, 2), path('M10 4v4', '2'), path('M2 8h20', '2'), path('M6 4v4', '2'))
  return el
}

function lockKeyholeIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(circle(12, 16, 1), rect(3, 10, 18, 12, 2), path('M7 10V7a5 5 0 0 1 10 0v3', '2'))
  return el
}

function cameraIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z', '2'),
    circle(12, 13, 3)
  )
  return el
}

function micIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(path('M12 19v3', '2'), path('M19 10v2a7 7 0 0 1-14 0v-2', '2'), rect(9, 2, 6, 13, 3))
  return el
}

function clipboardIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(rect(8, 2, 8, 4, 1), path('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', '2'))
  return el
}

function fileIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z', '2'),
    path('M14 2v5a1 1 0 0 0 1 1h5', '2')
  )
  return el
}

function folderIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(path('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', '2'))
  return el
}

function bellIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M10.268 21a2 2 0 0 0 3.464 0', '2'),
    path('M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326', '2')
  )
  return el
}

const BUILDERS: Record<GrantIconKind, () => SVGSVGElement> = {
  // Outbound reach -- `earth`, reusing the existing globe glyph rather than
  // a second copy of the same path data (code-guidelines.md Rule 3).
  'tcp.connect': globeIcon,
  'https.connect': globeIcon,
  'udp.send': globeIcon,
  // Inbound, this device only.
  'tcp.listen.local': monitorIcon,
  'udp.bind.local': monitorIcon,
  // Inbound, the network (and the internet if forwarded).
  'tcp.listen.network': radioTowerIcon,
  'udp.bind.network': radioTowerIcon,
  fs: hardDriveIcon,
  id: fingerprintIcon,
  'web.context': appWindowIcon,
  secrets: lockKeyholeIcon,
  'media.camera': cameraIcon,
  'media.microphone': micIcon,
  'clipboard.read': clipboardIcon,
  file: fileIcon,
  directory: folderIcon,
  notifications: bellIcon
}

/** The icon for one grant row's `kind`. Always a fresh element -- callers
 * append it once, like every other icon builder in this tree. */
export function grantIcon (kind: GrantIconKind): SVGSVGElement {
  const el = BUILDERS[kind]()
  el.classList.add('grant-icon')
  return el
}
