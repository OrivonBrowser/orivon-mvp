// Every overlay the shell can show. A feature adds its OverlayDef here, one
// per line in name order, and its page to src/renderer/overlay/pages.ts.
import { authSheetOverlay } from '../auth/auth-sheet-real.js'
import { certErrorOverlay } from '../auth/cert-error-overlay.js'
import { certificateOverlay } from '../auth/certificate-real.js'
import { chooserOverlay } from '../auth/chooser-overlay.js'
import { downloadsOverlay, downloadsPeekOverlay } from '../downloads/downloads-overlay.js'
import { findOverlay } from '../find/find-overlay.js'
import { screenshotOverlay, toastOverlay } from '../page-tools/page-overlays.js'
import { shortcutOverlay } from '../os/shortcut-real.js'
import { httpsWarningOverlay } from '../privacy/https-warning-overlay.js'
import { qrOverlay } from '../qr/qr-real.js'
import { sadTabOverlay } from '../sad-tab/sad-tab-overlay.js'
import { bookmarkAllTabsOverlay, bookmarkEditOverlay } from '../shell/bookmark-bubble/edit-overlay.js'
import { bookmarkFolderOverlay } from '../shell/bookmarks-bar/folder-overlay.js'
import { passwordFillOverlay, passwordSuggestOverlay } from '../passwords/chooser-overlays.js'
import { passwordSaveOverlay } from '../passwords/password-overlays.js'
import { menuOverlay } from '../shell/menu-overlay.js'
import { omniboxOverlay } from '../omnibox/omnibox-overlay.js'
import { popupsBlockedOverlay } from '../site-settings/popups-overlay.js'
import { sitePromptOverlay } from '../site-settings/site-prompt-overlay.js'
import { restoreOverlay } from '../startup/startup-overlays.js'
import { tabSearchOverlay } from '../tab-search/tab-search-overlay.js'
import type { OverlayDef } from './overlay-types.js'

export const OVERLAYS: readonly OverlayDef[] = [
  authSheetOverlay,
  bookmarkAllTabsOverlay,
  bookmarkEditOverlay,
  bookmarkFolderOverlay,
  certErrorOverlay,
  certificateOverlay,
  chooserOverlay,
  downloadsOverlay,
  downloadsPeekOverlay,
  findOverlay,
  httpsWarningOverlay,
  menuOverlay,
  omniboxOverlay,
  passwordFillOverlay,
  passwordSaveOverlay,
  passwordSuggestOverlay,
  popupsBlockedOverlay,
  qrOverlay,
  restoreOverlay,
  sadTabOverlay,
  screenshotOverlay,
  shortcutOverlay,
  sitePromptOverlay,
  tabSearchOverlay,
  toastOverlay
]
