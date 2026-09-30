// Every overlay the shell can show. A feature adds its OverlayDef here, one
// per line in name order, and its page to src/renderer/overlay/pages.ts.
import { findOverlay } from '../find/find-overlay.js'
import { screenshotOverlay, toastOverlay } from '../page-tools/page-overlays.js'
import { sadTabOverlay } from '../sad-tab/sad-tab-overlay.js'
import { menuOverlay } from '../shell/menu-overlay.js'
import type { OverlayDef } from './overlay-types.js'

export const OVERLAYS: readonly OverlayDef[] = [
  findOverlay,
  menuOverlay,
  sadTabOverlay,
  screenshotOverlay,
  toastOverlay
]
