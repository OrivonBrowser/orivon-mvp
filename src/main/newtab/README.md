# `src/main/newtab/`: what a profile chose about the new tab: its Featured row and its background

**What lives here.** `featured-state.ts` holds the choices as a plain value and the functions that change it: the app a
profile was given first (the newcomer pin), the entries the person unpinned and the ones they hid. `featured-store.ts`
keeps that value in `<userData>/new-tab.json` (memory only in a private session). The dashboard reads and changes it
through [`../ipc/newtab-ipc.ts`](../ipc/newtab-ipc.ts); the entries themselves and their order are data shipped with the
page, in [`../../renderer/newtab/featured/featured.json`](../../renderer/newtab/featured/featured.json).
`background-image.ts` says what file may become the background picture (five formats, told by their leading bytes by the reader's `sniffImageType`, up to 20 MB);
`background-store.ts` copies a chosen file into `<userData>/new-tab-background` and answers what the page draws given the
`appearance.newTabBackground` setting; `background-domain.ts` is what Settings may ask: to choose a picture (the file picker is handed in).

**What it depends on.** `node:fs`, [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts), and for the background [`../settings/settings-store.ts`](../settings/settings-store.ts) (types and the `appearance.newTabBackground` setting) [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts) (the domain's type) and [`../reader/reader-images.ts`](../reader/reader-images.ts) (`sniffImageType`, the one table of image signatures).

**What it must never import.** `electron` (as a value; `background-domain.ts` names `WebContents` as a type), [`../../renderer/`](../../renderer/).

**Owner stream.** `shell`.

**Electron dependence.** None: plain JSON and one file under the profile folder, and it would outlive a change of the engine. The file picker is opened by `../pages/start-internal-pages.ts`.

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

**The background copy exists only while the setting is `custom`.** The store removes the file on any change of `appearance.newTabBackground` to another
value, however it came (a choice, Reset, Reset all). Once the settings are read, `reconcile()` removes a copy a run left behind by ending between
writing it and saving the setting, unless the settings file could not be read: the setting then says nothing about what the person chose. It never
runs from the constructor, which comes before the settings are read. A `custom` setting with no usable copy behind it draws the Orivon picture, and
the Settings domain refuses to set `custom` without one. A private session is given the copy by `../launch/private-picture.ts`, asynchronously.

**Picture I/O is asynchronous and one job at a time.** A picture is up to 20 MB, so nothing reads or writes one on the main thread's time: installs and
removals queue behind each other (a removal asked for first never takes a picture installed after it), and the checked bytes are kept in memory
for the page. A picked file must be a plain file (a pipe would never answer, a pseudo-file reports no size): it is opened without
blocking and looked at through the open file, never by name first (the name can change between the look and the read), and never read past its reported size, which is capped.

**The page gets bytes, not an address.** `getBackground` on the new-tab bridge answers the kind and, for a custom picture, its bytes and
type; the page makes a `blob:` URL of them, which is why its Content-Security-Policy lists `blob:` for images. The alternatives, a path or a
second address on the shell scheme, would give a page a name to ask for; the bridge answers only the dashboard's own top frame, as every
command there does. Main tells each dashboard that asked, and has not left, when the picture changes, and the page asks again.
