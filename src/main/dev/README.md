# `src/main/dev/`: inert or compiled out of an ordinary build

**What lives here.** `dev-grant.ts`: the developer-only grant path (queue item 0.3), reachable
only from Node code already running inside this process (Playwright's
`ElectronApplication.evaluate()`), compiled out of an ordinary build unless
`ORIVON_ENABLE_DEV_GRANT=1` was set at build time. `eth-resolver.ts`: reads `orivon-ports`'
developer `.eth` names, served over plain http on loopback, into the resolver clauses and
secure-origin list [`../verifier/`](../verifier/) puts ahead of every other `.eth` name; empty
unless both `ORIVON_ETH_NAMES_FILE` and `ORIVON_DEV_ORIGINS=1` are set. `dev-mode.ts`: the one
reader of `ORIVON_DEV_ORIGINS=1`, which the `.eth` names above, granting them without installing
([`../install/grant-without-install.ts`](../install/grant-without-install.ts)) and the shell's
Inspect Element share. A loopback origin is granted without installing in every build, with no
developer mode.

**What it depends on.** `node:fs`, [`../../contracts/`](../../contracts/),
[`../../broker/`](../../broker/) (`broker-contracts.ts` type), the top-level `registry.ts`.

**What it must never import.** Nothing here may be reachable from `window.orivon`, IPC, or any
other renderer-reachable surface — `dev-grant.ts`'s own header names the boundary that protects
this, and its test suite exercises it directly.

**Owner stream.** `broker`/`loader` (dev-only tooling threaded through both). Maintenance only.
