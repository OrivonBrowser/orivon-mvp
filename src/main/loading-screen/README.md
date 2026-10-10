# `src/main/loading-screen/`: the screen over a protocol page that is still loading

**What lives here.** The decision about when a tab is covered by its protocol's loading screen, and the
overlay that draws it. `loading-screen-watch.ts` follows one tab's `webContents`: from a moment after a
main-frame navigation to an address that has a screen starts until that page's document is ready, it asks for
the screen through the tab's slot queue ([`../overlays/tab-slots.ts`](../overlays/tab-slots.ts), the `cover`
slot). `loading-screen-overlay.ts` declares the overlay (a `pane` cover on the `page` surface) and words it from the
protocol's descriptor. `install-loading-screen.ts` wires the watcher to every tab. The page is
[`../../renderer/overlay/loading-screen/`](../../renderer/overlay/loading-screen/); the words come from a
protocol's `loadingScreen` in its descriptor ([`../../protocols/README.md`](../../protocols/README.md)), found by
`ProtocolAddresses.loadingScreenFor`.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`, `tab-slots.ts`);
[`../../protocols/`](../../protocols/) (`builtin.ts` for the addresses, `protocol.ts` for the `LoadingScreen` type);
[`../sad-tab/sad-tab-text.ts`](../sad-tab/sad-tab-text.ts) (`ADDRESS_LIMIT`); [`../shell/`](../shell/)
(`window-registry.ts` and `shell-installers.ts`, types only).

**What it must never import.** The renderer, a protocol's code (only the descriptors in `builtin.ts`), or a
value from the rest of the shell: the shell lists this feature (`overlays/overlays.ts`, `shell-installers.ts`),
not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron only at the edge: the watcher listens for `did-start-navigation`,
`did-redirect-navigation`, `did-navigate`, `dom-ready`, `did-fail-load`, `did-stop-loading`, `render-process-gone`
and `destroyed`. The rule it applies, and the overlay's validation, need nothing of it.

## Design notes

**A first visit's sheet words the cover under it.** `{ url, text: { title, detail, busy } }` is shown as given, for an address no protocol has a
screen for, and `claim.ts` keeps the protocol's own screen off that tab while the sheet is up ([`../app-setup/`](../app-setup/README.md)).

**The screen waits 300 ms.** A load that finishes sooner (a cached site, a reload) never flashes it. The wait
restarts when a newer navigation to a screened address begins before the screen is up; once it is up, a newer
one changes its address at once.

**Only the new page's own `dom-ready` takes it away.** The previous page's `dom-ready` can land after the new
navigation started, so the watcher counts one only after a main-frame commit (`did-navigate`) of the navigation
it armed for. For a single-page app the screen stays until its deferred bundle has run, which is the blank
stretch it exists for. A failure other than `ERR_ABORTED` (a navigation replaced by a newer one), a stop, a
redirect to an address with no screen, a crashed renderer and a destroyed tab all take it away; the load-error
sheet then takes over for a failure.

**It lies under every sheet and prompt, on purpose.** A page blocked on `alert()` never reaches `dom-ready`, and
a sign-in sheet or a permission prompt may be what the load is waiting for. The cover layer, not the watcher,
keeps them on top ([`../overlays/README.md`](../overlays/README.md)).

**It takes no focus and has no button.** The person's keyboard stays in the address bar or the page, and the
overlay's `request` accepts no command. Escape closes nothing, because the cover is not what the person is
reading.
