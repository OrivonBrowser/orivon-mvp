# `src/main/dev/`: inert or compiled out of an ordinary build

**What lives here.** `dev-grant.ts`: the developer-only grant path (queue item 0.3), reachable
only from Node code already running inside this process (Playwright's
`ElectronApplication.evaluate()`), compiled out of an ordinary build unless
`ORIVON_ENABLE_DEV_GRANT=1` was set at build time. `dev-app-origin.ts`: developer mode's half of
the discovery trigger — a loopback origin gets its capabilities granted without being installed;
no bundle is fetched, hashed, pinned or served from cache. `eth-resolver.ts`: developer-mode DNS
override for `orivon-ports`' fake `.eth` names, inert unless both `ORIVON_ETH_NAMES_FILE` and
`ORIVON_DEV_ORIGINS=1` are set.

**What it depends on.** `electron` (`eth-resolver.ts` only), `node:fs`,
[`../../contracts/`](../../contracts/), [`../../broker/`](../../broker/) (`broker-contracts.ts`
type, `policy/update.ts`, `policy/manifest-patterns.ts`), [`../../loader/manifest.ts`](../../loader/manifest.ts),
[`../consent/install-consent.ts`](../consent/install-consent.ts), the top-level `registry.ts`.

**What it must never import.** Nothing here may be reachable from `window.orivon`, IPC, or any
other renderer-reachable surface — `dev-grant.ts`'s own header names the boundary that protects
this, and its test suite exercises it directly.

**Owner stream.** `broker`/`loader` (dev-only tooling threaded through both). Maintenance only.
