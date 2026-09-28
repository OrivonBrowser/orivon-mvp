# `src/main/dev/`: inert, or compiled out of an ordinary build, or gated behind developer mode

**What lives here.** `dev-grant.ts`: the developer-only grant path (queue item 0.3), reachable
only from Node code already running inside this process (Playwright's
`ElectronApplication.evaluate()`), compiled out of an ordinary build unless
`ORIVON_ENABLE_DEV_GRANT=1` was set at build time. `eth-resolver.ts`: reads `orivon-ports`'
developer `.eth` names, served over plain http on loopback, into the resolver clauses and
secure-origin list [`../verifier/`](../verifier/) puts ahead of every other `.eth` name; empty
unless both `ORIVON_ETH_NAMES_FILE` and `ORIVON_DEV_ORIGINS=1` are set. `score-levels.ts`: reads
a developer-only override of the displayed Website level and Delivery level, per origin
(`ORIVON_SCORE_LEVELS_FILE`, empty unless `ORIVON_DEV_ORIGINS=1` too), for previewing Level 3/4
before a real provider or peer-to-peer fetching exist (`ADR-0006`, `ADR-0037`) -- one file for
both axes, gated and shaped exactly like `eth-resolver.ts`, and, unlike `dev-grant.ts`, never
compiled out: it grants nothing on its own and reads no more of the environment than developer
mode already exposes. `local-ddoc.ts`: in developer mode, whether a local origin (loopback, or a
developer `.eth` name) serves a readable DDOC hash tree, which `../browsing/site-trust.ts` then
shows as DDOC named as developer mode (`ADR-0029`), since no domain record could anchor a local
address's tree; it fetches only the origin's own `/.well-known/orivon-ddoc.json`, through
Electron's `net.fetch`, capped, no redirects, and at most once per two seconds per origin, since
the shell asks on every state push. `dev-mode.ts`: the one reader of
`ORIVON_DEV_ORIGINS=1`, which the `.eth` names, score-level overrides and local DDOC above,
granting a loopback or dev-`.eth` origin without installing
([`../install/grant-without-install.ts`](../install/grant-without-install.ts)) and the shell's
Inspect Element share. A loopback origin is granted without installing in every build, with no
developer mode.

**What it depends on.** `node:fs`, `electron` (`local-ddoc.ts`'s `net.fetch`, imported lazily),
[`../../contracts/`](../../contracts/), [`../../loader/`](../../loader/) (`ddoc-declaration.ts`'s
parser), [`../install/`](../install/) (`grantableWithoutInstall`, which defines "local"),
[`../browsing/`](../browsing/) (`favicon.ts`'s `readCapped`),
[`../../broker/`](../../broker/) (`broker-contracts.ts`, `policy/origin.ts`'s `originFromUrl`),
[`../../trust/`](../../trust/) (`ScoreLevel`, `DeliveryLevel` types), the top-level `registry.ts`.

**What it must never import.** Nothing here may have a caller-chosen effect reachable from
`window.orivon`, IPC, or any other renderer-reachable surface. `dev-grant.ts`'s own header names
the boundary that protects this, and its test suite exercises it directly; `score-levels.ts`'s
answer only changes what `../browsing/site-trust.ts` reports back out for a level a caller cannot
otherwise choose, never something a renderer-reachable caller drives directly. `local-ddoc.ts` is
the same: the shell's own Web3 Score query names an origin, and the only effect is one capped GET
of that local origin's well-known path, which a page cannot aim anywhere else.

**Owner stream.** `broker`/`loader` (dev-only tooling threaded through both). Maintenance only.
