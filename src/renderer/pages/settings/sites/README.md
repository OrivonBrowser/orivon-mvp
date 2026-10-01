# `src/renderer/pages/settings/sites/`: the Site settings section's list of sites and its state

**What lives here.** `sites-model.ts` holds the decisions (the search, the badges that summarise a site, how many rows
show), `sites-part.ts` the state (what main listed, which sites are open to their own rows, what is typed, which button
waits for its second click), `sites-view.ts` the DOM and `sites-copy.ts` the help lines and search terms of the default
rows. `sites.css` is the look. The section's rows are made in [`../sections/sites.ts`](../sections/sites.ts) from the
kinds main lists, so a kind that becomes available appears without a change here.

**Tied to Electron, entirely.** A sandboxed page; it reaches main only through the internal bridge.

**What it depends on.** `../model.ts`, `../settings-parts.ts`, `../state.ts`, [`../passwords/passwords-model.ts`](../passwords/passwords-model.ts)
(the name and mark of a site) and [`../../shared/`](../../shared/).

**What it must never import.** `electron`, or a value from [`../../../../main/`](../../../../main/).

**Owner stream.** `shell`.

## Design notes

**State never touches the DOM and the view never calls the bridge**, as in the Passwords list beside it.

**The list is one element kept across redraws**, so the search text and the keyboard survive a change made elsewhere: a
prompt answered in a tab pushes `sites.changed`, and the open rows are read again, not closed.

**Labels come from main.** The kind's name and the words of each choice, "(default)" included, are main's; this side adds
only the help line and search terms, with a line made from the label for a kind it has no entry for.
