# `src/main/app-setup/`: what a tab shows while an app's first visit runs

**What lives here.** The shell's side of a published app's first visit
([`ADR-0074`](../../../docs/decisions/ADR-0074-a-published-app-is-asked-about-and-checked-before-its-page-is-entered.md)).
The order itself (ask, download, check, enter) is [`../install/first-visit.ts`](../install/first-visit.ts); this folder is
what the person sees and where the first page is held. `first-visit-hook.ts` is the default session's `onBeforeRequest`
handler that holds a tab's top-level GET to an origin Orivon has never held, `tab-screens.ts` is the setup cover and the sheets for one
tab, `setup-sheet-overlay.ts` is the sheet (a security warning, or "Couldn't download" with Try again), `setup-text.ts` is every word on
them, `install-app-setup.ts` wires the hook, and `tab-setup-ref.ts` holds what the visit reads from the shell (the screens, and the first visit that `../install/app-install-subsystem.ts` builds). The cover is the loading-screen overlay with the stage's own
words ([`../loading-screen/`](../loading-screen/README.md)); the sheet's page is [`../../renderer/overlay/app-setup/`](../../renderer/overlay/app-setup/).

**What it depends on.** [`../install/`](../install/) (`first-visit.ts` types), [`../loading-screen/`](../loading-screen/) (the cover's overlay name and
the claim that keeps the protocol's own screen off), [`../overlays/`](../overlays/) (`requestSlot`),
[`../shell/`](../shell/) (`navigation-hold.ts`, `window-registry.ts`, `home.ts`, types of the tab), [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts),
[`../verifier/verifier-subsystem.ts`](../verifier/verifier-subsystem.ts)'s `verifiedHostFilter`,
[`../../loader/fetch/verifier-origin.ts`](../../loader/fetch/verifier-origin.ts), `../registry.ts` (`windowForSender`).

**What it must never import.** The loader's or the broker's code, other than types: what to ask and what to install is decided in `../install/`.

**Tied to Electron.** The hook, the installer and the sheet's overlay; `tab-screens.ts` and `setup-text.ts` need only `WebContents`' events and are tested with fakes.

**Owner stream.** `loader`. Maintenance only.

## Design notes

**The first page is held, not redirected.** The request waits in `onBeforeRequest` until the visit is over, so the address bar keeps naming the
app, Back and Forward are untouched, and no byte of the app's HTML reaches the tab before consent. The ways out: let the request go (a site that is
no app, or Deny), cancel it and navigate through the address bar's own path (Allow, so the tab swaps to the app's session before it loads),
or stop the pending navigation (the app was not opened: cancelling alone commits an error page for the app's address).

**The visit follows the tab, not the page.** A question about a page that has not committed cannot ask the page which origin it is on, so the tab
counts as still there until it starts another navigation or is destroyed (`TabScreens.moved`).

**A hint-started visit replaces the page only once the manifest says it is an app.** `stop()` leaves a running page's script alone, so the first stage puts an empty page in its place (`location.replace` from an isolated world, one history entry) and waits for it before anything is asked; an origin whose manifest cannot be read keeps its page (and so does not reload in a loop on the hint it sends again). That emptied page is not the person moving on, so `TabScreens` ignores the one navigation it makes itself.

**Nothing acts on a tab the person left.** `navigate`, `leavePage` and `stop` end the screens first, then act only if the tab is still where the visit began; `signal` aborts the download when it is not.
