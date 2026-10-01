// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'
import { bookmarkEditPage } from './bookmark-edit/page.js'
import { bookmarkFolderPage } from './bookmark-folder/page.js'
import { caretConfirmPage } from './caret-confirm/page.js'
import { downloadsPage } from './downloads/page.js'
import { findPage } from './find/page.js'
import { menuPage } from './menu/page.js'
import { omniboxPage } from './omnibox/page.js'
import { qrPage } from './qr/page.js'
import { restorePage } from './restore/page.js'
import { sadTabPage } from './sad-tab/page.js'
import { screenshotPage } from './screenshot/page.js'
import { sidePanelPage } from './side-panel/page.js'
import { tabGroupPage } from './tab-group/page.js'
import { tabSearchPage } from './tab-search/page.js'
import { toastPage } from './toast/page.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {
  'bookmark-all-tabs': bookmarkEditPage,
  'bookmark-edit': bookmarkEditPage,
  'bookmark-folder': bookmarkFolderPage,
  'caret-confirm': caretConfirmPage,
  downloads: downloadsPage,
  'downloads-peek': downloadsPage,
  find: findPage,
  menu: menuPage,
  omnibox: omniboxPage,
  qr: qrPage,
  restore: restorePage,
  'sad-tab': sadTabPage,
  screenshot: screenshotPage,
  'side-panel': sidePanelPage,
  'tab-group': tabGroupPage,
  'tab-search': tabSearchPage,
  toast: toastPage
}
