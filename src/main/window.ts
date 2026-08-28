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
import { app, BaseWindow, nativeTheme, WebContentsView, screen } from 'electron'
import { join } from 'node:path'
import { BookmarkStore } from './bookmarks.js'
import { STATE_CHANNEL } from './channels.js'
import { TabManager, type Bounds } from './tabs.js'
import { registerShellIpc } from './ipc.js'

// Chrome restyle, 2026-08-28 (owner: match a reference screenshot that
// turned out to be the prior prototype's chrome pixel-for-pixel --
// orivon-browser-v2, visual reference only, ADR-0002). The empty
// dedicated title row is gone; tabs now share the top row with the
// native window buttons. Height is the sum of three rows, mirrored
// exactly in src/renderer/style.css so the native chrome view and the
// CSS agree on where the tab content starts:
//   tabrow      36px (matches titleBarOverlay.height below)
// + toolbar     40px
// + bookmarks   28px
const CHROME_HEIGHT = 104

// Kept in sync with src/renderer/style.css's --wchrome/--wink tokens --
// same dual-source-of-truth pattern as CHROME_HEIGHT above. The overlay
// is native-drawn chrome outside the renderer's DOM, so CSS alone can't
// theme it; nativeTheme.on('updated') below re-applies these on a
// live OS theme change.
const OVERLAY_DARK = { color: '#1e1f24', symbolColor: '#e6e7e8' }
const OVERLAY_LIGHT = { color: '#e4e4eb', symbolColor: '#202124' }

export function createShellWindow (): BaseWindow {
  // Centers on the OS's primary display -- no explicit x/y. A cursor-based
  // "open on whichever display has the pointer" variant was tried here
  // (2026-08-26) on a wrong diagnosis (a report of "no window appears" was
  // misread as the window opening on the wrong monitor). It wasn't: the
  // display this resolves to on that machine already *is* the user's real
  // main monitor, confirmed by the user directly, and Wayland doesn't let
  // an app control its own window position anyway (confirmed separately --
  // an explicit requested x/y was silently discarded by the compositor).
  // The actual bug was ready-to-show, below. Reverted to the simple form.
  const { workArea } = screen.getPrimaryDisplay()
  const winWidth = Math.min(1280, workArea.width)
  const winHeight = Math.min(800, workArea.height)

  const initialOverlay = nativeTheme.shouldUseDarkColors ? OVERLAY_DARK : OVERLAY_LIGHT

  const win = new BaseWindow({
    x: workArea.x + Math.round((workArea.width - winWidth) / 2),
    y: workArea.y + Math.round((workArea.height - winHeight) / 2),
    width: winWidth,
    height: winHeight,
    show: false,
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

  function layoutChrome (): void {
    const bounds = win.getContentBounds()
    chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: CHROME_HEIGHT })
  }

  function tabBounds (): Bounds {
    const bounds = win.getContentBounds()
    return { x: 0, y: CHROME_HEIGHT, width: bounds.width, height: bounds.height - CHROME_HEIGHT }
  }

  const tabs = new TabManager(win.contentView, tabBounds)

  // Bookmarks: owner override, 2026-08-28 (mvp-scope.md, ADR-0003) -- not
  // in the original scope pass, arrived bundled with the chrome restyle.
  // A separate store, not folded into TabManager -- tabs and bookmarks
  // change independently and neither needs to know the other exists;
  // window.ts is what composes both into the one ShellState snapshot the
  // chrome view receives.
  const bookmarks = new BookmarkStore(join(app.getPath('userData'), 'bookmarks.json'))

  function pushState (): void {
    chrome.webContents.send(STATE_CHANNEL, { ...tabs.getState(), bookmarks: bookmarks.getAll() })
  }

  tabs.onStateChange(pushState)
  bookmarks.onChange(pushState)
  // Loading is non-blocking -- an empty bookmarks bar for one frame on a
  // slow disk beats delaying the whole window on a non-essential feature.
  void bookmarks.load().then(pushState)

  // Real race, found by end-to-end verification (2026-08-26): tabs.createTab()
  // below pushes state before the chrome page has loaded far enough to
  // register its ipcRenderer listener (shell.ts's contextBridge exposure
  // runs, but main.ts's shell.onState() call hasn't executed yet), so the
  // very first tab silently failed to render until some later event
  // happened to trigger a second push. did-finish-load fires after the
  // page's module script has run (main.ts registers onState before that),
  // so this re-sync is guaranteed to land, not timing-dependent.
  chrome.webContents.on('did-finish-load', pushState)

  registerShellIpc(chrome.webContents, tabs, bookmarks)

  // Found while verifying maximize/resize for this restyle (2026-08-28):
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
    setImmediate(() => {
      layoutChrome()
      tabs.layout()
    })
  })

  layoutChrome()
  tabs.createTab()

  // Electron's type declarations only put 'ready-to-show' on BrowserWindow's
  // typed event union; BaseWindow's own doc doesn't enumerate it either.
  // Verified empirically (2026-08-26) that it fires on BaseWindow all the
  // same -- a type-declaration gap, not a runtime one. Narrow cast, not a
  // cast of `win` to the wrong class.
  //
  // The real bug this session (root-caused 2026-08-26 with a user directly
  // running `npm run dev` and sharing the traced output): 'ready-to-show'
  // does not fire reliably -- or fires very late -- when the chrome view
  // loads from electron-vite's dev server (`loadURL(devServerUrl)`) rather
  // than the built file. A user report of "no window ever appears" traced
  // to this exactly: the window existed the whole time, `show()` was just
  // never called. A short fallback timer closes the gap; `shown` guards
  // against calling `show()` twice if 'ready-to-show' fires late, after
  // the fallback already ran.
  let shown = false
  function showOnce (): void {
    if (shown) return
    shown = true
    win.show()
  }
  ;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
    .once('ready-to-show', showOnce)
  setTimeout(showOnce, 1000)

  return win
}
