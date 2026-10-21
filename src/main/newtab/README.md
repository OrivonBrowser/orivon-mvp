# `src/main/newtab/`: what a profile chose about the new tab: its Featured row

**What lives here.** `featured-state.ts` holds the choices as a plain value and the functions that change it: the app a
profile was given first (the newcomer pin), the entries the person unpinned and the ones they hid. `featured-store.ts`
keeps that value in `<userData>/new-tab.json` (memory only in a private session). The dashboard reads and changes it
through [`../ipc/newtab-ipc.ts`](../ipc/newtab-ipc.ts); the entries themselves and their order are data shipped with the
page, in [`../../renderer/newtab/featured/featured.json`](../../renderer/newtab/featured/featured.json).

**What it depends on.** `node:fs`, [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts).

**What it must never import.** `electron`, [`../../renderer/`](../../renderer/).

**Owner stream.** `shell`.

**Electron dependence.** None: plain JSON under the profile folder, and it would outlive a change of the engine.

## Design notes

**The newcomer pin is given once, and removing it is final.** `FeaturedStore.setNewcomerPin(appIdOrUrl)` takes an app's
id (the name label of its `.orivonstack.eth` address), that address, or any other `ipfs://` or `https://` address. The
first call on a profile puts that app first in the row, adding a tile when it is not among the shipped entries. Every
later call does nothing, whether the person kept the pin or unpinned or hid it, so a setter that runs on every start
cannot put back what the person took away. Nothing calls it yet but tests: the start that gives a new profile its
pin is a later change, and it calls the store of the services (`shell.featured`).

**The page decides the order, main keeps the choices.** The entries are bundled into the dashboard, so main never reads
them; it stores keys (an id, or an address that is not a shipped app's) and the page matches them. A key is the same
text on both sides because `appKey` normalises what a caller passes and the page's ids are the shipped slugs.
