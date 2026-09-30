// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'
import { findPage } from './find/page.js'
import { menuPage } from './menu/page.js'
import { restorePage } from './restore/page.js'
import { screenshotPage } from './screenshot/page.js'
import { toastPage } from './toast/page.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {
  find: findPage,
  menu: menuPage,
  restore: restorePage,
  screenshot: screenshotPage,
  toast: toastPage
}
