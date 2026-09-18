# `apps/freetube-real/`: upstream FreeTube, unmodified, as an Orivon app

**What lives here.** Three small files that turn a stock FreeTube web build into an Orivon app:
a manifest, a prepare step, and a plain static server. **No FreeTube source and no FreeTube build
output is in this repository** -- it is AGPL-3.0-or-later and it stays in its own clone.

**What this answers, that [`../freetube/`](../freetube/) cannot.** That directory is an app
written for Orivon. This one is somebody else's real application, built by its own toolchain,
with the manifest and the discovery hint added and **nothing else changed**. It measures how much
of a third-party app works when the only thing done for it is granting its URL the network.

## Setting it up

```bash
git clone --depth 1 https://github.com/FreeTubeApp/FreeTube.git ~/git/freetube-src
cd ~/git/freetube-src && pnpm install && pnpm run pack:web
cd -   # back to this repo
node apps/freetube-real/prepare.mjs
node apps/freetube-real/serve.mjs      # http://127.0.0.1:8875
```

Then `npm run dev` in another terminal, navigate to `http://127.0.0.1:8875`, and accept the
prompt. `prepare.mjs` copies the build, injects `<link rel="orivon-manifest">` into `index.html`
and drops [`orivon.json`](orivon.json) at `/.well-known/`. The server reads files off disk and
does nothing else.

## Two builds, because they answer different questions

| Build | What it is | Backend |
|---|---|---|
| `dist/orivon-web` | `pnpm run pack:web`, verbatim | **Invidious only** |
| `dist/orivon-web-localapi` | the same build with the Local API left in | YouTube directly, via `youtubei.js` |

