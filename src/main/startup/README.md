# `src/main/startup/`: what a start opens

**What lives here.** The plan for a cold start and the offer that follows a crash. `startup-plan.ts` turns
the start-up choice (`startup.mode`, `startup.pages`), the addresses on the command line and the previous
session into what the first window opens and which windows follow. `startup-open.ts` carries that out
(tabs, display-aware placement, taking reopened windows off the closed stack). `startup-domain.ts` answers the
Settings page's two questions about the pages list. `restore-offer.ts` and `restore-overlay.ts` are the bar
that offers the last session back after a run that did not end cleanly; `startup-overlays.ts` wires it to the
real displays. `fetch-stack.ts` loads Node's `fetch`/`Response` implementation before any hook or window exists, so a debugger command cannot arrive in the middle of its lazy load.

**Tied to Electron, partly.** Only `startup-overlays.ts` imports `electron`; the rest takes plain values and
structural types, so it runs under plain vitest.

**What it depends on.** [`../session-restore/`](../session-restore/) (the saved session, `openSnapshot`,
`fillTabs`, the closed stack), [`../window-state/placement.ts`](../window-state/placement.ts),
[`../browsing/omnibox.ts`](../browsing/omnibox.ts) (which addresses load), [`../settings/`](../settings/),
[`../overlays/`](../overlays/) and the window-hook types of [`../shell/`](../shell/).

**What it must never import.** [`../../renderer/`](../../renderer/) code, or anything that creates a window:
the launch hands it `openWindow`.

**Owner stream.** `shell`.

## Design notes

**The command line is added to the choice, never replaced by it.** A person who clicked a link wants that page
in front; the restored or listed tabs stay behind it. A private session ignores the choice altogether: it is a
browser of its own, so it neither restores the last session nor is offered it.

**Both the list and the session file are data, and are read again at launch.** `startup.pages` is
re-validated line by line with the address bar's own rule (`parsePages`), and the session's tabs go through
`openSnapshot`, which checks each address once more. Nothing from either reaches the trusted opening path.

**The previous session's windows are on the closed stack already.** When the launch reopens them, or the bar's
Restore does, they are taken off it, so "Reopen closed tab" never offers the same windows twice.

**Restored tabs load at once.** This build has no deferred loading of background tabs, so a session of thirty
tabs loads thirty pages at start.

**The bar never takes focus and is answered with the mouse.** Main keeps the keys so a person typing is not
interrupted; the bar leaves by itself after thirty seconds.
