# Window drag and strip clicks: can the empty end of the tab strip move the window and open a tab?

**Status: research, 2026-10-03. Answers A292; nothing here is built or decided.** Every claim is
marked **measured** (a run on this machine, with the command in §8) or **read** (from the upstream
source cited in §3 and §4). The measuring setup is real pointer input into real windows, on a private
virtual display, so none of it touched the owner's screen or speakers.

## 1. The answer

1. **Brave does not open a tab on a middle click on its empty tab strip.** Measured on Brave
   154.1.96.61 (Chromium 154), on X11 with a window manager and on Wayland with a real compositor,
   under both values of the GNOME middle-click action that matter (`lower`, `none`): the tab count
   stayed at 1 every time. What the click does is the *desktop's* action: on X11 with `lower` it
   lowers the window, in every other combination it does nothing. The only middle click that opens a
   tab in Chromium's source is on the `+` button (it opens the clipboard's URL, or searches it), and
   it did nothing with an empty clipboard. So the premise "Brave opens a tab there" is not
   reproduced here; the owner may have meant the `+` button, another platform, or another setting
   (§6, "To ask the owner").
2. **Brave moves the window with the same mechanism Orivon uses.** Its empty strip is a caption
   area (`HTCAPTION`), the same hit-test answer Electron's `-webkit-app-region: drag` produces. The
   same Chromium event filter handles both, so Brave has *exactly* the page-sees-nothing behaviour
   Orivon has today.
3. **Electron 44 cannot give the page a middle press inside a drag region, by any API.** Measured on
   every variant that has one (`titleBarStyle: 'hidden'` with the overlay, plain `frame: false`, a
   `BrowserWindow`, a drag region under a stacked view): the page gets no event of any button, and
   neither does `before-mouse-event` or `input-event` in the main process. It is by construction
   (§5.1): the frame view claims the whole hit-tested rectangle. It does not change with the GNOME
   action or with X11 versus Wayland. One button is an exception: the right button reaches the page
   if the window's `system-context-menu` event is cancelled.
4. **What does work, without a native module: split the pixels.** A region that is a drag region for
   one part of the strip and `no-drag` for the rest gives the window manager's drag *and* the
   page's middle click, on X11 and on Wayland, each in its own part (measured). The cost is that no
   pixel does both.
5. **The fix that gives both on the same pixels is a small change inside Electron** (§5): the
   right-click path already re-dispatches the press to the page with draggable regions switched
   off; the middle button is not in that path. Not built, not testable here (needs an Electron
   build).

Recommendation in §6: build nothing yet. If the owner wants the behaviour before an Electron change,
the safe no-native-module design is the top-band split, §6 option B.

## 2. Setup

| | |
|---|---|
| Brave | `/opt/brave.com/brave/brave`, 154.1.96.61 (Chromium 154), its default custom frame |
| Electron | 44.0.0 (Chromium 152.0.7977.54), the repository's `node_modules` copy, `--no-sandbox --disable-gpu --mute-audio`, `ELECTRON_RUN_AS_NODE` removed |
| X11 | a private `Xvfb :97/:98` (1280x800x24) with `openbox 3.6.1` as the window manager, plus a second client window (`xmessage`) to see stacking |
| Wayland | a private `gnome-shell --wayland --headless --no-x11 --virtual-monitor 1280x800` (GNOME Shell 46.0, mutter 46.2) in its own `XDG_RUNTIME_DIR` and session bus, so there is no socket to the owner's compositor; a second client window (a GTK dummy) for stacking. `weston`, `cage`, `sway` and `mutter` are not installed |
| Input | X11: XTest through `ctypes` (`XTestFakeMotionEvent`, `XTestFakeButtonEvent`; the recipe `test/toolbar/e2e-omnibox.test.ts` already uses). Wayland: a tiny GNOME Shell extension that creates a `Clutter` virtual pointer and evaluates JS from a file, which also reports window frames, stacking and screenshots |
| GNOME actions | the middle-click and double-click title-bar actions, set per run through a private `GSETTINGS_BACKEND=keyfile` and a `gtk-3.0`/`gtk-4.0` `settings.ini` (`gtk-titlebar-middle-click`), so the owner's settings are never read or written |
| Launch discipline | every run goes `heavy node scripts/run-headless.mjs dbus-run-session -- bash <script>`; `PULSE_SERVER=unix:/nonexistent`, audio muted; the Wayland scripts unset `DISPLAY` and point `WAYLAND_DISPLAY` at the private socket |

