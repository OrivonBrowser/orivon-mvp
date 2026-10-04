// Composes the shell: a frameless BaseWindow (./window-frame.ts) holding a
// chrome WebContentsView (tab strip + toolbar + bookmarks bar) on top and,
// below it, whichever tab WebContentsView is active. See docs/architecture --
// there is no shell doc, this file and its neighbours (tabs.ts, ipc.ts)
// are the specification.
import { app, clipboard, WebContentsView, type BaseWindow } from 'electron'
import { join } from 'node:path'
import { attachShown } from './attach-view.js'
import { rendererEntryUrl, validatedDevServerUrl } from './renderer-entry.js'
import { lockNavigation } from './lock-navigation.js'
import type { SubsystemContext } from '../registry.js'
import { TabManager } from './tabs.js'
import { registerShellIpc } from '../ipc/ipc.js'
import { shellActions } from './window-actions.js'
import { SplitFrame } from './split-frame.js'
import { CHROME_TOP_ROWS, createWindowLayout } from './window-layout.js'
import { sidePanelInsets, wireSidePanel } from '../side-panel/side-panel-host.js'
import { createOverlayHost } from '../overlays/overlay-host.js'
import { OVERLAYS } from '../overlays/overlays.js'
import { createWindowPanels } from './window-panels.js'
import { createWindowState } from './window-state.js'
import type { WindowContext } from './window-context.js'
import type { ShellWindow } from './window-registry.js'
import { HtmlFullscreen } from './fullscreen.js'
import { NOTICES, noticeForWindow } from './window-notice.js'
import { showContextMenu } from './context-menu.js'
import { chromeContextMenuHost } from './chrome-context-menu.js'
import { pasteAndGo } from './paste-and-go.js'
import { sendChromeEvent } from './shell-events.js'
import type { ShellWindowOptions } from './window-options.js'
import { runWindowHooks } from './window-hooks.js'
import { showIntro } from './intro-view.js'
import { createWindowFrame, showWhenReady, windowBackgroundColor } from './window-frame.js'
import { recordViewBackground } from './view-background-test-hook.js'
import { onThemeUpdated } from './theme-colors.js'
import { followActiveTabBacking } from './window-backing.js'
import type { ShellServices } from './shell-services.js'
import { resolveCurrent } from '../browsing/search-current.js'
import { bookmarksBarShown as barShown } from './bookmarks-bar/bar-visibility.js'
import { SHELL_PARTITION } from './shell-session.js'
import { NATIVE_TAB_DRAG_ARGUMENT } from '../channels.js'
import { pointerIsLocal } from './local-pointer.js'

