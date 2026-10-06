# `src/main/dev/`: inert, or compiled out of an ordinary build, or gated behind developer mode

**What lives here.** Tooling for tests and developers. Each file's header says what it does and
why it is safe; this table is what turns each one on.

| File | What it does | Gate |
|---|---|---|
| `dev-grant.ts` | Grants a capability from Node code already in the process (Playwright's `evaluate()`) | Compiled out unless `ORIVON_ENABLE_DEV_GRANT=1` at build time |
| `dev-display-chooser.ts` | Stands in for the screen-share picker: a spec binds it to pick the first screen, a tab by address or nothing, and reads back what the gate asked | Compiled out unless `ORIVON_ENABLE_DEV_GRANT=1` at build time |
| `dev-mode.ts` | The one reader of developer mode | `ORIVON_DEV_ORIGINS=1`, set only by `scripts/dev.mjs` |
| `eth-resolver.ts` | orivon-ports' developer `.eth` names (one or more labels, so `thelounge.orivonstack.eth` counts; the pattern is shared with `../install/grant-without-install.ts`), for [`../verifier/`](../verifier/)'s resolver rules | Developer mode and `ORIVON_ETH_NAMES_FILE` |
| `score-levels.ts` | Overrides the displayed Website and Delivery level per origin ([`ADR-0037`](../../../docs/decisions/ADR-0037-a-level-4-site-s-grants-are-shown-without-warnings.md)) | Developer mode and `ORIVON_SCORE_LEVELS_FILE` |
| `local-ddoc.ts` | Whether a local origin serves a DDOC hash tree ([`ADR-0029`](../../../docs/decisions/ADR-0029-sites-publish-their-bundle-hash-tree.md)) | Developer mode |

Developer mode also lets a developer `.eth` origin be granted without installing
([`../install/grant-without-install.ts`](../install/grant-without-install.ts)); a loopback origin
needs no developer mode for that.

**Tied to Electron.** `local-ddoc.ts` only, importing `net` lazily.

**What it depends on.** `node:fs`, `electron` (`local-ddoc.ts`; a type in `dev-display-chooser.ts`),
[`../display-capture/`](../display-capture/) (`dev-display-chooser.ts`: the chooser binding and the choice types),
[`../../contracts/`](../../contracts/),
[`../../loader/ddoc-declaration.ts`](../../loader/ddoc-declaration.ts),
[`../install/grant-without-install.ts`](../install/grant-without-install.ts),
[`../browsing/favicon.ts`](../browsing/favicon.ts)'s `readCapped`,
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/origin.ts`),
[`../../trust/`](../../trust/) (types), the top-level `registry.ts`.

**What it must never import.** Nothing here may have a caller-chosen effect reachable from
`window.orivon`, IPC, or any other renderer-reachable surface. An override only changes what
`../browsing/site-trust.ts` reports; `local-ddoc.ts`'s only effect is one capped GET of a local
origin's own well-known path.

**Owner stream.** `broker`/`loader`. Maintenance only.
