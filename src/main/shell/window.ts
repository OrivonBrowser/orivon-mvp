// Composes the shell: a frameless BaseWindow holding a chrome
// WebContentsView (tab strip + toolbar + bookmarks bar) on top and, below
// it, whichever tab WebContentsView is active. See docs/architecture --
// there is no shell doc, this file and its neighbours (tabs.ts, ipc.ts)
// are the specification.
//
// Frameless, kept cheap (owner decision, 2026-08-26; this session's plan):
// titleBarStyle: 'hidden' + titleBarOverlay lets Electron draw native
// minimise/maximise/close on Windows/Linux; trafficLightPosition keeps
// macOS's native traffic lights, just repositioned. Verified empirically
// against this Electron version before writing this file (BaseWindow
// accepts all three options; win.setTitleBarOverlay exists) -- context7's
// docs only show these on BrowserWindow examples, and BaseWindow's own
// constructor-options doc doesn't enumerate them, so this was checked
// rather than assumed.
import { app, BaseWindow, ipcMain, nativeTheme, WebContentsView, screen } from 'electron'
import { join } from 'node:path'
import { originFromUrl } from '../../broker/policy/origin.js'
import { BookmarkStore } from '../browsing/bookmarks.js'
import { COMMAND_CHANNEL, NEWTAB_COMMAND_CHANNEL, STATE_CHANNEL } from '../channels.js'
import { registerNewTabIpc } from '../ipc/newtab-ipc.js'
import { createPermissionsController } from '../permissions/permissions.js'
import { deliveryProvenanceFor } from '../browsing/delivery-provenance.js'
import { rendererEntryUrl } from './renderer-entry.js'
import type { SubsystemContext } from '../registry.js'
import { TabManager, type Bounds } from './tabs.js'
import { registerShellIpc } from '../ipc/ipc.js'
import { createPermissionsPanel } from '../permissions/permissions-panel.js'
import { HtmlFullscreen } from './fullscreen.js'
import { createFullscreenNotice } from './fullscreen-notice.js'

// Chrome restyle, 2026-08-28 (owner: match a reference screenshot that
// turned out to be the prior prototype's chrome pixel-for-pixel --
// orivon-browser-v2, visual reference only, ADR-0002). The empty
// dedicated title row is gone; tabs now share the top row with the
// native window buttons. Height is the sum of three rows, mirrored
// exactly in src/renderer/style.css so the native chrome view and the
// CSS agree on where the tab content starts:
//   tabrow      36px (matches titleBarOverlay.height below)
// + toolbar     40px
// + bookmarks   28px, only when the bar is rendered -- see chromeHeight()
const CHROME_TOP_ROWS = 76
const BOOKMARKS_BAR_HEIGHT = 28
const CHROME_HEIGHT = CHROME_TOP_ROWS + BOOKMARKS_BAR_HEIGHT

// Kept in sync with src/renderer/style.css's --wchrome/--wink tokens --
// same dual-source-of-truth pattern as CHROME_HEIGHT above. The overlay
// is native-drawn chrome outside the renderer's DOM, so CSS alone can't
// theme it; nativeTheme.on('updated') below re-applies these on a
// live OS theme change.
const OVERLAY_DARK = { color: '#1e1f24', symbolColor: '#e6e7e8' }
const OVERLAY_LIGHT = { color: '#e4e4eb', symbolColor: '#202124' }

// Dev/test tooling only -- never gated on app.isPackaged or "is this a
// production build" (run-from-source is a real shipping path on Windows and
// macOS, build-plan.md; a real user's window must always take focus).
// showInactive() shows the window without activating it, so a build or e2e
// run started while the owner is typing elsewhere does not steal keystrokes.
// Set by `npm run dev`, and by test/launch-electron.mjs for every Electron
// launch it makes -- docs/development/setup.md.
const NO_FOCUS = process.env['ORIVON_WINDOW_NO_FOCUS'] === '1'

// Hands the app icon to the window. GNOME's dock does not read it -- the icon
// shown for a running window comes from matching the window's WM_CLASS
// ("orivon") against a .desktop entry's Icon=/StartupWMClass, and this
// option's X11 _NET_WM_ICON property stays empty on this Electron build even
// when set. Window managers that do read the property use it, so the line
// stays; packaged builds get their .desktop from electron-builder.yml.
// A packaged build loads resources/icon.png (extraResources there); a run
// from source loads the repo's build/icon.png (out/main -> ../../build).
const WINDOW_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(import.meta.dirname, '../../build/icon.png')

