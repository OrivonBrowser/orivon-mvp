// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'
import { appSetupPage } from './app-setup/page.js'
import { authSheetPage } from './auth-sheet/page.js'
import { bookmarkEditPage } from './bookmark-edit/page.js'
import { bookmarkFolderPage } from './bookmark-folder/page.js'
import { caretConfirmPage } from './caret-confirm/page.js'
import { certErrorPage } from './cert-error/page.js'
import { certificatePage } from './certificate/page.js'
import { chooserPage } from './chooser/page.js'
import { downloadsPage } from './downloads/page.js'
import { extensionPermissionPage } from './extension-permission/page.js'
import { extensionsMenuPage } from './extensions-menu/page.js'
import { findPage } from './find/page.js'
import { httpsWarningPage } from './https-warning/page.js'
import { loadErrorPage } from './load-error/page.js'
import { loadingScreenPage } from './loading-screen/page.js'
import { menuPage } from './menu/page.js'
import { omniboxPage } from './omnibox/page.js'
import { passwordFillPage } from './password-fill/page.js'
import { passwordSavePage } from './password-save/page.js'
import { popupsBlockedPage } from './popups-blocked/page.js'
import { qrPage } from './qr/page.js'
import { questionPage } from './question/page.js'
import { restorePage } from './restore/page.js'
import { sadTabPage } from './sad-tab/page.js'
import { screenSharePickerPage } from './screen-share-picker/page.js'
import { screenshotPage } from './screenshot/page.js'
import { sharingBarPage } from './sharing-bar/page.js'
import { shortcutSheetPage } from './shortcut-sheet/page.js'
import { sidePanelPage } from './side-panel/page.js'
import { sitePromptPage } from './site-prompt/page.js'
import { tabGroupPage } from './tab-group/page.js'
import { tabSearchPage } from './tab-search/page.js'
import { toastPage } from './toast/page.js'
import { web3ScorePage } from './web3-score/page.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {
  'app-setup-sheet': appSetupPage,
  'auth-sheet': authSheetPage,
  'bookmark-all-tabs': bookmarkEditPage,
  'bookmark-edit': bookmarkEditPage,
  'bookmark-folder': bookmarkFolderPage,
  'caret-confirm': caretConfirmPage,
  'cert-error': certErrorPage,
  certificate: certificatePage,
  chooser: chooserPage,
  downloads: downloadsPage,
  'downloads-peek': downloadsPage,
  'extension-permission': extensionPermissionPage,
  'extensions-menu': extensionsMenuPage,
  find: findPage,
  'https-warning': httpsWarningPage,
  'load-error': loadErrorPage,
  'loading-screen': loadingScreenPage,
  menu: menuPage,
  omnibox: omniboxPage,
  'password-fill': passwordFillPage,
  'password-save': passwordSavePage,
  'password-suggest': passwordFillPage,
  'popups-blocked': popupsBlockedPage,
  qr: qrPage,
  question: questionPage,
  'question-sheet': questionPage,
  restore: restorePage,
  'sad-tab': sadTabPage,
  'screen-share-picker': screenSharePickerPage,
  screenshot: screenshotPage,
  'sharing-bar': sharingBarPage,
  'shortcut-sheet': shortcutSheetPage,
  'side-panel': sidePanelPage,
  'site-prompt': sitePromptPage,
  'tab-group': tabGroupPage,
  'tab-search': tabSearchPage,
  toast: toastPage,
  'web3-score': web3ScorePage
}
