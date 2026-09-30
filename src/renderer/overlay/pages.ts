// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'
import { findPage } from './find/page.js'
import { menuPage } from './menu/page.js'
import { sadTabPage } from './sad-tab/page.js'
import { screenshotPage } from './screenshot/page.js'
import { tabSearchPage } from './tab-search/page.js'
import { toastPage } from './toast/page.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {
  find: findPage,
  menu: menuPage,
  'sad-tab': sadTabPage,
  screenshot: screenshotPage,
  'tab-search': tabSearchPage,
  toast: toastPage
}