GNOME on this machine: `action-middle-click-titlebar='lower'`, `action-double-click-titlebar='toggle-maximize'`.
Chromium does not read `org.gnome.desktop.wm.preferences` itself; it asks GTK for
`gtk-titlebar-middle-click` (`ui/gtk/settings_provider_gtk.cc`), which GNOME fills in from that key.
GNOME fills that property in from the key on a real session; on a bare X server nothing does, so the
`settings.ini` entry stands in for it. Measured: with only the keyfile, `lower` and `minimize` both
left the Brave window alone; with the `settings.ini` entry `lower` lowered it.

## 3. What Brave does (measured)

Brave opened on `about:blank` with a throwaway profile, `--remote-debugging-port`, tab count read from
`/json`, window geometry and stacking from the X server (`xwininfo`, `_NET_CLIENT_LIST_STACKING`) or
from the shell. Points: empty strip = 500 to 600 px along the strip, well right of the `+` and left of
the window buttons; `+` = its glyph.

| Action | X11 + openbox, `lower` | X11 + openbox, `none` | Wayland (mutter), `lower` | Wayland (mutter), `none` |
|---|---|---|---|---|
| Middle click on the empty strip | tabs 1, **window lowered** (stack order flipped) | tabs 1, nothing | tabs 1, nothing (no lowering) | tabs 1, nothing |
| Middle click on `+` (empty clipboard) | tabs 1 | tabs 1 | tabs 1 | tabs 1 |
| Left click on `+` (control) | tabs 2 | tabs 2 | tabs 2 | tabs 2 |
| Left click on the empty strip | nothing (raised the lowered window) | nothing | nothing | nothing |
| Left drag from the empty strip, +100,+100 | window moved +92,+92 (WM move, after the drag threshold) | same | moved +100,+100 (compositor move) | same |
| Double click on the empty strip | maximised (1280x800) | maximised | geometry changed (1068x658 to 1100x700) | not run |

Commands: `brave-x11.sh <lower|none>` and `brave-wl.sh <lower|none>` (§8). The Wayland `lower` cell
shows nothing because Chromium's `LowerWindow` is compiled for X11 only (§4), not because the click
was lost: the same injected middle click produces `auxclick` in the Electron probe on the same
compositor (§5.2). Only `lower` and `none` are valid comparisons: a first `minimize` run was made
before the `gtk-*/settings.ini` entry existed (§2) and changed nothing, so it is not a datum.

## 4. How Chromium delivers it (read, from `main` on 2026-10-03; Electron 44 is Chromium 152)

1. **Hit test.** The browser frame decides what a point is. `OpaqueBrowserFrameView::NonClientHitTest`
   and `BrowserView::NonClientHitTest` (`chrome/browser/ui/views/frame/`) ask
   `HorizontalTabStripRegionView::IsPositionInWindowCaption(point)`
   (`.../frame/horizontal_tab_strip_region_view.cc`), which is false over the `+` button, the combo
   button and the tabs themselves and true over everything else in the strip. True becomes `HTCAPTION`.
2. **Event filter.** `views::WindowEventFilterLinux`
   (`ui/views/widget/desktop_aura/window_event_filter_linux.cc`) is a pre-target filter on the root
   window. For a mouse press it asks the delegate for the hit test and, on `HTCAPTION`, calls
   `OnClickedCaption`, which marks the event handled only for the actions that act on the window:
   - **left press:** only records `begin_drag_location_`; a later `kMouseDragged` past
     `GetWindowDragThresholdPx()` calls `DispatchHostWindowDragMovement(HTCAPTION, ...)`, the
     window-manager move (`_NET_WM_MOVERESIZE` on X11, `xdg_toplevel.move` on Wayland). That is why a
     plain click on the caption does nothing and a drag moves the window.
   - **double left press:** `kDoubleClick` action, default toggle maximise.
   - **right press:** `kRightClick`, default the window menu.
   - **middle press:** `kMiddleClick` from `ui::LinuxUi::GetWindowFrameAction`, defaulting to
     `kNone`. `kLower` calls `LowerWindow()`, which is `#if BUILDFLAG(SUPPORTS_OZONE_X11)` only, and
     `SetHandled()`s the event; `kMinimize` and `kToggleMaximize` act and `SetHandled()`; `kNone`
     leaves it unhandled.
