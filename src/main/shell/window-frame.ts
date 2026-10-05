// The native window around the shell: a frameless BaseWindow whose title-bar
// overlay follows the OS theme, and the rule for when it first appears. What
// goes inside it is window.ts's business.
//
// Frameless, kept cheap: titleBarStyle: 'hidden' + titleBarOverlay lets
// Electron draw native minimise/maximise/close on Windows/Linux;
// trafficLightPosition keeps macOS's native traffic lights, just repositioned.
// BaseWindow accepts all three options and win.setTitleBarOverlay exists
// (checked against electron.d.ts, not assumed).
import { app, BaseWindow, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import type { Placement } from './window-options.js'
import { onThemeUpdated } from './theme-colors.js'

// Kept in sync with src/renderer/style.css's --wchrome/--wink tokens --
// same dual-source-of-truth pattern as window.ts's CHROME_HEIGHT. The overlay
// is native-drawn chrome outside the renderer's DOM, so CSS alone can't
// theme it; `onThemeUpdated` below re-applies these on a live OS theme
// change.
const OVERLAY_DARK = { color: '#1e1f24', symbolColor: '#e6e7e8' }
const OVERLAY_LIGHT = { color: '#e4e4eb', symbolColor: '#202124' }
// A private window is tinted (src/renderer/style.css's `data-private`), so it is never taken for the person's own.
const OVERLAY_PRIVATE_DARK = { color: '#251c36', symbolColor: '#e6e7e8' }
const OVERLAY_PRIVATE_LIGHT = { color: '#d8cfe8', symbolColor: '#202124' }

// The window's own background at creation, same values as the overlay's `color` above
// (== src/renderer/style.css's --wchrome for each theme/private combination)
// -- Electron paints this the instant the window is created, before either
// view has a pixel to show, so it is what a tear-off (shown at once, see
// `instant` below) shows instead of a flash of white. Once a tab is shown the
// colour is that tab's (window-backing.ts).
const BACKGROUND_DARK = OVERLAY_DARK.color
const BACKGROUND_LIGHT = OVERLAY_LIGHT.color
const BACKGROUND_PRIVATE_DARK = OVERLAY_PRIVATE_DARK.color
const BACKGROUND_PRIVATE_LIGHT = OVERLAY_PRIVATE_LIGHT.color

/** Height of the native overlay: the tab row's height, in src/renderer/style.css too. */
const OVERLAY_HEIGHT = 36

/** The smallest a window can be made, a size the toolbar still leaves the address field room at:
 * styles/toolbar.css's narrow rule (its `max-width: 640px` query) is written against this width. */
export const MIN_WINDOW_WIDTH = 500
export const MIN_WINDOW_HEIGHT = 400

// Dev/test tooling only -- never gated on app.isPackaged or "is this a
// production build" (run-from-source is a real shipping path on Windows and
// macOS, build-plan.md; a real user's window must always take focus).
// showInactive() shows the window without activating it, so a build or e2e
// run started while the owner is typing elsewhere does not steal keystrokes.
// Set by `npm run dev`, and by test/support/launch-electron.mjs for every Electron
// launch it makes -- docs/development/setup.md.
const NO_FOCUS = process.env['ORIVON_WINDOW_NO_FOCUS'] === '1'

export interface WindowFrame {
  readonly win: BaseWindow
  /** Where the window was asked to open, re-asserted by `showWhenReady`. */
  readonly initialBounds: { x: number, y: number, width: number, height: number }
  /** A kiosk window holds the whole screen: nothing re-asserts a size on it. */
  readonly kiosk: boolean
}

/** The colour a window is created with, and the chrome view's, for the current
 * OS/app theme (window-backing.ts takes over the window's background once a tab
 * is shown) -- exported so window.ts can paint the chrome view (its own WebContentsView, a separate
 * surface from the BaseWindow's own background) the SAME colour before it has
 * a pixel of its own to show, one home for the fact rather than a second copy
 * of these constants there. */
export function windowBackgroundColor (isPrivate: boolean): string {
  return isPrivate
    ? (nativeTheme.shouldUseDarkColors ? BACKGROUND_PRIVATE_DARK : BACKGROUND_PRIVATE_LIGHT)
    : (nativeTheme.shouldUseDarkColors ? BACKGROUND_DARK : BACKGROUND_LIGHT)
}

/** `dirname`: the calling module's own `import.meta.dirname`, from which a run
 * from source finds the repo's build/icon.png (out/main -> ../../build). */
export function createWindowFrame (dirname: string, place: Placement = {}, isPrivate = false, kiosk = false): WindowFrame {
  const overlay = (): { color: string, symbolColor: string } => isPrivate
    ? (nativeTheme.shouldUseDarkColors ? OVERLAY_PRIVATE_DARK : OVERLAY_PRIVATE_LIGHT)
    : (nativeTheme.shouldUseDarkColors ? OVERLAY_DARK : OVERLAY_LIGHT)
  const background = (): string => windowBackgroundColor(isPrivate)
  // Hands the app icon to the window. GNOME's dock does not read it -- the
  // icon shown for a running window comes from matching the window's WM_CLASS
  // ("orivon") against a .desktop entry's Icon=/StartupWMClass, and this
  // option's X11 _NET_WM_ICON property stays empty on this Electron build even
  // when set. Window managers that do read the property use it, so the line
  // stays; packaged builds get their .desktop from electron-builder.yml.
  // A packaged build loads resources/icon.png (extraResources there).
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(dirname, '../../build/icon.png')

  // Centers on the OS's primary display. Not on whichever display holds the
  // pointer: Wayland does not let an app control its own window position at
  // all, so that buys nothing.
  // Sized against bounds, not workArea. A display's workArea is the panel
  // minus the desktop environment's reserved struts, and on a multi-monitor
  // layout where the monitors have different heights and vertical offsets,
  // Chromium on X11 clips the primary's work area to the desktop's single
  // _NET_WORKAREA rectangle, which can be far shorter than the monitor -- a
  // 1920x1080 primary can come back 328px tall. Clamping the window to that
  // produces a letterbox slot with no way to grow it from here; bounds is
  // the physical panel and is always right.
  const { bounds } = screen.getPrimaryDisplay()
  const width = Math.min(1280, bounds.width)
  const height = Math.min(800, bounds.height)
  const initialBounds = {
    x: bounds.x + Math.round((bounds.width - width) / 2),
    y: bounds.y + Math.round((bounds.height - height) / 2),
    width,
    height,
    ...place
  }

  const initialOverlay = overlay()
  const win = new BaseWindow({
    ...initialBounds,
    show: false,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    kiosk,
    icon: iconPath,
    backgroundColor: background(),
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...initialOverlay, height: OVERLAY_HEIGHT },
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
  // apply to. Registered through theme-colors.ts's `onThemeUpdated`, not a
  // `nativeTheme.on('updated', ...)` of its own -- `nativeTheme` is one
  // process-wide EventEmitter, and one direct listener per window would
  // print `MaxListenersExceededWarning [NativeTheme]` from the 4th window
  // on. Unregistered on 'closed', or a later theme change would call
  // setTitleBarOverlay on an already-destroyed window.
  function applyOverlayForTheme (): void {
    if (process.platform === 'darwin') return
    win.setTitleBarOverlay(overlay())
  }
  const unregisterOverlayThemeListener = onThemeUpdated(applyOverlayForTheme)
  win.on('closed', () => { unregisterOverlayThemeListener() })

  return { win, initialBounds, kiosk }
}

export interface ShowOptions {
  /** This is the launch's own first window (window-options.ts's own doc on `ShellWindowOptions.firstOfLaunch`)
   * -- the only window `ORIVON_WINDOW_NO_FOCUS=1` may show inactive. Every other window always takes focus. */
  firstOfLaunch?: boolean | undefined
  /** Shows the window at once instead of racing `ready-to-show` against the fallback timer -- for a window
   * whose content (a moved tab) is already rendered elsewhere, so nothing here is worth waiting on. */
  instant?: boolean | undefined
  /** Maximised once shown, from the size `initialBounds` names: un-maximising returns to it. */
  maximized?: boolean | undefined
  /** Shown without taking focus, whatever the launch switch says. */
  inactive?: boolean | undefined
  /** Called once the window has been shown. */
  onShown?: (() => void) | undefined
}

/** Shows the window once it can paint, and once only. */
export function showWhenReady ({ win, initialBounds, kiosk }: WindowFrame, options: ShowOptions = {}): void {
  const skipFocus = NO_FOCUS && options.firstOfLaunch === true
  // Electron's type declarations only put 'ready-to-show' on BrowserWindow's
  // typed event union; BaseWindow's own doc doesn't enumerate it either.
  // Verified empirically that it fires on BaseWindow all the same -- a
  // type-declaration gap, not a runtime one. Narrow cast, not a cast of
  // `win` to the wrong class.
  //
  // 'ready-to-show' does not fire reliably -- or fires very late -- when
  // the chrome view loads `chromeUrl` from electron-vite's dev server
  // rather than the built file, which reads as
  // "no window ever appears": the window exists the whole time, `show()`
  // is just never called. A short fallback timer closes the gap; `shown`
  // guards against calling `show()` twice if 'ready-to-show' fires late,
  // after the fallback already ran.
  let shown = false
  function showOnce (): void {
    if (shown || win.isDestroyed()) return
    shown = true
    if (skipFocus) {
      // The one thing a real launch under a virtual display CAN check --
      // there is no window manager there to take OS focus FROM, so
      // isFocused() cannot tell showInactive() apart from show(). See
      // test/window/e2e-window-no-focus.test.ts, which asserts this line runs
      // instead. Do not remove as "stray debug output". Only the launch's
      // first window can reach this branch (`skipFocus` above) -- a second
      // window opened under the same switch still takes focus.
      console.log('[window] ORIVON_WINDOW_NO_FOCUS=1 -- showInactive()')
      win.showInactive()
    } else if (options.inactive === true) {
      win.showInactive()
    } else {
      win.show()
    }
    // Re-asserted after show, not just passed to the constructor. A window
    // manager may shrink a window to the display's work area as it maps it,
    // and a work area can be reported far smaller than the monitor (on X11
    // Chromium clips the primary's to the single _NET_WORKAREA rectangle,
    // short on a multi-monitor layout with mixed heights). The constructor
    // size loses that argument; a setBounds once
    // the window is mapped is honoured. Harmless where the first size
    // already stuck -- it sets what is already set.
    if (!kiosk) {
      win.setBounds(initialBounds)
      if (options.maximized === true) win.maximize()
    }
    options.onShown?.()
  }
  // A tear-off or a moved-tab window's content is already rendered
  // somewhere (the tab it is given), so there is nothing worth racing
  // `ready-to-show` for -- and the background colour set above, not a
  // wait, is what keeps it from flashing white in the meantime.
  if (options.instant === true) {
    showOnce()
    return
  }
  ;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
    .once('ready-to-show', showOnce)
  setTimeout(showOnce, 1000)
}
