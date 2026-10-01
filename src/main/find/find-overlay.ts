// The find bar: a 44px card at the top right of the tab area that floats over
// the page. Its behaviour is ./find-window.ts; this is where it is declared.
import { CLOSE_LIKE_BAR } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { createFindWindow, FIND_OVERLAY } from './find-window.js'

const BAR_WIDTH = 380
const BAR_HEIGHT = 44

export const findOverlay: OverlayDef = {
  name: FIND_OVERLAY,
  placement: { kind: 'area', at: 'top-right', width: BAR_WIDTH },
  surface: 'panel',
  focus: 'take',
  layer: 'bar',
  // A bar, not a popup: a click into the page leaves it open, and only a tab switch closes it.
  closeOn: CLOSE_LIKE_BAR,
  keep: 'warm',
  height: { initial: BAR_HEIGHT, min: BAR_HEIGHT, max: BAR_HEIGHT },
  attach: (win) => createFindWindow(win).handler
}
