# `src/loader/manifest/`: parsing and validating the manifest

**What lives here.** `manifest.ts` (parses and validates `/.well-known/orivon.json`) and
`capabilities.ts` (validates the `capabilities` sub-tree), `domain.ts` (the `domain` host grammar) and
`embed.ts` (`capabilities.web.embed`, split out of it under Rule 2).

**What it depends on.** [`../../contracts/`](../../contracts/) and
[`../ddoc-declaration.ts`](../ddoc-declaration.ts) (the DDOC path constant `manifest.ts` reads).

**What it must never import.** [`../../shim/`](../../shim/), as the parent README says.

## Design notes

**An unknown top-level manifest field is ignored; an unknown field inside `capabilities` is
refused.** A top-level field grants nothing (`$schema`, `icons`, a field a later Orivon adds),
and the pinned manifest is parsed again at every start, so refusing one would lock out an app
another Orivon version installed; its name goes to `ignoredFields`, which `../fetch/bundle.ts`
logs. Every `capabilities` field asks for authority, and silently dropping one would install an
app that fails untraceably. `scripts/check-manifest-parity.mjs` fails when the contract's and
the loader's key lists disagree.
