# Wayland window placement and native drag-and-drop

Measured with a bare-Electron harness (Electron 44.0.0, Chrome 152.0.7977.54) against a private
headless GNOME Shell 46 (mutter 46, one virtual monitor, scale 1; two monitors for P5) and a private
Xvfb with openbox for X11. Real pointer input came from the compositor's virtual pointer and
keyboard (Wayland) and XTest (X11). Every statement below bounds that setup, not Wayland in general.

## What a Wayland client can position

| Surface role | Can the client place it? |
|---|---|
| `xdg_toplevel` (every normal window) | No. The protocol has no position request, only `move`, `resize`, `set_parent`, `show_window_menu` and size hints. The compositor decides. |
| `xdg_popup` (menu, dropdown) | Yes, relative to a rectangle of its parent, through `xdg_positioner`: anchor rect, anchor edge, gravity, offset, constraint adjustment. The compositor still applies the result and may adjust or dismiss it. |

So the owner's reading is right: a popup can say "put me below this rectangle of my parent, offset
by 10 px", and `xdg_popup.reposition` can move it later. What a client cannot do is put a normal
top-level window at a chosen global (x, y). The next sections say how far the popup lever goes in
mutter 46 and in Electron 44.

## Measurements

### P1: which Electron surfaces are `xdg_popup`

| Surface | Result |
|---|---|
| `BaseWindow` plain, `type` desktop, dock, toolbar, splash, notification | `get_toplevel`, no positioner |
| `parent`, `parent`+`modal`, `parent`+`x,y`, `focusable:false`, `alwaysOnTop`, transparent+frameless (with and without parent, skipTaskbar) | `get_toplevel`; no `xdg_toplevel.set_parent` was sent even with `parent` or `modal` |
| `window.open` with popup features | `get_toplevel` |
| `Menu.popup({x:50,y:60})` | `get_popup`: anchor rect `(50,129,1,1)`, anchor 6 (bottom-left), gravity 8 (bottom-right), constraint adjustment 41 (slide-x, flip-y, resize-y); no offset, no reactive flag, no `grab` |
| page `<select>`, `<input type=date>`, `<input type=color>` (opened with `showPicker()`) | `get_popup`: anchor rect = the element rect, anchor 6, gravity 8, constraint adjustment 8 (flip-y); no `grab` |
| title tooltip (6 s hover) | no surface appeared |

Only Chromium-internal widgets are popups. No `BaseWindow` option produces one. Not measured:
GTK dialogs, `datalist`, devtools windows.

### P2: moving a popup

- mutter 46 advertises `xdg_wm_base` v6; Electron binds v6, so `reposition` is available.
- Electron never sent `xdg_popup.reposition` in the one case tried: resizing the parent under an
  open `Menu.popup` destroyed the popup. No `BaseWindow` is a popup, so `setPosition` has nothing to
  move. `setPosition` and `setBounds` on a toplevel ignore the position (size is honoured).
- To measure the compositor's side, a GTK 4 probe client (popover, `autohide` off) was driven
  with `set_offset` every 16 ms. mutter honoured it: 120 `reposition` requests in 2 s, 121 distinct
  compositor positions, mean 16.7 ms apart (min 9, max 27). Positions were read from the compositor.
- The popup could not leave its parent. With the parent 300 px wide, a popup 312 px right of the
  parent's origin was placed; at 322 px mutter sent `popup_done`. Vertically the same: placed 11 px
  below the parent's bottom edge, dismissed at 31 px. Pushed off-screen to the left, it slid to the
  monitor edge and stayed.
- `autohide` on: the client sent `xdg_popup.grab`, and a click outside every window produced
  `popup_done`. `autohide` off: no grab, a click outside left the popup open.
- Input transparency: Electron `setIgnoreMouseEvents(true)` on a toplevel left the input region
  unchanged (220x140) and the click did not reach the window under it. Not measured for popups.

### P3: toplevel placement and `xdg_toplevel_drag_v1`

