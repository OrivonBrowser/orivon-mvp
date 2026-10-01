# `src/main/shell/state/`: what a feature adds to the chrome's state

**What lives here.** One `ShellStatePart` per field a feature adds to `ShellState`, the object main pushes to the
chrome view: `home.ts` (whether the toolbar shows the Home button, live with its setting) and `shortcuts.ts` (the
bindings the chrome names in tooltips, live with the Shortcuts settings), `site-access.ts` (what the page in front was
asked for and answered, for the address bar's chip) and `popups-blocked.ts` (how many windows the page in front tried to
open and was refused, for the pop-up chip) and `content-blocked.ts` (whether the page in front is on a site with
JavaScript, images or sound switched off, for the mark on the address bar's key). Each is listed in
[`../shell-state-parts.ts`](../shell-state-parts.ts), which reads every part on each push and unsubscribes its
watchers when the window closes.

**Tied to Electron, no.** A part reads the shell's services and returns plain values.

**What it depends on.** `../shell-state-parts.ts` and the services a part reads (settings, shortcuts).

**What it must never import.** `electron`, or a renderer.

**Owner stream.** `shell`.
