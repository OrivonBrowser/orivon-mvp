# `src/main/window-state/`: where the first window opens, and kiosk

**What lives here.** The place the last-used window had and how it is restored, and the kiosk switch.
`placement.ts` decides where a saved place opens given the displays there are now. `window-state-store.ts`
keeps the place in `<userData>/window-state.json` (numbers and one flag). `window-state-recorder.ts` is the
window hook that keeps it current. `kiosk.ts` names `--orivon-kiosk` and the commands a kiosk runs.

**Tied to Electron, partly.** `placement.ts`, `window-state-store.ts` and `kiosk.ts` import nothing from
`electron`. `window-state-recorder.ts` reads a `BaseWindow` through a structural type, so it is tested with
a fake. The restore itself is wired in [`../shell/first-window.ts`](../shell/first-window.ts) and the
kiosk layout in [`../shell/window-layout.ts`](../shell/window-layout.ts).

**What it depends on.** [`../storage/`](../storage/) (the debounced write), the window-hook and
window-options types of [`../shell/`](../shell/), and the command ids of [`../shortcuts/`](../shortcuts/).

**What it must never import.** `electron`, [`../shell/tabs.ts`](../shell/tabs.ts) or anything that makes a window.

**Owner stream.** `shell`.

## Design notes

**Only the first window of a launch is restored.** A later window (a new window, a tear-off) keeps the
cascade from the window it was opened from. A private session records and restores nothing: its store is
the null store.

**A place is restored only if the person could still grab the window.** At least 120 by 40 pixels of the
window's top strip must lie on a display's `bounds` (not its work area: a work area can be far smaller than
the monitor). Otherwise the window opens at the default place. A size larger than the display is reduced to
it, never below 480 by 320. A maximised window opens maximised and un-maximising gives its earlier size;
full screen is not restored. Wayland ignores positions, so there only the size and the maximised state apply.

**The bounds are read one task after the event.** Under X11 the bounds inside a `resize` or `move` event
are the old ones, so the recorder reads `getNormalBounds()` in a `setImmediate` and lets the store batch the
write. A window that is full screen, minimised or a kiosk leaves the last place alone.

**Kiosk has no exit but quit.** `--orivon-kiosk` makes every window of the process a full-screen window
with no tab strip, toolbar or bookmarks bar, showing the address it was started with (else the home page,
else the new tab page). Only back, forward, reload, zoom, find, print and quit run; quit is the one way out
(Ctrl+Shift+Q). A link that asks for a new tab still gets one and it comes to the front; with no strip the
earlier tab is reached only by closing the new one, which the page must do itself. The switch is not passed
on to a peer process, so a private window or another profile can never be started from a kiosk.