export function createShellWindow (ctx: SubsystemContext): BaseWindow {
  // Centers on the OS's primary display. Not on whichever display holds the
  // pointer: Wayland does not let an app control its own window position at
  // all, so that buys nothing.
  // Sized against bounds, not workArea. A display's workArea is the panel
  // minus the desktop environment's reserved struts, and on a multi-monitor
  // layout where the monitors have different heights and vertical offsets,
  // GNOME reports a work area far shorter than the monitor itself -- a
  // 1920x1080 primary can come back 328px tall. Clamping the window to that
  // produces a letterbox slot with no way to grow it from here; bounds is
  // the physical panel and is always right.
  const { bounds } = screen.getPrimaryDisplay()
  const winWidth = Math.min(1280, bounds.width)
  const winHeight = Math.min(800, bounds.height)

  const initialOverlay = nativeTheme.shouldUseDarkColors ? OVERLAY_DARK : OVERLAY_LIGHT

  const initialBounds = {
    x: bounds.x + Math.round((bounds.width - winWidth) / 2),
    y: bounds.y + Math.round((bounds.height - winHeight) / 2),
    width: winWidth,
    height: winHeight
  }

  const win = new BaseWindow({
    ...initialBounds,
    show: false,
    icon: WINDOW_ICON_PATH,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...initialOverlay,
      height: 36
    },
    // Matches orivon-browser-v2's own tab-row-height traffic-light
    // position (visual reference only) -- macOS ignores titleBarOverlay
    // entirely and uses this instead.
    trafficLightPosition: { x: 20, y: 10 }
  })

  // titleBarOverlay is Windows/Linux only and has no live theme callback
  // of its own -- re-push both colours whenever the OS scheme flips, or
  // the native buttons freeze at whatever theme was active on launch.
  // macOS ignores the call entirely (trafficLightPosition covers it), so
  // skip it there rather than call a method on a platform it doesn't
  // apply to. `nativeTheme` is a singleton shared by every window this
  // process ever creates (macOS 'activate' can create more than one over
  // a process's life) -- the listener is removed on 'closed', or a later
  // theme change would call setTitleBarOverlay on an already-destroyed
  // window.
  function applyOverlayForTheme (): void {
    if (process.platform === 'darwin') return
    win.setTitleBarOverlay(nativeTheme.shouldUseDarkColors ? OVERLAY_DARK : OVERLAY_LIGHT)
  }
  nativeTheme.on('updated', applyOverlayForTheme)
  win.on('closed', () => { nativeTheme.removeListener('updated', applyOverlayForTheme) })

  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/shell.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  win.contentView.addChildView(chrome)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined) {
    void chrome.webContents.loadURL(devServerUrl)
  } else {
    void chrome.webContents.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  // The dashboard's own resolved URL -- a genuinely fresh tab loads this
  // (src/main/tabs.ts's createTab()). Mirrors the branch immediately
  // above: electron-vite's dev server serves every renderer entry off
  // the SAME origin at a nested path (confirmed by reading its installed
  // source, since this is the second entry added to a config that
  // previously only had one); the built path matches
  // electron.vite.config.ts's `newtab` entry.
  const dashboardUrl = rendererEntryUrl(import.meta.dirname, devServerUrl, '/newtab/', '../renderer/newtab/index.html')

  // Bookmarks: owner override, 2026-08-28 (mvp-scope.md, ADR-0003) -- not
  // in the original scope pass, arrived bundled with the chrome restyle.
  // A separate store, not folded into TabManager -- tabs and bookmarks
  // change independently and neither needs to know the other exists;
  // window.ts is what composes both into the one ShellState snapshot the
  // chrome view receives.
  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))

  // The bookmarks bar is rendered only when there is something in it
  // (owner, 2026-09-15) -- it holds the real list and nothing else now, so
  // an empty one is an empty row. Main has to own this, not just CSS: the
  // tab view starts where the chrome view ends, so a row the renderer
  // hides without main shrinking these bounds leaves a 28px band of empty
  // chrome above the page instead of giving it back to the page.
  function chromeHeight (): number {
    return bookmarks.getAll().length > 0 ? CHROME_HEIGHT : CHROME_TOP_ROWS
  }

  // A page in HTML fullscreen gets the whole window and the chrome is hidden;
  // Electron only puts the window itself into fullscreen (./fullscreen.ts).
  const notice = createFullscreenNotice(win.contentView, () => win.getContentBounds().width)
  const fullscreen = new HtmlFullscreen({
    relayout: () => { layoutAll() },
    exitTab: (id) => { tabs.exitHtmlFullscreen(id) },
    leaveWindowFullscreen: () => { if (!win.isDestroyed()) win.setFullScreen(false) },
    showNotice: () => { notice.show() },
    hideNotice: () => { notice.hide() }
  })

  function layoutChrome (): void {
    const bounds = win.getContentBounds()
    chrome.setVisible(fullscreen.tabId === null)
    chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: chromeHeight() })
  }

  function tabBounds (): Bounds {
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

  const tabs = new TabManager(win.contentView, tabBounds, closeWindow, dashboardUrl, ctx, {
    window: win,
    htmlFullscreenChanged: (id, entered) => { fullscreen.changed(id, entered, tabs.getState().activeTabId) }
  })

  // Queue item 4.4: the permissions settings page and the address-bar icon
  // both read/revoke through this one controller, closing over `ctx` so it
  // always sees whichever broker is currently published (permissions.ts's
  // own doc).
  const permissions = createPermissionsController(ctx)

  /** Previous push's active tab, so pushState() can tell a genuine tab
   * SWITCH from the many other reasons state is pushed (a title, a favicon,
   * a loading flag). */
  let lastActiveTabId: string | null = null

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
    }
    fullscreen.tabsChanged(state.activeTabId, (id) => state.tabs.some((tab) => tab.id === id))
    chrome.webContents.send(STATE_CHANNEL, { ...state, bookmarks: bookmarks.getAll() })
  }

  // Only the first and last bookmark change the chrome's height, so the
  // relayout is guarded on the height actually moving rather than run on
  // every add and remove -- resizing two views per keystroke-speed change
  // would be visible.
  let laidOutHeight = chromeHeight()
  function onBookmarksChanged (): void {
    const height = chromeHeight()
    if (height !== laidOutHeight) {
      laidOutHeight = height
      layoutChrome()
      tabs.layout()
    }
    pushState()
  }

  tabs.onStateChange(pushState)
  bookmarks.onChange(onBookmarksChanged)
  // Loading is non-blocking -- no bookmarks bar for one frame on a slow
  // disk beats delaying the whole window on a non-essential feature. It
  // goes through onBookmarksChanged, not pushState: a profile that HAS
  // bookmarks grows the chrome by a row the moment they land.
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

  // Queue item 4.4's permissions surface, now a panel inside this window
  // rather than a second one (owner, 2026-09-16) -- ./permissions-panel.ts.
  const permissionsPanel = createPermissionsPanel(win, win.contentView, permissions, import.meta.dirname)

  registerShellIpc(chrome.webContents, tabs, bookmarks, permissions, (anchor, url) => {
    // The chrome view sends the active TAB's url, not an origin -- same
    // `originFromUrl` tab-view.ts's own appTabArgsFor already uses for the
    // identical derivation. undefined (no tab, or the dashboard) and an
    // unparseable url both mean "no particular app to scroll to", not an
    // error.
    const focusOrigin = url === undefined ? undefined : originFromUrl(url) ?? undefined
    permissionsPanel.toggle(anchor, focusOrigin)
  }, deliveryProvenanceFor)
  registerNewTabIpc(dashboardUrl, tabs, bookmarks)
  // A16 makes createShellWindow() re-run routinely now (close the last
  // tab, then reopen from the macOS dock via app.on('activate')), and
  // ipcMain.handle throws if the same channel is registered twice with
  // no matching removeHandler in between -- confirmed there is none
  // anywhere in this codebase. Latent before A16 (only reachable by
  // closing the OS window directly); routine after it. Both channels
  // registered above need the same cleanup.
  win.on('closed', () => {
    ipcMain.removeHandler(COMMAND_CHANNEL)
    ipcMain.removeHandler(NEWTAB_COMMAND_CHANNEL)
    // Also removes SETTINGS_COMMAND_CHANNEL, which the panel registers per
    // open -- same reregistration trap this handler already exists for.
    permissionsPanel.close()
    notice.dispose()
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
  tabs.createTab()

  // Electron's type declarations only put 'ready-to-show' on BrowserWindow's
  // typed event union; BaseWindow's own doc doesn't enumerate it either.
  // Verified empirically that it fires on BaseWindow all the same -- a
  // type-declaration gap, not a runtime one. Narrow cast, not a cast of
  // `win` to the wrong class.
  //
  // 'ready-to-show' does not fire reliably -- or fires very late -- when
  // the chrome view loads from electron-vite's dev server
  // (`loadURL(devServerUrl)`) rather than the built file, which reads as
  // "no window ever appears": the window exists the whole time, `show()`
  // is just never called. A short fallback timer closes the gap; `shown`
  // guards against calling `show()` twice if 'ready-to-show' fires late,
  // after the fallback already ran.
  let shown = false
  function showOnce (): void {
    if (shown) return
    shown = true
    if (NO_FOCUS) {
      // The one thing a real launch under a virtual display CAN check --
      // there is no window manager there to take OS focus FROM, so
      // isFocused() cannot tell showInactive() apart from show(). See
      // test/e2e-window-no-focus.test.ts, which asserts this line runs
      // instead. Do not remove as "stray debug output".
      console.log('[window] ORIVON_WINDOW_NO_FOCUS=1 -- showInactive()')
      win.showInactive()
    } else {
      win.show()
    }
    // Re-asserted after show, not just passed to the constructor. A window
    // manager may shrink a window to the display's work area as it maps it,
    // and a work area can be reported far smaller than the monitor (GNOME
    // does this on a multi-monitor layout with mixed heights and vertical
    // offsets). The constructor size loses that argument; a setBounds once
    // the window is mapped is honoured. Harmless where the first size
    // already stuck -- it sets what is already set.
    win.setBounds(initialBounds)
  }
  ;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
    .once('ready-to-show', showOnce)
  setTimeout(showOnce, 1000)

  return win
}
