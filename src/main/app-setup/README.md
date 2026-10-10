# `src/main/app-setup/`: what a tab shows while an app's first visit runs

**What lives here.** The shell's side of a published app's first visit
([`ADR-0076`](../../../docs/decisions/ADR-0076-a-first-visit-loads-as-a-website-while-the-app-is-asked-about-and-cached.md), which builds on
[`ADR-0075`](../../../docs/decisions/ADR-0075-a-published-app-is-let-in-when-allowed-and-each-file-is-checked-as-it-is-served.md)).
The order itself (the page loads, ask and cache beside it, reload as the app on Allow, check each file, pin) is [`../install/first-visit.ts`](../install/first-visit.ts); this folder is
what the person sees and how a tab is sent into the app. `block-tabs.ts` covers the tabs of an app found bad. `first-visit-hook.ts` is the default session's `onBeforeRequest`
handler that notices a tab's top-level GET to an origin Orivon has never held and starts the visit beside it (the request is never held), `tab-host.ts` is the way a visit enters or leaves one tab,
`tab-screens.ts` is the cover and the sheets for one tab, `setup-sheet-overlay.ts` is the sheet (a security warning, or "Couldn't download" with Try again), `setup-text.ts` is every word on
them, `install-app-setup.ts` wires the hook, and `tab-setup-ref.ts` holds what the visit reads from the shell (the screens, and the first visit that `../install/app-install-subsystem.ts` builds). The cover is the loading-screen overlay,
shown only under a sheet ([`../loading-screen/`](../loading-screen/README.md)); the sheet's page is [`../../renderer/overlay/app-setup/`](../../renderer/overlay/app-setup/).

**What it depends on.** [`../install/`](../install/) (`first-visit.ts` types), [`../loading-screen/`](../loading-screen/) (the cover's overlay name and
the claim that keeps the protocol's own screen off), [`../overlays/`](../overlays/) (`requestSlot`),
[`../shell/`](../shell/) (`navigation-hold.ts`, `window-registry.ts`, `home.ts`, types of the tab), [`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts),
[`../verifier/verifier-subsystem.ts`](../verifier/verifier-subsystem.ts)'s `verifiedHostFilter`,
[`../../loader/fetch/verifier-origin.ts`](../../loader/fetch/verifier-origin.ts), `../registry.ts` (`windowForSender`).

**What it must never import.** The loader's or the broker's code, other than types: what to ask and what to install is decided in `../install/`.

**Tied to Electron.** The hook, the installer and the sheet's overlay; `tab-screens.ts` and `setup-text.ts` need only `WebContents`' events and are tested with fakes.

**Owner stream.** `loader`. Maintenance only.

## Design notes

**The first page is never held.** The request goes on in `onBeforeRequest` and the page loads as the ordinary website it is, in the default session, with no
grants and no Node globals; the visit runs beside it. The ways out of the visit: leave the page as it is (a site that is no app, Deny, a block's sheet read), or
send the tab to the same address through the address bar's own path (Allow), so the tab swaps to the app's session before the page loads again, now as the app.

**The visit follows the tab, not the page.** A question about a page that has not committed cannot ask the page which origin it is on, so the tab
counts as still there until it starts another navigation or is destroyed (`TabScreens.moved`).

**A hint-started visit leaves its page running too.** A page on an ordinary https site reports its manifest hint after it has loaded; the visit then asks beside the running page, and Allow loads the address again as the app. Contents that no window holds as a tab have no screens to draw: the question is the only screen there, and entering reloads them.

**Nothing acts on a tab the person left.** `navigate`, `leavePage` and `stop` end the screens first, then act only if the tab is still where the visit began; `signal` aborts the caching when it is not. A block that finds bad data before the answer withdraws the question too (`DialogCaller.signal`), so the warning has the tab to itself.

**A bad app's tabs are named, not only found.** `block-tabs.ts` finds tabs by the address they show, and adds the tab the visit let in by reference
(`TabScreens.tab()`): its first page may have failed to load, so it shows no address of the origin, and entering swapped its contents for ones in the
app's own partition. Each is stopped, emptied in place, covered with the sheet, and sent back or home when the person has read it.