- The private shell advertises no `xdg_toplevel_drag_manager_v1` (global list in the harness
  output). The Electron 44 binary contains the Chromium client code for it (strings:
  `xdg_toplevel_drag_manager_v1`, `get_xdg_toplevel_drag`, and the log line "zcr_extended_drag_v1
  and xdg_toplevel_drag_v1 extensions not available! Window/Tab dragging won't be fully functional.").
- Compositors, cited:
  - mutter: shipped in 48 (GNOME 48). [This Week in GNOME 192](https://thisweek.gnome.org/posts/2025/03/twig-192/),
    [implementer's post](https://nickdiego.dev/blog/chromium-ozone-wayland-the-last-mile-stretch/#full-ux-support-in-mutter).
    GNOME 46 and 47 have none.
  - As of November 2024 only KWin and Jay had it (same post). The
    [wayland.app protocol page](https://wayland.app/protocols/xdg-toplevel-drag-v1) lists, as of this
    writing, Cage, COSMIC, GameScope, Hyprland, Jay, KWin, labwc, Louvre, Mir, Muffin, mutter, niri,
    phoc, river, Sway 1.11, Treeland, Wayfire and Weston.
- Chromium: merged 12 September 2024, replacing `zcr_extended_drag`
  ([Phoronix](https://www.phoronix.com/news/Chrome-xdg-toplevel-drag)). The code is
  `WaylandWindowDragController` ([header](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/ozone/platform/wayland/host/wayland_window_drag_controller.h)),
  reached from `WaylandToplevelWindow::RunMoveLoop` and `StartWindowDraggingSessionIfNeeded`
  ([source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/ozone/platform/wayland/host/wayland_toplevel_window.cc)),
  both gated on the protocol being present. Chrome's tab strip drives it; plain HTML drag does not.
- No Electron 44 API was found that reaches it (HTML drag, `-webkit-app-region`, window APIs).
  This is "not found", not "proven absent": Electron's source was not searched conclusively, and
  no compositor with the protocol was available to observe a request.

### P4: native HTML drag-and-drop (two windows, strip view + page view each)

| Item | Wayland (mutter 46) | X11 (openbox) |
|---|---|---|
| a. Escape | Source gets `dragend`, `dropEffect:'none'`, target gets `dragleave`, same millisecond. No `keydown` anywhere; a `keyup Escape` reaches the source about 100-200 ms after `dragend`. Release over nothing gives the same `dragend` with no `keyup`. | Same event shape, `none` after Escape. Release over nothing and failed drops also end with `move`, so `dropEffect` tells nothing. |
| b. `drag` outside windows | None. One `drag` with client and screen `(0,0)` when the pointer leaves the source view; nothing after. | Same. |
| c. `getCursorScreenPoint()` | `{0,0}` throughout. | Exact throughout the drag, including outside windows. `dragend.screenX/Y` is also the real release point. |
| d. Drag image | `<img>` 480x300 shown pixel-exact; offsets (20,10), (0,0), (240,150) honoured to the pixel. Canvas 480x300 the same. 1000x600 not scaled (clipped by the screen edge). | Identical. |
| e. Rates | `dragover` about 62/s while the pointer moves at 16 ms steps; 0 while still. Source `drag` fires with each move, none while still. | Same while moving; while still `dragover` repeats about every 300 ms. |
| e. Hiding the source | `display:none` or `opacity:0` set in `requestAnimationFrame` or `setTimeout(0)`: drag continues, drop works. `display:none` synchronously inside `dragstart`: `dragend` at once, drag lost. | Identical. |
| f. Drop right after entering | Trap confirmed: moving in with one pointer jump and releasing at once, or waiting 3 s, gives `dragleave` and `dragend none`, no `drop`. One further 2 px real motion makes it work. `webContents.sendInputEvent` mouse moves do not nudge it. | Immediate release after a jump also fails; a 3 s wait works (periodic `dragover`). |
| g. Page views | Under a transparent catcher: zero events. Without a catcher: `dragenter/over/leave` with `types` listing the custom type and `chromium/x-drag-id`, `getData` empty, no `drop` unless the page cancels `dragover`. | Identical. |
| h. Drop on the source's own catcher | `drop` on the catcher at `(270,165)` catcher coordinates, then source `dragend` 1 ms later at `(270,205)` in strip coordinates (same window). | Same order and timing; `dragend` carries the real screen point too. |

Other: the window-control overlay of a `titleBarStyle:'hidden'` window is not a drop target (the
pointer over it gave `dragleave`); keep drop targets clear of it. Wayland `screenX/Y` on
`dragenter` and `drop` is a bogus `(542,402)`; use client coordinates.

### P5: placing a new window

mutter places a new toplevel on the monitor under the pointer (two monitors: pointer at
(1800,400) gave a window at (1318,65); pointer at (1400,700) gave (1318,265)). Within the monitor it
picks the first free spot, with no dependence on the pointer position, the requested `x,y` or a
drag in progress (windows opened mid-drag landed at the same kind of spot). `center-new-windows`
centres every window; that is a user setting.

## What this means

1. **Drag preview.** The native drag image is the one thing that follows the pointer anywhere on
   Wayland, at full size, with the offset honoured. A popup preview could follow at 60 Hz in
   mutter, but it must stay within about a dozen pixels of its parent and Electron cannot create
   one, so popups do not apply. Use an already decoded `<img>` as the drag image.
2. **Torn-off window.** On Wayland its position stays mutter's (first free spot on the pointer's
   monitor); nothing in Electron changes that, and `xdg_toplevel_drag_v1` is out of reach
   (GNOME 48 and newer, KWin and others have it, and no Electron API reaches it). On X11 place it
   from `dragend.screenX/Y` or `getCursorScreenPoint()`.
3. **Native drag-and-drop build.** Carry a nonce, never the tab. Accept in a transparent catcher
   over each page. Treat `dragend` with `none` and no `drop` as cancelled; Escape and release over
   nothing cannot be told apart by `dropEffect`, and on X11 `dropEffect` is not usable at all.
   Expect no events outside the app's windows, so release-over-nothing is `dragend` without a
   preceding `drop`. Hide the source tab one frame after `dragstart`. On Wayland a target needs a
   real motion after entering before a drop works; do not rely on a still pointer. Keep drop
   targets off the window-control overlay.
