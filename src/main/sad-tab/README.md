# `src/main/sad-tab/`: a tab whose page died, stopped answering or failed to load

**What lives here.** The card over such a tab and the decision about when it is up.
`sad-tab-text.ts` is the fixed table of what the card says per reason. `sad-tab-state.ts` reads what
is wrong with a tab's page off its record (a crash is on the record, a hang is remembered here).
`sad-tab-controller.ts` opens, keeps or closes one window's card to match its active tab.
`sad-tab-overlay.ts` declares the card as an overlay and runs its three buttons. The page is
[`../../renderer/overlay/sad-tab/`](../../renderer/overlay/sad-tab/); the events that feed this come from
[`../shell/signals/crashed.ts`](../shell/signals/crashed.ts), and the strip's warning icon is
[`../../renderer/chrome/tab-crashed.ts`](../../renderer/chrome/tab-crashed.ts).

The sheet over a page that failed to load is the second surface here. `load-error-watch.ts` follows each tab's
main-frame loads and asks for the sheet through the tab's slot queue ([`../overlays/tab-slots.ts`](../overlays/tab-slots.ts)),
`load-error-text.ts` is its fixed table per network error, `load-error-overlay.ts` declares it and runs Try again,
and `install-load-errors.ts` wires the watcher to every tab. Its page is
[`../../renderer/overlay/load-error/`](../../renderer/overlay/load-error/).

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`, `tab-slots.ts`); [`../auth/`](../auth/) (`isCertError`, so a certificate failure is left to its own sheet); [`../privacy/`](../privacy/) (`upgradeTracker`, the failures HTTPS-only explains); [`../local-files/partition.ts`](../local-files/partition.ts) (`partitionAfterFileBlock`, a blocked file the tab is about to move with, which gets no sheet); [`../shell/`](../shell/)
(`window-registry.ts`, `tab-lifecycle.ts`, `tab-types.ts` and `shell-installers.ts`, types only).

**What it must never import.** The renderer, or a value from the rest of the shell: the shell lists this
feature (`signals/crashed.ts`, `overlays/overlays.ts`, `shell-installers.ts`), not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron only at the edge: the signal listens for `render-process-gone`,
`unresponsive` and `responsive`, the load-error watcher for `did-start-navigation` and `did-fail-load`, and the
card's Reload is `webContents.reload()`. The text table and the
record reading need nothing of it.

## Design notes

**The card belongs to the window's active tab and only appears for it.** A tab that crashes in the
background shows only the strip's warning icon; the card comes when the tab is activated, and a tab switch
closes it. So nothing opens over the page the person is reading, and a page that crashes in a loop only
ever bothers its own tab.

**Escape does nothing on the card.** The page has died, so there is nothing to return to, and closing the
card would leave a blank view. Reload and Close tab are the ways out, and the browser's own shortcuts keep
working while it is up.

**The buttons carry no tab id.** The page names one of three words; the tab is the one main named when it
showed the card.

**A dead view is painted in the shell's own surface colour**, so a dark theme does not show Electron's white
behind the card. Only a view on the default white is painted; the dashboard and the shell's own pages keep
theirs. The white comes back when the page loads again.
