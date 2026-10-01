# `src/renderer/pages/settings/site-data/`: the "Sites that store data" rows

**What lives here.** `site-data-model.ts` holds the decisions (the search, the two orders, how many rows show, the words
a row and the total are told in), `site-data-part.ts` the state (what main listed, what is typed, which sites are
open, which button waits for its second click) and `site-data-view.ts` the DOM. `site-data.css` is the look. The
rows themselves are in [`../sections/privacy-site-data.ts`](../sections/privacy-site-data.ts).

**Tied to Electron, entirely.** A sandboxed page; it reaches main only through the internal bridge.

**What it depends on.** `../model.ts`, `../settings-parts.ts`, `../state.ts`, [`../../shared/`](../../shared/) (the
cookie row and its words are shared with the site-info popover) and `../passwords/passwords-model.ts` for a site's mark.

**What it must never import.** `electron`, or a value from [`../../../../main/`](../../../../main/).

**Owner stream.** `shell`.

## Design notes

**The list is read without holding the page up.** `load()` returns at once; the section shows grey rows until main has
walked the storage folders (up to two seconds) and the total fills in after the list.

**The control is one element kept across redraws**, like the Passwords list, so the search text and the keyboard survive a
change made elsewhere on the page.

**Delete all site data is Clear browsing data with only "Cookies and other site data" chosen**, so the two cannot
disagree about what site data is.