3. **Who handles a middle click that the filter lets through.** The *target view*. For the browser
   that is the frame view, which has no middle-click behaviour. `TabStrip` only handles a middle press
   on the new-tab *button* (`TabStrip::NewTabButtonPressed` and `tabs/shared/new_tab_button.cc`:
   `IsOnlyMiddleMouseButton()` then `chrome::NewTabFromClipboardURL`), and a middle press on a *tab*
   closes it (`tabs/tab.cc`). There is no code path that opens a tab from a middle click on
   empty strip space in Chromium. Brave's `BraveTabStrip` adds only `CanCloseTabViaMiddleButtonClick`
   (a preference); a search of `brave-core` for a handler on the empty strip found none.

Electron's `-webkit-app-region: drag` is not a different mechanism: the renderer reports the drag
rectangles, `electron::api::WebContentsView::NonClientHitTest` answers `HTCAPTION` inside them, and
the same filter runs. So the question for Electron is only how the *target* is chosen, §5.

## 5. What Electron 44 allows (read, then measured)

### 5.1 Read

- `electron/shell/browser/ui/views/frameless_view.cc`: `FramelessView::TargetForRect` returns *the frame
  view itself* whenever `NonClientHitTest(point)` is not `HTCLIENT`. In aura the target is chosen from
  the hit-tested rectangle, so a press over a drag region is delivered to the frame view and the
  `WebContentsView` underneath, and any view stacked above it (the hit test is window-wide, by the
  region of the web contents that declared it), never sees it. This is why A292's "even under a view
  stacked above it" holds.
- `electron/shell/browser/ui/electron_desktop_window_tree_host_linux.cc`,
  `ElectronDesktopWindowTreeHostLinux::DispatchEvent`: a press that is a *system menu trigger*
  (right button, or left with Control) over a non-client area emits the window's
  `system-context-menu` event. If the app cancels it, the host sets
  `electron::api::WebContents::SetDisableDraggableRegions(true)` around a re-dispatch of the press, so
  `WebContents::draggable_region()` returns null, the hit test comes back `HTCLIENT`, and the page
  receives it. Otherwise Electron shows the window-controls menu. **The middle button is not a
  trigger**, so it takes the ordinary path and is claimed by the frame view.
- `electron.d.ts`: no `startMoving`, `beginMove`, `setDraggable`; `before-mouse-event` and
  `input-event` are `WebContents` events, delivered from the render widget host, after the aura target
  has been chosen.

### 5.2 Measured

Probe app: a window with a 40 px strip (`tab` and `+` marked `no-drag`, a tail whose drag status is
the variant), a body, and listeners that log `pointerdown`, `mousedown`, `mouseup`, `click`,
`auxclick`, `dblclick`, `contextmenu` from the page and `before-mouse-event`, `input-event`,
`system-context-menu` from the main process (appendix A). A drag region is "silent" below when none of
those fired for a press.

