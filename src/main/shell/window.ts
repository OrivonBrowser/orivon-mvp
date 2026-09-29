// Composes the shell: a frameless BaseWindow (./window-frame.ts) holding a
// chrome WebContentsView (tab strip + toolbar + bookmarks bar) on top and,
// below it, whichever tab WebContentsView is active. See docs/architecture --
// there is no shell doc, this file and its neighbours (tabs.ts, ipc.ts)
// are the specification.
import { app, WebContentsView, type BaseWindow } from 'electron'
import { join } from 'node:path'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync, pinCoverageFor } from '../../loader/electron/serve.js'
import { verifierNameEvidence } from '../verifier/verifier-subsystem.js'
import { STATE_CHANNEL } from '../channels.js'
import { createPermissionsController, createSiteNotificationsController } from '../permissions/permissions.js'
import { notificationDecisions } from '../sessions/permission-gate.js'
import { createSiteInfoController } from '../permissions/site-info-controller.js'
import { deliveryLevelOverrideFor, scoreLevelOverrideFor } from '../dev/score-levels.js'
import { localDdocFor } from '../dev/local-ddoc.js'
import { rendererEntryUrl } from './renderer-entry.js'
import { lockNavigation } from './lock-navigation.js'
import type { SubsystemContext } from '../registry.js'
import { TabManager, type Bounds } from './tabs.js'
import { registerShellIpc } from '../ipc/ipc.js'
import { createPermissionsPanel } from '../permissions/permissions-panel.js'
import { createSiteInfoPanel } from '../permissions/site-info-panel.js'
import { createMenuPanel } from './menu-panel.js'
import { shellActions } from './window-actions.js'
import { SplitFrame } from './split-frame.js'
import type { SiteInfoMemory } from './window-actions.js'
import type { ShellWindow } from './window-registry.js'
import { HtmlFullscreen } from './fullscreen.js'
import { NOTICES, noticeForWindow } from './window-notice.js'
import { showContextMenu } from './context-menu.js'
import { chromeContextMenuHost } from './chrome-context-menu.js'
import { devModeEnabled } from '../dev/dev-mode.js'
import type { ShellWindowOptions } from './window-options.js'
import { showIntro } from './intro-view.js'
import { createWindowFrame, showWhenReady } from './window-frame.js'
import type { ShellServices } from './shell-services.js'
import { searchUrlFor } from '../browsing/search-engines.js'
import { SHELL_PARTITION } from './shell-session.js'

// Chrome restyle, 2026-08-28 (owner: match a reference screenshot that
// turned out to be the prior prototype's chrome pixel-for-pixel --
// orivon-browser-v2, visual reference only, ADR-0002). The empty
// dedicated title row is gone; tabs now share the top row with the
// native window buttons. Height is the sum of three rows, mirrored
// exactly in src/renderer/style.css so the native chrome view and the
// CSS agree on where the tab content starts:
//   tabrow      36px (matches the native overlay's height, window-frame.ts)
// + toolbar     40px
// + bookmarks   28px, only when the bar is rendered -- see chromeHeight()
const CHROME_TOP_ROWS = 76
const BOOKMARKS_BAR_HEIGHT = 28
const CHROME_HEIGHT = CHROME_TOP_ROWS + BOOKMARKS_BAR_HEIGHT

/** The new-tab page's own URL: the dev server's nested path, or the built file. */
export function resolveDashboardUrl (): string {
  return rendererEntryUrl(import.meta.dirname, process.env['ELECTRON_RENDERER_URL'], '/newtab/', '../renderer/newtab/index.html')
}

/** One shell window. `services` are what every window of this process shares;
 * `intro`: the process's first window on a launch that opens on the welcome
 * screen (./intro-state.ts). */