/** The new-tab page's own URL: the dev server's nested path, or the built file. */
export function resolveDashboardUrl (): string {
  return rendererEntryUrl(import.meta.dirname, validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL']), '/newtab/', '../renderer/newtab/index.html')
}

/** One shell window. `services` are what every window of this process shares;
 * `intro`: the process's first window on a launch that opens on the welcome
 * screen (./intro-state.ts). */
export function createShellWindow (ctx: SubsystemContext, services: ShellServices, options: ShellWindowOptions = {}): BaseWindow {
  const { intro, first, place, firstOfLaunch, instant, maximized, inactive, shown } = options
  // Every window of a kiosk process is a kiosk window: a popup's window must not bring the chrome back.
  const { kiosk } = services
  const frame = createWindowFrame(import.meta.dirname, place, services.profiles.isPrivate, kiosk)
  const { win } = frame

  const devServerUrl = validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'])
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
      additionalArguments: [`--orivon-shell-url=${chromeUrl}`, ...(pointerIsLocal() ? [NATIVE_TAB_DRAG_ARGUMENT] : [])]
    }
  })
  // Set BEFORE addChildView: a freshly created WebContentsView defaults to
  // an opaque white, painted the instant it is attached -- the SAME white
  // flash tab-view.ts and popover-view.ts fix, for the same reason (this
  // view is attached ahead of its own first paint). The window's own
  // background (createWindowFrame's `background()`) covers a torn-off
  // window shown `instant` before either view exists; it does not cover
  // THIS view's own separate surface once attached. Kept live across an OS
  // theme change while the window stays open (theme-colors.ts's
  // `onThemeUpdated` below). window-frame.ts sets the window's creation
  // colour and keeps its title-bar overlay live; window-backing.ts owns the
  // window's background once a tab is shown.
  const chromeBackground = windowBackgroundColor(services.profiles.isPrivate)
  chrome.setBackgroundColor(chromeBackground)
  recordViewBackground(chrome.webContents.id, chromeBackground)
  attachShown(win.contentView, chrome)
  function applyChromeBackgroundForTheme (): void {
    const color = windowBackgroundColor(services.profiles.isPrivate)
    chrome.setBackgroundColor(color)
    recordViewBackground(chrome.webContents.id, color)
  }
  const unregisterChromeThemeListener = onThemeUpdated(applyChromeBackgroundForTheme)
  win.on('closed', () => { unregisterChromeThemeListener() })
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
  // window of this process and not folded into TabManager: tabs and bookmarks
  // change independently and neither needs to know the other exists.
  // The bookmarks bar is rendered only when it is asked for or has an item in
  // it. Main has to own this, not just CSS: the tab view starts where the
  // chrome view ends, so a row the renderer hides without main shrinking these
  // bounds leaves a 28px band of empty chrome above the page.
  function bookmarksBarShown (): boolean {
    return barShown(services)
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

  const { chromeHeight, layoutChrome, tabBounds, reachChrome } = createWindowLayout({
    win, chrome, fullscreenTabId: () => fullscreen.tabId, bookmarksBarShown, kiosk, pageInsets: () => sidePanelInsets(win)
  })

  function layoutAll (): void {
    layoutChrome()
    tabs.layout()
    notice.layout()
    // Closed rather than repositioned: a toolbar popup that follows a
    // drag-resize around is stranger than one that simply dismisses, and
    // this is what every browser does with its own.
    overlays.relayout()
  }

  // Closing the last tab closes the window, rather than leaving it open and
  // empty. No app.quit() here -- index.ts's window-all-closed handler already owns
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
    searchUrl: (query) => resolveCurrent(services, query).url,
    internalPages: services.internalPages,
    devtools: services.devtools,
    backdrop: splitFrame,
    tabLifecycle: services.tabLifecycle,
    // Recurses into this same function for the new window, so it is made from
    // the same `services` -- a private window's `services.profiles.isPrivate`
    // stays true for whatever it opens (a shift-click, popups.ts).
    openWindow: (url, loadOptions) => {
      let contents
      createShellWindow(ctx, services, { first: (newTabs) => { contents = newTabs.liveWebContents(newTabs.createTab(url, undefined, loadOptions)) } })
      if (contents === undefined) throw new Error('openWindow: the new window made no tab')
      return contents
    },
    services,
    runCommand: (id) => { services.commands.run(id, entry) }
  })
  // Read by an overlay's handler when it is first used, which is after `entry` exists.
  const overlays = createOverlayHost({
    win, contentView: win.contentView, dirname: import.meta.dirname, defs: OVERLAYS,
    context: () => context, area: tabBounds, paneArea: () => tabs.activePaneBounds(), activeContents: () => tabs.activeWebContents()
  })
  wireSidePanel(win, { adopt: overlays.adopt, area: tabBounds })
  const entry: ShellWindow = { window: win, chrome, tabs, overlays, chromeHeight, shortcutsSuspended: () => fullscreen.tabId !== null, relayout: layoutAll }

  const context: WindowContext = { window: entry, services }
  const panels = createWindowPanels({ ctx, win, services, tabs, overlays, dirname: import.meta.dirname })
  const windowState = createWindowState({
    win, chrome, tabs, services, context, fullscreen,
    layout: { chromeHeight, layoutChrome, tabBounds },
    bookmarksBarShown,
    overlays,
    closeSiteInfo: () => { panels.siteInfo.close() }
  })
  const { pushState } = windowState

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
    showContextMenu(chrome.webContents, params, chromeContextMenuHost(services.devtools, chrome.webContents, win, (url) => { tabs.createTab(url) }, () => {
      void pasteAndGo(() => clipboard.readText(), (text) => { sendChromeEvent(entry, 'navigation', { type: 'pasteAndGo', text }) })
    }, {
      on: () => services.settings.get('addressBar.showFullUrl'),
      toggle: () => { services.settings.set('addressBar.showFullUrl', !services.settings.get('addressBar.showFullUrl')) }
    }))
  })

  registerShellIpc(chrome.webContents, chromeUrl, tabs, services.bookmarks, panels.siteInfoController, shellActions({
    entry,
    services,
    panels,
    closeOverlays: overlays.closeOverlays,
    openWindow: (options) => { createShellWindow(ctx, services, options) },
    topHeight: CHROME_TOP_ROWS,
    area: tabBounds,
    reachChrome
  }))
  const forgetWindow = services.windows.add(entry)
  win.on('close', () => {
    runWindowHooks('closing', context, options)
    tabs.dispose()
  })
  win.on('closed', () => {
    forgetWindow()
    windowState.stop()
    overlays.dispose()
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
  win.on('closed', followActiveTabBacking(win, tabs))
  if (first === undefined) tabs.createTab()
  else first(tabs)
  // After the first tab, so the view stacks above it.
  if (intro !== undefined) showIntro(win, tabs, intro)
  runWindowHooks('opened', context, options)

  showWhenReady(frame, { firstOfLaunch, instant, maximized, inactive, onShown: shown })

  return win
}
