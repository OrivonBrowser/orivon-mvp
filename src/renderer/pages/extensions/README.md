# `src/renderer/pages/extensions/`: the `orivon://extensions` page

**What lives here.** The page's renderer side: `main.ts` draws the header and the current view, `router.ts` turns an
address (`/`, `/details?id=`, `/shortcuts`) into a place and back, `state.ts` holds what main last sent,
and `types.ts` says what a view, a details section and a card badge are. `registry.ts` lists them, one line each:
`EXTENSION_VIEWS`, `DETAIL_SECTIONS` and `CARD_BADGES`. `views/` holds a view per route (the list, the details,
the shortcuts page) with its own stylesheet, and `sections/` the details sections that are not part of a view's file.
The main side is [`../../../main/extensions/`](../../../main/extensions/)'s `extensions-domain.ts`.

**Tied to Electron, entirely.** A sandboxed page; it reaches main only through the internal bridge.

**What it depends on.** [`../shared/`](../shared/) (the DOM helpers, the letter tile and the kit styles). The row and
details types in `state.ts` are a copy of the ones in main's `extensions-view.ts`, because a page imports types, never
values, from main; a change to one is made in both.

**What it must never import.** `electron`, `node:*`, or a value from [`../../../main/`](../../../main/).

**Owner stream.** `shell`.

## Design notes

**A feature adds a line, not a branch.** A details section, a card badge or a view is one entry in `registry.ts`, and
the main side adds what it shows through `DETAIL_PARTS` and `ROW_PARTS`, so a feature never edits the list or the
details view itself. The views are given their registries instead of importing them, which keeps the registry file free
of an import cycle.

**Every request is answered in main.** A page asks for a thing by name (`context`, `list`, `details`, `shortcuts.*`,
`revokePermission`) and main validates each field again; the page decides nothing about what an extension may do.

**A private window lists only the extensions allowed there, and changes none.** The page then draws a banner saying so,
the cards without the on/off switch and Remove, no install control and no "Private windows" card: those are done in a
normal window, and what a private window holds is a copy that nothing is saved back from.
