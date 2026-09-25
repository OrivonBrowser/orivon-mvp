# `src/loader/manifest/`: parsing and validating the manifest

**What lives here.** `manifest.ts` (parses and validates `/.well-known/orivon.json`) and
`capabilities.ts` (validates the `capabilities` sub-tree).

**What it depends on.** [`../../contracts/`](../../contracts/) and
[`../ddoc-declaration.ts`](../ddoc-declaration.ts) (the DDOC path constant `manifest.ts` reads).

**What it must never import.** [`../../shim/`](../../shim/) -- see the parent README's "What it
must never import".

**Owner stream.** `loader`, build step 4.

## Design notes

**An unknown top-level manifest field is ignored; an unknown field inside `capabilities` is
refused.** [`manifest.ts`](manifest.ts) leaves a top-level field it does not know out of the
parsed manifest and returns its name in `ignoredFields`, which `../fetch/bundle.ts` logs as a
warning. Refusing it would fail the install for a field that grants nothing (`$schema`,
`description`, `icons`, or a field a later Orivon adds), and since the pinned manifest is parsed
again at every start, a field some other Orivon version accepted at install would lock the
installed app out. Inside
`capabilities` every field asks for authority, so an unknown one there still rejects the
manifest: silently dropping a permission the app asked for would install an app that then
fails in ways nobody can trace. `orivonApiVersion` must still be exactly `0`.
`scripts/check-manifest-parity.mjs` is what keeps a contract field from being ignored by
mistake: it fails when the contract and the loader's key lists disagree in either direction.
