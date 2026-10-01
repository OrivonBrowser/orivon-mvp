// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'
import { bookmarkFolderPage } from './bookmark-folder/page.js'
import { extensionPermissionPage } from './extension-permission/page.js'
import { findPage } from './find/page.js'
import { menuPage } from './menu/page.js'
import { omniboxPage } from './omnibox/page.js'
import { qrPage } from './qr/page.js'
import { restorePage } from './restore/page.js'
import { sadTabPage } from './sad-tab/page.js'
import { screenshotPage } from './screenshot/page.js'
import { tabSearchPage } from './tab-search/page.js'
import { toastPage } from './toast/page.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {
  'bookmark-folder': bookmarkFolderPage,
  'extension-permission': extensionPermissionPage,
  find: findPage,
  menu: menuPage,
  omnibox: omniboxPage,
  qr: qrPage,
  restore: restorePage,
  'sad-tab': sadTabPage,
  screenshot: screenshotPage,
  'tab-search': tabSearchPage,
  toast: toastPage
}
