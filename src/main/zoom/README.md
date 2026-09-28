# `src/main/zoom/`: how large each site is shown

**What lives here.** The zoom level a page has, and carrying it out. `zoom-steps.ts` is the list of
levels a person steps through. `zoom-store.ts` keeps the level chosen for each site in
`<userData>/zoom.json`, `zoom-service.ts` answers "what level does this page have" (its site's, else
the default set in Settings) and takes the steps, and `attach-zoom.ts` and `install-zoom.ts` apply
that level to every tab.

**What it depends on.** `electron` (`attach-zoom.ts` and `install-zoom.ts`);
[`../settings/`](../settings/) (the default level); [`../storage/`](../storage/) (the debounced
write); [`../../broker/policy/origin.ts`](../../broker/policy/origin.ts) (the origin a level is kept
under); [`../shell/window-registry.ts`](../shell/window-registry.ts) (type only, to tell a tab from the
chrome).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or
[`../shell/tab-view.ts`](../shell/tab-view.ts): the shell asks zoom for a level, and zoom finds tabs
through the window registry.

**Owner stream.** `shell`.

**Electron dependence.** `zoom-steps.ts`, `zoom-store.ts` and `zoom-service.ts` do not depend on
Electron and would outlive a change of the engine beneath it. Applying a level to a page
(`attach-zoom.ts`) is tied to it.

## Design notes

**A level belongs to a site, not to a tab.** It is kept under the page's origin, so a website, a `.eth`
name and an app behave alike, and a second tab on the same site shows the same size. The origin is
that of the address serving the page, so a level survives the app moving between the shared session
and its own.

**Only a choice is stored.** A site at the default holds no entry, and follows the default when it
changes; choosing the default level again removes the entry. The file holds at most 2000 sites, the
oldest choice dropped first.

**Tabs use manual zoom.** With Electron's default mode a mouse-wheel gesture reports a step and
nothing more, and other modes apply their own change on top of ours. In manual mode the report is
the only effect, so one step in the wheel is one step in the list.

**One turn of the wheel is one step.** Electron reports a turn as two `zoom-changed` events a fraction of a
millisecond apart (measured), so two in the same direction within 12 ms are taken as one; a wheel cannot turn
faster than that, so no real step is lost.

**A page with no origin is not zoomed.** The new-tab page and the shell's own pages have none, so
they are always shown at normal size and a default larger than 100% does not enlarge them.
