# `src/renderer/pages/settings/controls/`: controls too large for a row

**What lives here.** The Settings controls that a plain text, switch or choice row cannot be. Today one:
`page-list.ts` is the "Pages to open" list (each address removable, a field that adds one, a button that takes the
pages open now), with `page-list-model.ts` holding its decisions and `page-list.css` its look. `host-list.ts` is the same
shape for sites, with a `ListModel` that says how a line is read, added and shown; `endpoint-list.ts` is the same list for
the Ethereum servers the person names (its model, `endpoint-list-model.ts`, shows each saved address masked and refuses one
with the reason `server-address.ts` gives). `power-badge.ts` is the badge that says whether the computer is on battery.

**Tied to Electron, entirely.** A sandboxed page; it reaches main only through the internal bridge.

**What it depends on.** `../model.ts` (the `Control` union), `../state.ts`, and [`../../shared/`](../../shared/). `endpoint-list-model.ts` reads two pure files of the verifier host, [`server-address.ts`](../../../../protocols/verifier-host/light-client/server-address.ts) and [`endpoint-mask.ts`](../../../../protocols/verifier-host/light-client/endpoint-mask.ts), so the page and the store apply one rule and one mask.

**What it must never import.** `electron`, or a value from [`../../../../main/`](../../../../main/).

**Owner stream.** `shell`.

## Design notes

**The control saves the whole list on every change** and draws from what it was given, so a failed save keeps what
was typed and says so. The addresses are validated in main with the address bar's own rule, because a
single-line text row would drop the line breaks the setting is stored with.
