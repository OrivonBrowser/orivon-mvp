# `scripts/app-behaviours/`

The guards behind [`test/app-behaviours/`](../../test/app-behaviours/README.md). Each is an exported pure
function over a root directory with a CLI block, unit tested in `tests/` against temp fixtures; they import
`node:*` and nothing from `src/`, so the change they catch cannot switch them off.

| Script | Enforces |
|---|---|
| `check-app-behaviours.mjs` | Every row of [`catalogue.md`](../../test/app-behaviours/catalogue.md) names an e2e spec that CI runs, and that spec has a test titled `[app:<id>]` as a plain string, with no skip, narrowing or interpolation. A spec gated on the ordinary build must be run by the `e2e-ordinary` job. No spec names an id the catalogue lacks. Every capability kind in `src/contracts/manifest.ts` has a line under **Capability coverage**. With `--base <ref>` (the pull-request step) a rewritten, removed or downgraded row needs a line under *Changed for apps* in `CHANGELOG.md` |
| `check-contracts-surface.mjs` | `test/app-behaviours/contracts-surface.txt` is `src/contracts/` without its comments. `--update` rewrites it; `--base <ref>` fails a changed file section with no line naming `` `contracts/<file>` `` under *Changed for apps* |

`npm run check:app-behaviours` and `npm run check:contracts-surface` run them; CI runs both in the `check` job,
and the `--base` forms on pull requests only.
