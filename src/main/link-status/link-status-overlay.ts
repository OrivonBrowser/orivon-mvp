// The link bubble's overlay: one line over the bottom corner of a page, saying where the link under the pointer (or
// the keyboard) goes. It never takes focus, lies under every popup, and keeps its view for the life of the window
// once the first link made it. Its behaviour is link-status.ts; this is the part that is made of an OverlayDef.
import type { OverlayDef } from '../overlays/overlay-types.js'
import { CLOSE_LIKE_BAR } from '../overlays/overlay-types.js'
import { BUBBLE_RADIUS } from './bubble-geometry.js'
import { forgetLinkStatus, linkStatusFor } from './link-status-for.js'
import { LINK_STATUS_OVERLAY } from './link-status-view.js'

/** A text no line of a window shows this wide: what a page's measurement is bounded by before the geometry clamps it. */
const MAX_REPORTED_WIDTH = 100_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const linkStatusOverlay: OverlayDef = {
  name: LINK_STATUS_OVERLAY,
  placement: { kind: 'exact', radius: BUBBLE_RADIUS },
  surface: 'panel',
  focus: 'never',
  layer: 'bar',
  // Gone with a tab switch and a window resize: a bubble that held its place through a resize would sit in the page's middle.
  // Not with the address of the front tab changing: a page that rewrites its address while scrolling would take it down, and
  // it may be the other pane's. A navigation of its own tab ends it (`left`), and a split changing is `checkPane`'s.
  closeOn: { ...CLOSE_LIKE_BAR, layout: true },
  keep: 'resident',
  attach: ({ window }) => {
    const status = linkStatusFor(window)
    return {
      show: (view) => view,
      // The page is untrusted: it may say how wide its text is and that the pointer is on it, nothing else.
      request: (command) => {
        if (!isRecord(command)) return undefined
        if (command['type'] === 'pointer') status.pointerEntered()
        else if (command['type'] === 'width') {
          const { seq, width } = command
          if (typeof seq === 'number' && Number.isSafeInteger(seq) && typeof width === 'number' && Number.isFinite(width) && width >= 0 && width <= MAX_REPORTED_WIDTH) status.width(seq, width)
        }
        return undefined
      },
      closed: () => { status.closed() },
      disposed: () => { forgetLinkStatus(window) }
    }
  }
}
