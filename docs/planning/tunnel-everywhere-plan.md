# The tunnel for every site, and for the whole browser: plan

**Need.** The owner decided that the tunnel (ADR-0080, `per-app-route-plan.md`) must work for every
website, not only for installed apps, and that a person can also turn it on for the whole browser.
With the whole browser on, a person can still turn it off for one site or app. A site whose tunnel
setting differs from the rest of the browser gets storage of its own, which is kept, and the person
is told so before it happens.

**What exists.**
- A route per installed app (`src/broker/route/`, `src/main/route/`), keyed by origin, with:
  - a loopback front per routed session;
  - per-origin isolation credentials;
  - the leaving question.
- The Nym tunnel (`nym-tunnel-plan.md`) becomes the default far end. This plan does not depend on
  it.
- `app.setProxy` (Electron 44) sets the proxy for requests made with no session: `net` in a utility
  process (the verifier host) and the runtime's own requests.

## The rule

Every origin has a tunnel state: **on** or **off**.

- **The browser's default** is `network.tunnel.everywhere`, off unless the person turns it on.
- **A per-origin entry** (`on` or `off`) overrides the default for that site or app. With no entry,
  the origin follows the default.
- **Storage:** a website whose state differs from the default gets a persistent session of its own,
  `persist:site-<sha256(origin)>`, kept across restarts. Every other website stays in the shared
  session. An installed app already has its own session, so its storage never moves.
- **Before a website first moves** into its own storage, the person is told in plain words: "This
  site gets its own storage. You will sign in to it again once, and what it stores stays apart from
  the rest of your browsing." They confirm, or cancel. Setting it back to follow the default
  returns it to the shared session. Its own storage is kept until the person removes it from the
  site's row in Settings (*provisional*: settled by the owner's first use).
- **The origin is the unit,** as for permissions and installed apps (*provisional*: a site spread
  over several subdomains needs one switch per origin).

## Design

### The route store, generalised (`src/main/route/route-store.ts` and its callers)

- An entry holds `on` or `off` for any web origin, installed or not.
  - `routeFor(key)` answers from the entry, else from `everywhere`.
  - Its read checks, atomic writes and fail-closed reading stay. An unreadable file with a tunnel
    configured means every origin is on.
- The app card's switch, the site-info switch and the Settings list all write through the one
  switch path (`route-switch.ts`).

### A site in its own storage (`src/main/shell/tab-partition.ts`, `src/main/route/`)

- `partitionForTarget` returns `persist:site-<hash>` for a website whose state differs from the
  default. That session gets the same preparation an app's session gets:
  - a front (its state is on) or nothing (its state is off while everywhere is on);
  - the WebRTC policy;
  - icons and Web3 Score through it.
- A tab moving between the shared session and a site's own session uses the existing cross-session
  move (`repartitionView`, as Back across sessions does).
- Subresources and frames of other origins inside that tab ride its session, so they follow its
  state.
- **The leaving question** applies to a website in its own tunnelled session exactly as to a routed
  app. With everywhere on, leaving for an origin that is also on asks nothing.

### The whole browser (`network.tunnel.everywhere`)

When it is on, nothing Orivon sends leaves this computer except through the tunnel, unless it goes
to an origin the person set to off. Each part:

- **Sessions.**
  - The shared session (`defaultSession`) gets a front of its own: one tunnel identity shared by
    every website that follows the default. A site or app with its own setting has its own
    identity.
  - Every other session the browser makes (extensions included) is pointed at a front or refused.
  - Every web contents gets `disable_non_proxied_udp`.
  - DNS prefetching is off for the whole browser, from the first PR (`blink-settings`
    `dnsPrefetchingEnabled=false`, set before `ready`). A page's `<link rel="dns-prefetch">` otherwise resolves its
    name on this computer through the proxy.
- **Requests with no session.** `app.setProxy` points them at the shared front. The verifier host's requests
  (gateways, Helios RPC, CCIP-Read) then ride it, as Step 0 measured:
  - The host fetches with `net.request` and a `login` listener that answers the front's secret, which main sends it
    when it starts. It does not use `net.fetch`: the front's `407` is never answered for a utility process's
    `net.fetch`.
  - Its direct routes (the pinned dial T31 and T40 describe, the DNS-over-HTTPS fallback) already stand down when a
    proxy applies. They read `app.resolveProxy`, which `app.setProxy` flips, so main need not report a proxy.
    Those answers are snapshots taken when the host starts (`unproxiedGateways`, `ccipDirect`), so turning
    "everywhere" on or off restarts the verifier host.
- **The broker.** `routeFor(key)` returns a route for every origin that is on, each with its own
  isolation credentials. `reach.ts` follows it.
- **Orivon's own requests:** self-update, telemetry and bug reports, Web3 Score, tab icons,
  extension updates, and `fetch-local-nodes` at run time if any. Each goes through the tunnel, or
  does not happen while everywhere is on, and says why. List each in the PR with what it does.
- **The local IPFS and Swarm nodes.** Their `node-net.ts` dials through the route provider (TCP by
  name, UDP through UDP ASSOCIATE), and their listens stay on loopback. A node that cannot work this
  way is off while everywhere is on, with its reason. IPFS then reads through gateways over the
  tunnel.
- **What stays direct:**
  - loopback;
  - the tunnel's own way in: the Nym host's connections to Nym's gateways, or the connection to the
    person's own SOCKS5 address;
  - origins set to off.
- **T20** is not asked for a routed origin (as now). For an origin set to off while everywhere is
  on, T20 is asked as it is today.

