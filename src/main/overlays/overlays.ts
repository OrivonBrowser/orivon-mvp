// Every overlay the shell can show. A feature adds its OverlayDef here, one
// per line in name order, and its page to src/renderer/overlay/pages.ts.
import { downloadsOverlay, downloadsPeekOverlay } from '../downloads/downloads-overlay.js'
import { findOverlay } from '../find/find-overlay.js'
import { screenshotOverlay, toastOverlay } from '../page-tools/page-overlays.js'
import { qrOverlay } from '../qr/qr-real.js'
import { sadTabOverlay } from '../sad-tab/sad-tab-overlay.js'
import { bookmarkFolderOverlay } from '../shell/bookmarks-bar/folder-overlay.js'
import { menuOverlay } from '../shell/menu-overlay.js'
import { omniboxOverlay } from '../omnibox/omnibox-overlay.js'
import { restoreOverlay } from '../startup/startup-overlays.js'
import { tabSearchOverlay } from '../tab-search/tab-search-overlay.js'
import type { OverlayDef } from './overlay-types.js'

export const OVERLAYS: readonly OverlayDef[] = [
  bookmarkFolderOverlay,
  downloadsOverlay,
  downloadsPeekOverlay,
  findOverlay,
  menuOverlay,
  omniboxOverlay,
  qrOverlay,
  restoreOverlay,
  sadTabOverlay,
  screenshotOverlay,
  tabSearchOverlay,
  toastOverlay
]
