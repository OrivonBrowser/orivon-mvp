# `src/main/newtab/`: what a profile chose and did on the new tab: its Featured row, the Start here card and the apps it used last

**What lives here.** `featured-state.ts` holds the choices as a plain value and the functions that change it: the app a
profile was given first (the newcomer pin), the entries the person unpinned and the ones they hid. `featured-store.ts`
keeps that value in `<userData>/new-tab.json` (memory only in a private session). The dashboard reads and changes it
through [`../ipc/newtab-ipc.ts`](../ipc/newtab-ipc.ts); the entries themselves and their order are data shipped with the
page, in [`../../renderer/newtab/featured/featured.json`](../../renderer/newtab/featured/featured.json).

`start-here-state.ts` is the "Start here" card as pure functions: which of its three steps are ticked, whether it was closed,
and `startHereView`, which says what the card shows (or null). The ticks and the closing live in the same value and file as
the Featured choices. `start-here-facts.ts` reads what the card also depends on (the first-run app, whether another
browser's profile can be imported, whether uBlock Origin is on) from sources handed to it. Nothing here sees a tab: the steps
are ticked from [`../shell/install-start-here.ts`](../shell/install-start-here.ts) (an app opening, a `.eth` page loading) and
from [`../import/import-host.ts`](../import/import-host.ts) (an import ending).

The Your apps row is `your-apps.ts` (the ordering, which is pure, and the service that joins it to the broker's granted
apps and notes which one is in front) over `app-use-state.ts` and `app-use-store.ts`, which keep when each granted app was
last in front in `<userData>/app-use.json` (memory only in a private session). The shell window calls `noteInFront` on
every state push; the dashboard reads the row through [`../ipc/newtab-ipc.ts`](../ipc/newtab-ipc.ts).

**What it depends on.** `node:fs`, [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts), [`../../broker/policy/origin.ts`](../../broker/policy/origin.ts), [`../browsing/bookmark-file.ts`](../browsing/bookmark-file.ts) (`sanitizeStoredFavicon`, so a stored icon passes the check a bookmark's does). `start-here-facts.ts` takes its sources as arguments and imports nothing else.

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

**The card leaves for good, and says nothing it cannot see.** `startHereView` returns null in a private session, once the card
was closed (Dismiss, or every shown step done: the page's request for the card records that) and when nothing is left to do.
A step is ticked only by something the browser observed: an app tab or a page of an origin holding a grant finishing a load
(`../os/app-open-watch.ts`, the signal the default-browser question uses), a `https://<name>.eth/` page finishing a load, an
import that ended without an error. The import step is shown only while another browser's profile is found, but a card all of
whose shown steps are done is closed, so a browser found later does not bring it back. A profile that already existed when the
card shipped is not told apart from a new one: it sees the card until it is dismissed or done.

**An app is an origin that holds a grant, and only those are ever noted.** `noteInFront` records a page's origin only when
the broker says it holds a grant, so `app-use.json` cannot become a list of the sites a person visited, and nothing is
read from history, which the person can switch off, or from the usage report, which is opt-in. The list itself comes from
the same grant list Settings shows (`PermissionsController.list`, a row for at least one capability), so an app listed
here is one Settings lets the person manage. An app never used follows the used ones, by name.

**The newest app is noted once a minute, an older one at once.** A tab in front pushes its state many times a second,
so the app already newest is not written again for a minute; coming back to an older app changes the order and is
written at once. The file holds at most 32 origins and one icon each, and "Clear browsing data" forgets the uses from
the time history is cleared back to.

**A private window shows the row only when it holds grants of its own.** The answer carries `isPrivate`; the page leaves
the row out when that is set and no app is listed. A private session has its own broker, so nothing from the profile's
grants reaches it.
