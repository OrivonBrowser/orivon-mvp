# `src/main/focus/`: moving the keyboard through the window

**What lives here.** Which web contents holds the keyboard; F6 and Shift+F6 across the address bar, toolbar, tab strip, bookmarks bar, any pane docked
beside the page (`external-panes.ts`) and the page; and caret browsing.

| File | What it is |
|---|---|
| `pane-order.ts` | pure: the panes in order, and which one follows another |
| `pane-cycle.ts` | `cyclePane` (the F6 commands), `leaveChrome` (the chrome stepped past an end) and `goToChromePane`: they move web-contents focus and tell the chrome's `panes` module what to do |
| `external-panes.ts` | `EXTERNAL_PANES`: a pane outside the chrome that F6 stops at, one entry each |
| `caret.ts` | pure: whether F7 asks or switches, and which tabs carry caret browsing |
| `caret-runner.ts` | `toggleCaret` (the F7 command), `setCaret`, and `applyCaret` over every tab of every window |
| `caret-signal.ts` | the tab signal that gives each page the setting as it is made, returns, or leaves the new-tab page |
| `caret-confirm-overlay.ts` | the sheet F7 shows before turning it on, through a centre slot of `../overlays/tab-slots.ts` |
| `install-focus.ts` | the installer: a change to the setting reaches every open tab |
| `focused-contents-guard.ts` | `installFocusedContentsGuard`: Electron's `webContents.getFocusedWebContents()`, which its menus call on every click, without asking an offscreen contents (that call kills the main process) |

**What it depends on.** `electron` and [`../shell/`](../shell/) (types, `sendChromeEvent`, the tab-signal type and
the installer type), [`../overlays/`](../overlays/) (the slot queue and the overlay type) and
[`../page-tools/toast.ts`](../page-tools/toast.ts) (the toast codes). `external-panes.ts` lists the panes other
directories offer, such as [`../side-panel/side-panel-pane.ts`](../side-panel/side-panel-pane.ts).

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell
lists this feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron.

## Design notes

**The chrome knows its own panes; main knows everything past its edge.** A step made while the chrome holds the
keyboard is sent to the chrome (`PaneEvent` in `pane-cycle.ts`), which moves inside its panes and asks for
`pane.leave` at either end. Only main can focus another web contents, and only on a command from the key
dispatcher or on `pane.leave` from the chrome's verified frame, so no page can pull the keyboard into the address
bar or out of one of its own fields.

**Caret browsing is one setting for the profile,** applied to each tab's web contents. A tab signal applies it as
a tab is made and when a view returns; the new-tab page is left out until it navigates, so the signal also listens
to `did-navigate`.