| Variant (BaseWindow + WebContentsView unless stated) | Middle press in the drag part | Left press, no movement | Right press | Left drag | Middle press in the no-drag part |
|---|---|---|---|---|---|
| **`prod`: `titleBarStyle:'hidden'` + `titleBarOverlay`, whole strip a drag region (Orivon today)** | silent; X11 `lower`: window lowered; `none` and Wayland: nothing | silent | page silent; main gets `system-context-menu`; on Wayland the compositor's window menu also opens | WM move (X11 +92, Wayland +100) | `+` button: `auxclick` reaches the page |
| `frameless`: `frame:false`, whole strip a drag region | silent (same as above) | silent | page silent | WM move | `+`: reaches the page |
| `bw-drag`: a `BrowserWindow`, `frame:false`, drag region | silent | silent | silent | WM move | reaches the page |
| `overlay-view`: drag region plus a transparent `WebContentsView` stacked above the tail | silent (the overlay gets nothing) | silent | silent | WM move | `+`: reaches the page |
| `frameless-ctx`: `frameless` plus `win.on('system-context-menu', e => e.preventDefault())` | silent | silent | **reaches the page** (`contextmenu` and `auxclick`), X11 and Wayland | WM move | reaches the page |
| `drag-partial`: tail split, left 60% drag, right 40% `no-drag` | left part silent; **right part: `auxclick` reaches the page** | left part silent (right part not measured) | left part: page silent | left part WM move | right part reaches the page |
| `drag-band`: the strip's top 8 px a drag region, the rest of the tail `no-drag` | top 8 px silent; **the rest of the tail: `auxclick` reaches the page** | `click` reaches the page below the band | `contextmenu` reaches the page below the band | **from the top 8 px: WM move (X11 +92,+55; Wayland +100,+60)**; from below it: nothing moves | below the band: reaches the page |
| `nodrag`: no drag region at all (control) | reaches the page | reaches the page | reaches the page | nothing moves | reaches the page |
| `system-frame` (`frame:true`, the strip is client area) | reaches the page | reaches the page | reaches the page | the strip does not move the window (dragging the title bar was not measured) | reaches the page |
| `bw-system-frame` (`BrowserWindow`, `frame:true`), X11 only | same as `system-frame` | same | same | same | same |

Notes on reading the table.

- **GNOME action.** In the silent cells the only thing that varies is the desktop's reaction, not the
  page's: `lower` lowers the window on X11 (stack order flipped), `none` does nothing, and on Wayland
  nothing happens either way (`LowerWindow` is X11-only). The page receives nothing under any of
  them. The setting changes the desktop's reaction, never the delivery. The drag region delivers
  nothing under Wayland either, with the same `mouseLeave`-only trace.
- **What the page and main see in a drag region.** Only a `mouseLeave` when the pointer enters the
  region, nothing at press or release. `before-mouse-event` and `input-event` carry no more than the
  page does, so the main process cannot observe the press either.
- **The Wayland window menu.** On a right press in a drag region mutter opens its window menu, which
  swallows the next click; the Wayland `prod` rows for "middle on `+`" right after the right press
  therefore show nothing. The `drag-band` and `frameless-ctx` Wayland runs, and the X11 runs, show
  the `+` control working.
- **`system-frame` on GNOME Wayland.** Electron draws its own title bar, about 32 px tall, above the
  strip (capture `electron-wl-system-frame.png`); under openbox the window manager's bar is 28 px.
- **Electron's window frame.** With the overlay or `frame:false` Electron draws a 4 px client-side
  shadow border on X11 too (window 908x504 for a 900x500 request); the numbers above are the page's
  own coordinates.

## 6. Options, and a recommendation

| Option | WM drag on the tail | Middle click on the empty strip opens a tab | Cost | Safe to build |
|---|---|---|---|---|
| **A. Today**: the whole tail is a drag region | yes | no (desktop action only) | none; the same as Brave | built |
| **B. Top-band split**: drag region = the strip's top 6 to 8 px (plus the gutters at both ends); the rest of the tail `no-drag` | yes, from the band and the gutters | yes, from everywhere else in the strip | the drag target is a thin line; a smaller target is a real usability loss on a trackpad. The page then owns what the caption owned: double click to maximise is a `win.maximize()`/`unmaximize()` call over IPC (`BaseWindow.maximize()` asks the window manager on both X11 and Wayland; not measured here), the strip's own context menu is the page's | yes: CSS plus one IPC; no native module, no change to the broker or the contracts |
| **C. Side split** (`drag-partial`): a `no-drag` new-tab zone just right of the `+` (say the next 120 to 160 px), the rest a drag region | yes, from the remaining tail | yes, only in the zone | the zone is small, so "anywhere on the empty strip" is not met | yes, same as B |
| **D. System title bar** (`frame:true`) | yes, from the title bar | yes (strip is client area) | 28 to 32 px of vertical space on every window; the strip no longer shares the title bar | yes, but it undoes the browser-grade look |
| **E. JS-driven move** (`setPosition` from the strip, as before) | not by the WM: no tiling, and on Wayland `setPosition` does nothing | yes | loses the native move on the primary Linux session | no |
| **F. Stacked transparent view, or a main-process listener** | no change | no: measured silent in both | none worth paying | no |
| **G. Cancel `system-context-menu`** | yes | no (right button only) | a free way to give the page a right click on the tail (a custom strip menu) | yes; not what A292 asks |
| **H. An Electron change**: give the middle press the right press's path in `ElectronDesktopWindowTreeHostLinux::DispatchEvent` | yes | yes, on the same pixels | an Electron build (not available here), upstreamed or carried as a patch | yes once built; see below |

