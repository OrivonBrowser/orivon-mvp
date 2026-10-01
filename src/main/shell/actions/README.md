# `src/main/shell/actions/`: what the chrome asks main to do

**What lives here.** One `ChromeAction` per call the chrome view makes that is not a command: `home-open.ts` (the
Home button's click), `overlay.ts` (opening and toggling an overlay from a toolbar button), `pane-leave.ts` (the
chrome's keyboard stepping past its first or last pane, or Escape giving it back to the page) and `tab-mute.ts` (the
speaker badge on a tab). Each is listed in `CHROME_ACTIONS` in [`../chrome-actions.ts`](../chrome-actions.ts),
which is reached from [`../window-actions.ts`](../window-actions.ts) after the chrome's sender check.

**Tied to Electron, partly.** An action takes plain values and the window context; only the code it calls touches
Electron.

**What it depends on.** `../chrome-actions.ts` for the type, and the shared pieces it drives (`../home.ts`,
`../tab-commands.ts`).

**What it must never import.** A renderer, or [`../tabs.ts`](../tabs.ts) as a value.

**Owner stream.** `shell`.

## Design notes

**An action's payload is untrusted.** The sender is the chrome view, but what it names (a tab id, a flag) is
checked again here against this window's own tabs, and an unknown shape does nothing.
