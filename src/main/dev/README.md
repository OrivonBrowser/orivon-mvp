# `src/main/dev/`: inert or compiled out of an ordinary build

**What lives here.** `dev-grant.ts`: the developer-only grant path (queue item 0.3), reachable
only from Node code already running inside this process (Playwright's
`ElectronApplication.evaluate()`), compiled out of an ordinary build unless
`ORIVON_ENABLE_DEV_GRANT=1` was set at build time. `dev-app-origin.ts`: developer mode's half of
the discovery trigger — a loopback origin gets its capabilities granted without being installed;
no bundle is fetched, hashed, pinned or served from cache. `dev-csp.ts`: gives a dev-granted
origin's documents the Content-Security-Policy an installed app is served with. `eth-resolver.ts`: developer-mode DNS
override for `orivon-ports`' fake `.eth` names, inert unless both `ORIVON_ETH_NAMES_FILE` and
`ORIVON_DEV_ORIGINS=1` are set.

**What it depends on.** `electron` (`eth-resolver.ts` and `dev-csp.ts` only), `node:fs`,
[`../../contracts/`](../../contracts/), [`../../broker/`](../../broker/) (`broker-contracts.ts`
type, `policy/update.ts`, `policy/manifest-patterns.ts`, `grants/origin-hash.ts`),
[`../../loader/manifest.ts`](../../loader/manifest.ts),
[`../../loader/electron-serve.ts`](../../loader/electron-serve.ts) (`liveCspHeaderFor`),
[`../consent/install-consent.ts`](../consent/install-consent.ts), the top-level `registry.ts`.

**What it must never import.** Nothing here may be reachable from `window.orivon`, IPC, or any
other renderer-reachable surface — `dev-grant.ts`'s own header names the boundary that protects
this, and its test suite exercises it directly.

**Owner stream.** `broker`/`loader` (dev-only tooling threaded through both). Maintenance only.

## Design notes

**[`dev-csp.ts`](dev-csp.ts): why a dev origin gets the installed CSP at all.** A port that runs
cleanly on its dev server and breaks once installed is a port that was never tested against the
environment it ships into; the installed path's CSP is the difference most likely to cause that.
So a dev-granted origin's documents carry the policy `../../loader/serve-csp.ts` builds, from the
same live grants, read per response. It is added through
`session.webRequest.onHeadersReceived` on the origin's own app partition, because a dev origin is
served by its own server rather than through `protocol.handle` (A110 concerns only the latter).

- **Documents only** (`mainFrame`, `subFrame`) from that exact origin. A worker script from the
  dev server carries no added policy, which makes a dev worker more permissive than an installed
  one, never less.
- **Appended, never replacing.** The dev server's own CSP stays in the response beside it. The
  browser enforces every policy it receives, so a port is held to both.
- **One listener per session.** Electron keeps one `onHeadersReceived` listener per session;
  nothing else in `src/` listens on an app partition, and installing again for the same origin
  replaces the listener rather than stacking a second one.