**Recommendation.** No stock-Electron option gives both on the *same* pixels. Of the options that
give both at all, only H keeps the whole empty end working for both, and it is a change inside
Electron itself: a fork or a patch to carry. Whether that fits Rules 6 and 8 is the owner's to say. So:

1. **Do not build anything for A292 now.** Today's behaviour is exactly Brave's measured behaviour;
   the only difference is the owner's recollection (§1 point 1). Ask first.
2. **If the owner still wants it, take B**, with the `+` button and the first tab's gutter also
   draggable, and implement double-click-to-maximise over IPC. It needs no native module and no
   permission change. What it spends is drag area, which the owner should weigh against the benefit
   of a middle click on empty space; it is the owner's call.
3. **The proper fix is H**, upstream or carried. Sketch, **not built and not compiled**: in
   `ElectronDesktopWindowTreeHostLinux::DispatchEvent`, add `mouse_event->IsMiddleMouseButton()` to the
   press conditions and, instead of the window-controls menu, emit a new `BaseWindow` event
   (`system-middle-click`) with a `preventDefault` convention like `system-context-menu`'s; when
   prevented, run the same `SetDisableDraggableRegions(true)` re-dispatch. The release already reaches
   the page after such a press (measured for the right button: `auxclick` fires, so aura's mouse
   capture follows the press). With the region disabled for that dispatch, `WindowEventFilterLinux`
   sees `HTCLIENT`, so GNOME's `lower` does not run either. Left presses are untouched, so the WM
   drag survives.

### To ask the owner

- What exactly did Brave do: which platform (Windows, Linux X11, Linux Wayland), which version, the
  `+` button or the empty strip, vertical tabs or horizontal. Measured here, the Linux strip does
  not open a tab (§3).
- Whether a thinner drag target (B) is an acceptable price for the middle click, or the behaviour
  should wait for H.

## 7. Caveats

- The Chromium sources are `main` on 2026-10-03 (Chromium 154 stable); Electron 44 ships 152. The
  filter and the hit-test chain have been stable for years, and the Electron measurements above are
  on 152, but the line numbers are not.
- Brave's behaviour was measured on 154.1.96.61 only, with its default settings and a fresh profile.
- The X11 runs use openbox; GNOME on X11 would use mutter's X11 mode with the same
  `_NET_WM_MOVERESIZE`. The Wayland runs use the machine's own mutter 46.2 headless, the closest
  stand-in for the owner's session available without touching it.
- The Brave double click on Wayland was not read as a maximise flag (only a geometry change); the
  X11 row is definitive.
- `minimize` and `toggle-maximize` as middle-click actions were not run through the Electron probe:
  `lower`, `none` and the no-op Wayland case already show the page is never reached, and the
  frame-action table in §4 shows `minimize` and `toggle-maximize` act on the window the same way.

## 8. Reproducing it

The scripts are not in the repository (it takes TypeScript and Markdown only); the load-bearing parts are
in the appendices, and the full set is in the session scratchpad that produced this page. The runs are

```
# Brave, X11 + openbox (middle-click action = lower | none)
~/.claude/orivon-fleet/bin/heavy node scripts/run-headless.mjs dbus-run-session -- bash brave-x11.sh lower
# Brave, Wayland (private GNOME Shell)
~/.claude/orivon-fleet/bin/heavy node scripts/run-headless.mjs dbus-run-session -- bash brave-wl.sh lower
# Electron probe, one variant per run: prod frameless drag-partial drag-band nodrag overlay-view
#   system-frame frameless-ctx bw-drag bw-system-frame
~/.claude/orivon-fleet/bin/heavy node scripts/run-headless.mjs dbus-run-session -- bash probe-x11.sh prod lower
~/.claude/orivon-fleet/bin/heavy node scripts/run-headless.mjs dbus-run-session -- bash probe-wl.sh prod lower
```