**Upstream compiles the web target with `SUPPORTS_LOCAL_API: false` and `externals:
{'youtubei.js': '{}'}`** -- the Local API is stripped, because a browser cannot reach YouTube
directly: CORS refuses the origin and the request needs headers a page is forbidden to set. That
is the exact wall Orivon removes, so the second build asks what removing it buys. It is a
config-level change (`_scripts/webpack.web-localapi.config.js` in the clone, which requires
upstream's own config and flips two settings), not a fork.

Build it with:

```bash
cd ~/git/freetube-src && npx webpack --mode=production --config-node-env=production \
  --config _scripts/webpack.web-localapi.config.js
cd - && node apps/freetube-real/prepare.mjs --out ~/git/freetube-src/dist/orivon-web-localapi
node apps/freetube-real/serve.mjs --root ~/git/freetube-src/dist/orivon-web-localapi
```

## Opening a video works

Measured 2026-09-17, `dist/orivon-web-localapi`, against live YouTube:

```
url:   http://127.0.0.1:8875/#/watch/dQw4w9WgXcQ
title: Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) - FreeTube
page:  Published on 25 Oct 2009 - 1,816,738,329 views - 19,394,151 likes
       Rick Astley - Subscribe - 4.5m - full description
```

**That is upstream's own Local API code, calling YouTube's InnerTube through the routed fetch.**
It is the thing upstream compiles OUT of the web build because a browser cannot do it.

Getting there needed three fixes, and only the first was Orivon's:

1. **A routed-fetch bug** (`src/preload/fetch-route.ts`). It read the request URL as
   `typeof input === 'string' ? input : input.url`, which accepts a string and a `Request` but
   **rejects a `URL` object** -- and `youtubei.js` passes one. WHATWG fetch takes
   `Request | USVString` and converts anything that is not a Request with `ToString`, which is why
   `fetch(new URL(...))` works in every browser. Fixed to follow the spec. This was a real
   platform divergence, found only because a third-party library exercised the path.
2. **The n/sig evaluator.** FreeTube sets `Platform.shim.eval` in
   `src/renderer/helpers/api/local.js`, but its working half sits behind
   `if (process.env.IS_ELECTRON)`, which webpack folds to `false` for a web build and eliminates.
   `_scripts/orivon-sig-eval.js` in the clone re-implements exactly that branch.
3. **The `#sigFrame` iframe** it posts to, which `src/index.ejs` also renders only under
   `IS_ELECTRON`. [`prepare.mjs`](prepare.mjs) injects it, built from FreeTube's own
   `sigFrameConfig`, so the sandboxed script and its CSP hash are upstream's bytes.

Neither 2 nor 3 is an Orivon gap: both are upstream build decisions that follow from "the web
cannot reach YouTube", which is the premise Orivon removes.

### Playback: blocked on the PoToken, traced to the exact line

**Not blocked by Orivon.** Measured with an unminified build, the failure is three frames deep:

```
TypeError: Cannot read properties of undefined (reading 'replace')
  at base64ToU8        (googlevideo/dist/src/utils/shared.js)
  at setupSabrScheme   (src/renderer/helpers/player/SabrSchemePlugin.js)
  at setup             (src/renderer/components/ft-shaka-video-player/...)
```

YouTube now serves the Local API path over **SABR** (server-side ABR), and SABR requires a
proof-of-origin token. `Watch.js` takes the SABR branch whenever
`streaming_data.server_abr_streaming_url` exists, passing the `poToken` it was given.
`local.js` only ever produces one inside `if (process.env.IS_ELECTRON)`, by calling
`window.ftElectron.generatePoToken(...)` -- BotGuard, executed in FreeTube's main process. A web
build compiles that block out, so the token is `undefined`, `base64ToU8(undefined)` throws, and
the throw takes the whole player component's `setup()` with it. **That is why no `<video>`
element exists at all** -- the player never mounts, so only the thumbnail shows.

This is the same `GENERATE_PO_TOKEN` handler
[`freetube-port-recon.md`](../../docs/planning/freetube-port-recon.md) listed as *Unassessed*,
and it is now assessed twice over: it is load-bearing, and it is the single thing between this
build and working playback.

**Two routes to playback, neither started:**

1. **Generate the token in the page.** BotGuard is browser code; a browser is where it is
   *easiest* to run, and this one has a real DOM plus unrestricted fetch. This is the route that
   makes SABR work as upstream intends.
2. **Avoid SABR.** `Watch.js` has an `else if` branch for adaptive formats carrying a `url` or
   `signature_cipher`, which is the older DASH path, and n/sig deciphering already works here.
   Whether YouTube still serves those without a token is an open question -- probing
   `ANDROID_VR` directly (2026-09-17) returned unciphered, token-free URLs for some videos and
   `LOGIN_REQUIRED` for most. Cheaper to try, and it needs a source patch rather than a config
   change, because the SABR branch is chosen before `poToken` is checked.

### Two console errors that remain, and what they mean

- `fetch to api.github.com refused (the secure connection was not authorised)` -- FreeTube's
  update check. `api.github.com` is **not** in [`orivon.json`](orivon.json), so the broker refused
  it. That is the capability boundary working, not a bug, and it is left undeclared on purpose:
  an app asking whether a desktop release exists has no business reaching GitHub here.
- `TypeError: Cannot read properties of undefined (reading 'replace')` in the player `setup`
  path. Metadata is fully populated by this point, so this is downstream of it -- the player, not
  the API. **Playback is not measured yet**; see §Wall 2 below for the ceiling it will hit anyway.

## What else is measured

**It boots.** `test/e2e-freetube-real.test.ts` drives the real shell against the prepared
build: the app is granted from its URL, FreeTube mounts its Vue app inside the resulting app tab,
and it renders its real chrome -- top nav, side nav, Subscriptions/Channels/Trending/Playlists/
History/Settings -- with no console errors and `document.title` of `Subscriptions - FreeTube`.

**Nothing about its data layer is measured yet**, and one thing about it is already known to be
broken through no fault of Orivon's: **all seven Invidious instances FreeTube bundles are down**
(measured 2026-09-17: three fail DNS, one 401, two 404, one 502). The stock web build has no
other backend, so it can render and cannot fetch. That is why the Local API build exists.

**The Local API build's own ceiling is YouTube's bot-guard**, not Orivon: most videos need a
proof-of-origin token, which needs somewhere to execute YouTube's own script. See
[`../freetube/README.md`](../freetube/README.md) §Wall 2, where that was measured.

## Design notes

**Why `prepare.mjs` injects rather than the server.** A server that rewrites what it serves is
executing app logic, and the owner's standing position is that an app's host is a plain static
file server. Injection is a build step; serving is a file read.

**Why the manifest declares sixteen literal hosts.** Every host FreeTube can reach: the seven
Invidious instances, YouTube's API and image hosts, SponsorBlock and Return YouTube Dislike. No
`*:*`, for the reason [`../freetube/README.md`](../freetube/README.md) gives -- a wildcard is
omitted from the served CSP entirely, which would cost the app its images.

**`consentGranularity` is `all-or-nothing` here, unlike the port next door.** That is the honest
setting for an app that never knew Orivon existed: FreeTube has no code path for a capability it
declared being refused, and the manifest contract says silence means exactly this. The port next
door declares `per-capability` because it was written to degrade.