export function createShellWindow (ctx: SubsystemContext, services: ShellServices, options: ShellWindowOptions = {}): BaseWindow {
  const { intro, first, place } = options
  const frame = createWindowFrame(import.meta.dirname, place, services.profiles.isPrivate)
  const { win } = frame

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  // The chrome's own resolved URL -- computed before construction so both
  // the preload's expected-URL argument and the load target name the exact
  // same string, the pattern `--orivon-newtab-url` already establishes
  // below for the dashboard.
  const chromeUrl = rendererEntryUrl(import.meta.dirname, devServerUrl, '/', '../renderer/index.html')

  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/shell.js'),
      partition: SHELL_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--orivon-shell-url=${chromeUrl}`]
    }
  })
  win.contentView.addChildView(chrome)
  // The chrome preload is unconditionally privileged (src/preload/shell.ts
  // gates on this same URL, ipc.ts's isFromChrome checks it a second time
  // on every call) -- a view holding it must never end up attached to a
  // document other than this one. No further navigation happens from here,
  // so `chromeUrl` is also the one destination the lock still lets through.
  lockNavigation(chrome.webContents, chromeUrl)
  void chrome.webContents.loadURL(chromeUrl)

  // A genuinely fresh tab loads this (tabs.ts's createTab()). electron-vite's
  // dev server serves every renderer entry off the SAME origin at a nested
  // path; the built path matches electron.vite.config.ts's `newtab` entry.
  const dashboardUrl = resolveDashboardUrl()

  // Bookmarks (scope.md, ADR-0003) are a store of their own, shared by every
  // window of this process and not folded into TabManager -- tabs and
  // bookmarks change independently and neither needs to know the other
  // exists; window.ts is what composes both into the one ShellState snapshot
  // the chrome view receives.
  const bookmarks = services.bookmarks

  // The bookmarks bar is rendered only when there is something in it
  // (owner, 2026-09-15) -- it holds the real list and nothing else now, so
  // an empty one is an empty row. Main has to own this, not just CSS: the
  // tab view starts where the chrome view ends, so a row the renderer
  // hides without main shrinking these bounds leaves a 28px band of empty
  // chrome above the page instead of giving it back to the page.
  // Set by the person: 'auto' is the rule above, the others ignore whether the
  // list is empty.
  function bookmarksBarShown (): boolean {
    const mode = services.settings.get('appearance.bookmarksBar')
    return mode === 'always' || (mode === 'auto' && bookmarks.getAll().length > 0)
  }

  function chromeHeight (): number {
    return bookmarksBarShown() ? CHROME_HEIGHT : CHROME_TOP_ROWS
  }

  // A page in HTML fullscreen gets the whole window and the chrome is hidden;
  // Electron only puts the window itself into fullscreen (./fullscreen.ts).
  // The notice is the window's one, shared with the pointer- and keyboard-lock
  // messages, and disposed with the window.
  const notice = noticeForWindow(win)
  const fullscreen = new HtmlFullscreen({
    relayout: () => { layoutAll() },
    exitTab: (id) => { tabs.exitHtmlFullscreen(id) },
    leaveWindowFullscreen: () => { if (!win.isDestroyed()) win.setFullScreen(false) },
    showNotice: () => { notice.show(NOTICES.fullscreen) },
    hideNotice: () => { notice.hide() }
  })

  function layoutChrome (): void {
    if (win.isDestroyed()) return
    const bounds = win.getContentBounds()
    chrome.setVisible(fullscreen.tabId === null)
    chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: chromeHeight() })
  }

  // A destroyed window has no bounds to give. Its tabs' `destroyed` events
  // arrive after it, and each one can land here through activateTab.
  function tabBounds (): Bounds {
    if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const bounds = win.getContentBounds()
    const top = fullscreen.tabId === null ? chromeHeight() : 0
    return { x: 0, y: top, width: bounds.width, height: bounds.height - top }
  }

  function layoutAll (): void {
    layoutChrome()
    tabs.layout()
    notice.layout()
    // Closed rather than repositioned: a toolbar popup that follows a
    // drag-resize around is stranger than one that simply dismisses, and
    // this is what every browser does with its own.
    permissionsPanel.close()
    siteInfoPanel.close()
    menuPanel.close()
  }

  // A16, resolved (owner decision, 2026-08-28): closing the last tab
  // closes the window, rather than being left open and empty. No
  // app.quit() here -- index.ts's window-all-closed handler already owns
  // whether the whole process then exits (quits on non-darwin, stays
  // resident on macOS per platform convention).
  // The guard is load-bearing, not defensive noise: on teardown the window
  // is destroyed FIRST, and its child webContents then fire 'destroyed' one
  // by one, which empties TabManager and reaches this callback. Calling
  // close() on an already-destroyed BaseWindow throws, and an uncaught throw
  // in the main process puts up Electron's modal error dialog -- which then
  // keeps the process alive forever, so the window never goes away and the
  // process tree orphans. Same class as pushState()'s guard below.
  const closeWindow = (): void => { if (!win.isDestroyed()) win.close() }
  // The person chose what closing the last tab does; closing the window is
  // the default.
  const lastTabClosed = (): void => {
    if (services.settings.get('tabs.lastTabClosed') === 'newTab') tabs.createTab()
    else closeWindow()
  }

  // Drawn behind the two panes of a split; made only when a window first splits.
  const splitFrame = new SplitFrame({
    dragTo: (at) => { const id = tabs.getState().activeTabId; if (id !== null) tabs.splits.dragTo(id, at) },
    reset: () => { const id = tabs.getState().activeTabId; if (id !== null) tabs.splits.resetRatio(id) }
  }, import.meta.dirname)

  const tabs = new TabManager(win.contentView, tabBounds, lastTabClosed, dashboardUrl, ctx, {
    window: win,
    htmlFullscreenChanged: (id, entered) => { fullscreen.changed(id, entered, tabs.getState().activeTabId) },
    fullscreenTabId: () => fullscreen.tabId,
    searchUrl: (query) => searchUrlFor(services.settings.get('search.engine'), services.settings.get('search.customUrl'), query),
    internalPages: services.internalPages,
    devtools: services.devtools,
    backdrop: splitFrame,
    tabLifecycle: services.tabLifecycle
  })

  // Queue item 4.4: the all-sites popup reads/revokes through this one
  // controller, closing over `ctx` so it always sees whichever broker is
  // currently published (permissions.ts's own doc). `scoreLevelOverrideFor`
  // is the developer-only preview path (ADR-0037, ../dev/score-levels.ts).
  const permissions = createPermissionsController(ctx, scoreLevelOverrideFor)

  // The site-info popup's own door, sibling to `permissions` above
  // (site-info-controller.ts's own header on why it is not folded into
  // that one). `isOriginServedFromCacheSync`/`pinCoverageFor`/`verifierNameEvidence`
  // are the real implementations `SiteTrustSources` asks for -- injected here
  // rather than imported by the controller itself, so it stays testable
  // against a fake session (that file's own doc).
  // `scoreLevelOverrideFor`/`deliveryLevelOverrideFor` (`../dev/score-levels.ts`)
  // and `localDdocFor` (`../dev/local-ddoc.ts`) are developer-only: no-ops
  // outside developer mode.
  const siteInfo = createSiteInfoController(ctx, { isOriginServedFromCacheSync, pinCoverageFor, nameEvidenceFor: verifierNameEvidence, levelOverrideFor: scoreLevelOverrideFor, deliveryOverrideFor: deliveryLevelOverrideFor, localDdocFor })

  /** Previous push's active tab, so pushState() can tell a genuine tab
   * SWITCH from the many other reasons state is pushed (a title, a favicon,
   * a loading flag). */
  let lastActiveTabId: string | null = null
  /** Previous push's active tab's own origin -- catches the site-info
   * popup's own extra close condition: the SAME tab navigating to a
   * DIFFERENT origin (never a reason to close the all-sites popup, which
   * shows every app, not just the active tab's). `null` for no active tab
   * or one with no canonical origin (the dashboard, about:blank). */
  let lastActiveOrigin: string | null = null

  function pushState (): void {
    // A16 makes this reachable routinely now, not just via an OS-level
    // window close: closing the last tab calls win.close() above, which
    // destroys `chrome` -- and bookmarks.onChange()/the pending
    // bookmarks.load().then(pushState) below have no other guard against
    // firing afterward. Sending on a destroyed WebContents throws, with
    // no top-level handler anywhere in this app (same class of gap
    // tabs.ts's own 'destroyed' handling exists for).
    if (chrome.webContents.isDestroyed()) return
    const state = tabs.getState()

    // Star a page the instant it opens and its favicon has not arrived yet,
    // so the bookmark is saved iconless. The fetch lands moments later and
    // pushes state -- this is where that late icon reaches the bookmark it
    // belongs to. fillMissingFavicon never overwrites an icon already
    // stored, and deliberately does not notify listeners, so this cannot
    // push state from inside a state push; the list read below already
    // reflects it.
    for (const tab of state.tabs) {
      if (tab.favicon !== null) bookmarks.fillMissingFavicon(tab.url, tab.favicon)
    }
    // Switching tabs reattaches the incoming tab's view (TabManager.
    // activateTab -> addChildView), which would stack it ABOVE the panel --
    // the panel is only on top because it was added last. Focus moving to
    // that view already closes it in practice, but this does not depend on
    // focus semantics to avoid leaving a panel stranded under a page.
    if (state.activeTabId !== lastActiveTabId) {
      lastActiveTabId = state.activeTabId
      permissionsPanel.close()
      siteInfoPanel.close()
      menuPanel.close()
    }
    // The site-info popup describes ONE origin -- a same-tab navigation
    // to a different one (the active tab id unchanged) leaves it showing
    // stale data otherwise. The all-sites popup lists every app and is
    // unaffected by this on its own.
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
    const activeOrigin = activeTab === undefined ? null : originFromUrl(activeTab.url)
    if (activeOrigin !== lastActiveOrigin) {
      lastActiveOrigin = activeOrigin
      siteInfoPanel.close()
    }
    fullscreen.tabsChanged(state.activeTabId, (id) => state.tabs.some((tab) => tab.id === id))
    chrome.webContents.send(STATE_CHANNEL, { ...state, bookmarks: bookmarks.getAll(), bookmarksBar: bookmarksBarShown(), zoomPercent: zoomChip(activeTab?.url), profile: profileLook })
  }

  // Only the first and last bookmark change the chrome's height, so the
  // relayout is guarded on the height actually moving rather than run on
  // every add and remove -- resizing two views per keystroke-speed change
  // would be visible.
  let laidOutHeight = chromeHeight()
  function onBookmarksChanged (): void {
    if (win.isDestroyed()) return
    const height = chromeHeight()
    if (height !== laidOutHeight) {
      laidOutHeight = height
      layoutChrome()
      tabs.layout()
    }
    pushState()
  }

  // Shown only when the page is not at the default level: a chip that always said 100% would be noise.
  function zoomChip (url: string | undefined): number | null {
    const origin = url === undefined ? null : originFromUrl(url)
    if (origin === null) return null
    const percent = services.zoom.percentFor(origin)
    return percent === services.zoom.defaultPercent() ? null : percent
  }

  tabs.onStateChange(pushState)
  const stopListeningToZoom = services.zoom.onChange(pushState)
  // Read when the profiles change, not on every push: it reads the disk.
  let profileLook = services.profiles.look()
  const stopListeningToProfiles = services.profiles.onChange(() => { profileLook = services.profiles.look(); pushState() })
  const stopListeningToBookmarks = bookmarks.onChange(onBookmarksChanged)
  const stopListeningToSettings = services.settings.onChange(({ key }) => {
    if (key === 'appearance.bookmarksBar') onBookmarksChanged()
  })
  // Loading is non-blocking -- no bookmarks bar for one frame on a slow
  // disk beats delaying the whole window on a non-essential feature. It
  // goes through onBookmarksChanged, not pushState: a profile that HAS
  // bookmarks grows the chrome by a row the moment they land. The store
  // reads its file once for every window, so a later window's call settles
  // at once.
  void bookmarks.load().then(onBookmarksChanged)

  // Without this, tabs.createTab() below pushes state before the chrome
  // page has loaded far enough to register its ipcRenderer listener
  // (shell.ts's contextBridge exposure runs, but main.ts's shell.onState()
  // call hasn't executed yet), so the very first tab silently fails to
  // render until some later event happens to trigger a second push.
  // did-finish-load fires after the page's module script has run (main.ts
  // registers onState before that), so this re-sync is guaranteed to
  // land, not timing-dependent.
  chrome.webContents.on('did-finish-load', pushState)
  // The preload's gate and isFromChrome compare `chromeUrl` exactly; a
  // mismatch would leave the chrome dead with no other sign.
  chrome.webContents.on('did-finish-load', () => {
    const loaded = chrome.webContents.getURL()
    if (loaded !== chromeUrl) console.error(`[window] the chrome loaded ${loaded}, not ${chromeUrl}; its commands will be refused`)
  })
  // The address bar's Cut/Copy/Paste: the same menu a tab gets, plus Inspect
  // where chrome-context-menu.ts's gate allows it.
  chrome.webContents.on('context-menu', (_event, params) => {
    showContextMenu(chrome.webContents, params, chromeContextMenuHost(devModeEnabled, services.devtools, chrome.webContents, win, (url) => { tabs.createTab(url) }))
  })

  // Queue item 4.4's permissions surface, now a panel inside this window
  // rather than a second one (owner, 2026-09-16) -- ./permissions-panel.ts.
  const permissionsPanel = createPermissionsPanel(win, win.contentView, permissions, import.meta.dirname, createSiteNotificationsController(notificationDecisions()))

  // Remembers the anchor and origin the site-info popup was last opened
  // with, so its own "Site settings" row (./site-info-panel.js's
  // `openAllSites` parameter) has somewhere sensible to open the all-sites
  // popup -- that row has no anchor of its own to measure.
  const siteInfoMemory: SiteInfoMemory = { anchor: null, origin: undefined }

  const siteInfoPanel = createSiteInfoPanel(
    win, win.contentView, siteInfo, app.getPath('userData'),
    () => tabs.activeWebContents(),
    () => {
      const { activeTabId } = tabs.getState()
      if (activeTabId !== null) tabs.reload(activeTabId)
    },
    () => {
      siteInfoPanel.close()
      permissionsPanel.toggle(siteInfoMemory.anchor ?? { x: 0, y: chromeHeight(), width: 0, height: 0 }, siteInfoMemory.origin)
    },
    import.meta.dirname
  )

  const entry: ShellWindow = { window: win, chrome, tabs, shortcutsSuspended: () => fullscreen.tabId !== null }
  const menuPanel = createMenuPanel(win, win.contentView, services.shortcuts, (id) => { services.commands.run(id, entry) }, import.meta.dirname)

  registerShellIpc(chrome.webContents, chromeUrl, tabs, bookmarks, siteInfo, shellActions({
    entry,
    services,
    panels: { permissions: permissionsPanel, siteInfo: siteInfoPanel, menu: menuPanel },
    memory: siteInfoMemory,
    openWindow: (options) => { createShellWindow(ctx, services, options) },
    topHeight: CHROME_TOP_ROWS,
    area: tabBounds
  }))
  const forgetWindow = services.windows.add(entry)
  win.on('close', () => { tabs.dispose() })
  win.on('closed', () => {
    forgetWindow()
    stopListeningToBookmarks()
    stopListeningToSettings()
    stopListeningToZoom()
    stopListeningToProfiles()
    permissionsPanel.close()
    siteInfoPanel.close()
    menuPanel.close()
    splitFrame.dispose()
    // Destroying a window leaves its views' renderers running: the chrome
    // view's is closed here, as the tabs' are by `dispose`.
    if (!chrome.webContents.isDestroyed()) chrome.webContents.close()
  })

  // win.getContentBounds() read SYNCHRONOUSLY inside 'resize' returns the
  // PRE-resize bounds under this X11 window manager -- confirmed
  // empirically. maximize() fires 'resize' immediately, but
  // layoutChrome()/tabBounds() would then compute layout from the old
  // width, leaving the chrome and tab views at their pre-maximize size
  // with no further event to correct it. A microtask deferral
  // (queueMicrotask) sees the same stale value; only a macrotask
  // (setImmediate) observes the settled bounds -- 'resized' (which would
  // avoid needing this) never fires on this platform at all. Ordinary
  // drag-resize is unaffected either way: it already fires 'resize'
  // repeatedly as the drag continues, so one tick of latency per frame
  // is not observable.
  win.on('resize', () => {
    setImmediate(() => { if (!win.isDestroyed()) layoutAll() })
  })

  layoutChrome()
  if (first === undefined) tabs.createTab()
  else first(tabs)
  // After the first tab, so the view stacks above it.
  if (intro !== undefined) showIntro(win, tabs, intro)

  showWhenReady(frame)

  return win
}