### Keeping it whole: an egress guard

A new `check:egress`, with a test and a CI step like the other guards:
- every file in `src/` that imports `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`
  or `node:dns`, the broker's socket adapters or `socks`, or calls `net.request`, `net.fetch`, `setProxy`, a
  session's `fetch`, `globalThis.fetch` or the global `fetch` (unless it declares its own), is listed in one table
  (`docs/architecture/egress.md`);
- each entry says how that path takes the tunnel, or why it never leaves the computer;
- a file that is not listed fails CI.

This is how a later change cannot add a path around the tunnel unnoticed.

### UI

- **Settings, Tunnel section.** It has, in order:
  - the far end (Nym or the person's own address, from the Nym plan);
  - "Send all of Orivon's traffic through the tunnel";
  - a list of the sites and apps with their own setting. Each row shows on or off, and offers
    "Remove its separate storage" where it has some.
- **The site-info popover of every site:**
  - "Use the tunnel for this site", with the default it follows when it has no entry;
  - the storage notice on the first move;
  - the status line ("goes through your tunnel", "Your tunnel is not answering").
- **The site-info button** shows when a tab's traffic goes through the tunnel, so it is visible
  without opening the popover.
- **The app card's switch** stays, and gains the same on/off/default semantics.

## Step 0: prove the browser-wide paths, before building the rest

Through `node scripts/run-headless.mjs`, with a scratch profile and the fixture SOCKS5 server:

1. With `app.setProxy` pointed at a front, the verifier host's requests reach the front, and its direct routes stand
   down.
2. With `defaultSession` pointed at a front:
   - an extension's background page or service worker reaches the front;
   - a page's service worker reaches the front;
   - no name is resolved locally (DNS prefetch included).
3. A site moved into `persist:site-<hash>` keeps its cookies there across a restart, and its
   cookies in the shared session are untouched.

**If 1 or 2 fails, stop and report.**

### Results (Electron 44, measured)

1. **`app.setProxy`.**
   - A utility process's `net.fetch` reaches the front and gets its `407`: the application's `login` event is not
     raised for it. A `net.request` in the utility process with a `login` listener passes, and the fixture sees the
     name. The verifier host therefore fetches with `net.request`.
   - `app.resolveProxy` answers `PROXY 127.0.0.1:<port>` after `app.setProxy` and `DIRECT` again after
     `mode: 'direct'`; `defaultSession.resolveProxy` is unchanged by it. The verifier's checks read the first
     (`verifier-subsystem.ts`), once when the host starts.
2. **`defaultSession`.**
   - An MV3 extension service worker, an MV2 background page, a page's service worker and a page's subresources
     reach the front. A first request from an extension's service worker raises the application's `login` with
     `webContents` null, which the app-level handler answers, so one handler covers extensions and workers.
   - A page's `<link rel="dns-prefetch">` still made a lookup on this computer (the net log shows a speculative
     resolver job). With `--blink-settings=dnsPrefetchingEnabled=false` the log shows none, and everything still
     arrives through the front. `rel="preconnect"` made no lookup either way.
3. **Own storage.** Cookies set by HTTP and by script in `persist:site-<sha256(origin)>` survive a full restart, and the
   shared session's cookies for the same site stay separate and unchanged.

## Tests

- **Unit, written first:**
  - the state rule (entry over default);
  - the partition choice;
  - the store's read checks with website origins;
  - the egress guard.
- **End to end, reusing the SOCKS5 fixture:**
  - **A plain website switched on:** the notice appears; after confirming, the page and a
    subresource from another host arrive through the fixture; switched back, it is in the shared
    session again.
  - **Everywhere on:** each of these arrives through the fixture:
    - a website;
    - a WebSocket;
    - an app's `orivon.net` call;
    - a tab icon;
    - a Web3 Score lookup;
    - a verifier-host gateway fetch.

    A site set to off arrives direct, from its own storage.
  - **With the fixture stopped:** everything fails and nothing arrives direct.
- **Catalogue rows** for the app-facing changes, and `CHANGELOG.md` lines.

## Docs

- An ADR (the next free number): the tunnel's state per origin with a browser-wide default, and
  storage of its own for a website that differs from it.
- `security-model.md` T84 widened, and the egress table cited from it.
- `docs/features.md`. `docs/roadmap.md`: "Tor and proxy chains" under Later becomes "Proxy chains".
- The compatibility matrix.

## PRs

1. **`stream/tunnel-egress`:** Step 0, `docs/architecture/egress.md` and `check:egress`, with every
   path that exists today listed, and DNS prefetching off for the whole browser (it also closes the per-app tunnel's
   leak for a routed app's page). No other behaviour change.
2. **`stream/tunnel-websites`:** the store generalised, a site's own storage, the popover switch,
   the notice, and the leaving question for websites.
3. **`stream/tunnel-everywhere`:** the browser-wide setting and every path in section The whole
   browser.

The Nym PRs (`nym-tunnel-plan.md`) run beside these. Where both touch the Settings tunnel section
or `src/main/route/`, the one that merges later merges `main` in first. Each PR gets
`typecheck`, `test:changed`, the guards, the specs `select-e2e.mjs` names, `/code-review` and
`/security-review`, and the QA `orivon-qa` names for UI and boundary changes. After the third:
`adversarial-reviewer` on the route, the partitions and the egress table.

## Not in this step

- Proxy chains (one tunnel behind another).
- A per-tab choice that ignores the site's setting.
- Isolation finer than the origin inside the shared tunnelled session (every site that follows the
  default shares one identity there).