Each script: starts the display (Xvfb + openbox + `xmessage`, or `gnome-shell --headless` + the probe
extension + a GTK dummy window), writes the GNOME settings, starts Brave or the probe, waits, then
injects clicks and prints, after each step, the new log lines, the window frame and the stacking
order. `heavy` waits for a quiet machine and caps a run at 2 cores and 5 GB. After a run nothing
remains: the scripts' trap kills every child and removes the `/tmp/orivon-titlebar-*` profile.

### Appendix A: the Electron probe

`main.js`, the parts that matter (the rest is window options per variant):

```js
const { app, BaseWindow, BrowserWindow, WebContentsView } = require('electron')
// hook(wc, tag): console-message lines starting "PAGE" go to the log, plus
// wc.on('before-mouse-event', (e, m) => log(...)) and wc.on('input-event', ...) for non-move mouse events
// prod:          { titleBarStyle: 'hidden', titleBarOverlay: { color:'#dde', symbolColor:'#000', height:36 } }
// frameless*:    { frame: false }          system-frame: {} (default frame)
// frameless-ctx: win.on('system-context-menu', (e) => { log('...'); e.preventDefault() })
// overlay-view:  a second transparent WebContentsView at x:300 y:0 400x40 stacked above
const win = new BaseWindow({ x: 100, y: 100, width: 900, height: 500, title: 'probe-' + variant, ...variantOptions })
const view = new WebContentsView({ webPreferences: { sandbox: true } })
win.contentView.addChildView(view)
view.webContents.loadFile('probe.html', { query: { v: pageVariant } })
```

`probe.html`: `#strip` (40 px flex row) holding `#tab` and `#plus` (`.nodrag`) and `#tail`; the variant sets
`-webkit-app-region` on the strip (`drag-all`), on halves of the tail (`drag-partial`), or on an 8 px
absolutely positioned band at the tail's top with the rest `no-drag` (`drag-band`); a capture-phase
listener logs `pointerdown pointerup mousedown mouseup auxclick click dblclick contextmenu` with
`e.button`, the target id and the page coordinates.

### Appendix B: X11 input (`xt.py`)

```python
import ctypes, sys, time
x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
d = ctypes.c_void_p(x11.XOpenDisplay(None))
def move(x, y, t=0.12): xtst.XTestFakeMotionEvent(d, -1, int(x), int(y), 0); x11.XFlush(d); time.sleep(t)
def btn(b, down, t=0.06): xtst.XTestFakeButtonEvent(d, int(b), 1 if down else 0, 0); x11.XFlush(d); time.sleep(t)
# click: move, btn(b, True), btn(b, False, 0.1)
# drag:  move, btn(1, True, 0.15), 12 steps of move(..., 0.05), sleep 0.2, btn(1, False, 0.2)
```

The window's place comes from `xwininfo -id <window> | awk '/Absolute upper-left/'`, the `+` glyph from
an `ImageGrab.grab(xdisplay=...)` capture (the one black cluster in the strip), and lowering from
`xprop -root _NET_CLIENT_LIST_STACKING` with the `xmessage` window as the reference.

### Appendix C: Wayland input and observation (the shell extension)

`$XDG_DATA_HOME/gnome-shell/extensions/probe@orivon/extension.js`, enabled through
`org.gnome.shell enabled-extensions` in the private keyfile; every 100 ms it evaluates `$PROBE_DIR/cmd.js`
and writes `cmd.out`:

```js
const seat = Clutter.get_default_backend().get_default_seat();
const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
const api = {
  motion: (x, y) => ptr.notify_absolute_motion(GLib.get_monotonic_time(), x, y),
  button: (b, down) => ptr.notify_button(GLib.get_monotonic_time(), b, down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED),
  windows: () => global.get_window_actors().map((a) => { const w = a.meta_window, r = w.get_frame_rect(); return `${w.get_title()}|${w.get_wm_class()}|${r.x},${r.y},${r.width}x${r.height}`; }).join('\n'),
  stack: () => global.display.sort_windows_by_stacking(global.get_window_actors().map((a) => a.meta_window)).map((w) => w.get_title()).join(' < '),
};
```

A screenshot is `new Shell.Screenshot().screenshot(false, stream, cb)`. The shell is started with
`LIBGL_ALWAYS_SOFTWARE=1`; it logs that it opened the render nodes "using no mode setting", that is, it
did not take over any display.
