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

**Two routes to playback. The first is closed; the second is untried.**

1. **Generate the token in the page: closed.** YouTube binds the token to the document origin.
   BotGuard runs to completion anywhere, but `GenerateIT` issues a token only to a document at
   `https://www.youtube.com`, and no page, iframe or sandbox page can be at that origin. See
   §Spike results.
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
  the API. **Playback is not measured yet**; see [`../freetube/README.md`](../freetube/README.md)
  §Wall 2 for the ceiling it will hit anyway.

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

## Spike results: can BotGuard run in an isolated child?

Measured 2026-09-18 in Electron 44.0.0 (Chrome 152.0.7977.54) against live YouTube, from a
throwaway harness kept outside this repository because it drives upstream's AGPL script. The
question: can an opaque-origin child with no `orivon.*`, which talks to its parent only by
`postMessage`, mint the proof-of-origin token upstream needs? That child is the shape of a
manifest-declared sandbox page.

**It cannot. The reason rules out every isolation primitive, not only this one.**

| # | Question | Answer |
|---|---|---|
| 1 | Does BotGuard produce a token from an opaque origin? | **No.** The token is bound to the document origin, and only `https://www.youtube.com` gets one |
| 2 | Does BotGuard need `eval`? | **Yes.** The interpreter calls it itself; withholding `'unsafe-eval'` stops it loading |
| 3 | Can a sandbox page be enforced on a live origin? | **Yes, but not through the loader.** A response header added in `onHeadersReceived` works |
| 4 | Is the CSP `sandbox` directive honoured on a `protocol.handle` response? | **Yes**, framed and top-level |
| 5 | Does a `srcdoc` child's meta CSP block requests before the handler sees them? | **Yes** |
| 6 | Are sandboxed iframes process-isolated in Electron 44? | **Yes**, with no flag |
| 7 | Does fingerprinting reject a child that has real dimensions but is out of view? | **Could not be measured.** Question 1 fails first |

### 1: the token is bound to the document origin

Upstream's own `src/botGuardScript.js` was bundled unmodified and run in contexts that change one
thing at a time. Except for the first row, every request went through the same relay: a Node
`fetch` in the main process, which is how Orivon's routed fetch reaches the network.

| Context | Document origin | Network | `GenerateIT` answered | Tokens |
|---|---|---|---|---|
| upstream's `generatePoToken`, reproduced verbatim | `https://www.youtube.com` | Chromium | `["<token>",43200,100]` | 2 of 2 |
| that same view | `https://www.youtube.com` | relay | `["<token>",43200,100]` | 3 of 3 |
| that same view | `https://example.org` | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| that same view | opaque, top-level | relay | `[null,43200,null,"Mk..."]` | 0 of 2 |
| sandboxed `srcdoc` child of a live origin, in view | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |
| the same child, 1920x1080 and positioned off-screen | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| the same child, 1x1 | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |

The one-variable rows ran alone, each as the first mint in a fresh process, so the result does not
depend on order.

In every row BotGuard ran to completion: the interpreter loaded, the snapshot was taken, and
`GenerateIT` answered `200`. **Google's server declined to issue the token**, and the only thing
that differs between the rows that got one and the rows that did not is the document origin. The
relay is not the cause, since it gets a token for a youtube.com document.

Upstream reaches that origin by loading a `data:` URL with
`baseURLForDataURL: 'https://www.youtube.com/'` into a `WebContentsView`. That is a privilege of
the embedding application. A web page cannot put a document at another site's origin, because
that is the web's origin model working. So no child context Orivon could hand an app reaches it
either: not a sandbox page, not a `srcdoc` frame, not a worker with delegated ports, and not a
child at the app's own origin.

**This is where the isolated-child route stops.** A token could only come from Orivon itself
creating a document at a foreign origin on an app's behalf. That is a different kind of capability
(an app acting as another site, towards that site), not a missing piece of this one.

Whether YouTube then *accepts* a token for playback was not reached, and cannot be checked cheaply.
For the WEB client, `/player` answered `OK` with or without a token, and its formats carried no
direct URLs (SABR only). Any real check has to make a SABR request.

### 2: BotGuard needs `eval`

The interpreter (`www.google.com/js/th/*.js`, 63 KB) evaluates code at runtime from three call
sites: a direct `eval(T)` that is one of its VM instructions, and two Trusted Types
`createScript` -> `.eval` probes. Measured: in a child whose CSP withholds `'unsafe-eval'`, with
the interpreter loaded as a real `<script>` instead of upstream's `new Function`,
`BotGuardClient.create` fails with `EGOU: BotGuard unavailable`. It also creates an iframe of its
own, with `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"`.

### 3 to 6: the platform primitive itself works

- **3.** `src/loader/serve.ts` serves only installed origins, so it can never give a sandbox page on
  a live origin a header. A live origin's responses do pass through
  `session.webRequest.onHeadersReceived`, however: A110 records that the listener never fires for a
  `protocol.handle` response, and a live origin is not one. Adding
  `Content-Security-Policy: sandbox allow-scripts` there made the page opaque, framed and
  top-level. Its `self.origin` read `"null"`, and `localStorage`, `document.cookie` and
  `parent.document` each threw `SecurityError`. The same page without the header kept its real
  origin. The primitive therefore needs two mechanisms: the served header for installed apps, and
  `onHeadersReceived` for live origins. Nothing in `src/` registers `onHeadersReceived` today.
- **4.** A `protocol.handle('https')` response carrying `Content-Security-Policy: sandbox
  allow-scripts` got the same result as 3: opaque, framed and top-level.
- **5.** Under a parent served by `protocol.handle`, a sandboxed `srcdoc` child whose meta CSP was
  `default-src 'none'` had its `fetch` and `<img>` refused in the renderer, with `connect-src` and
  `img-src` violations. **Neither request reached the handler.** The same child without the meta
  CSP reached the handler with both. So without a CSP, a sandboxed child's requests do arrive at
  the handler, which on the installed path is `fetchThirdParty`.
- **6.** Every sandboxed frame, whether `srcdoc` or a URL carrying the CSP `sandbox` header, ran in
  a different OS process from its parent (parent pid 65583, sandboxed children 65611). A
  same-origin, unsandboxed child shared the parent's process. Sandboxed children of one site share
  one process with each other.

### 7: masked by 1

The in-view, off-screen and 1x1 children all failed at the same step, `GenerateIT` answering
`null`, like every other context that was not youtube.com. The origin check fires first, so
dimensions cannot be isolated from an opaque child. Upstream's metric spoofing (DevTools
`Emulation.setDeviceMetricsOverride`) was reproduced in the control rows, but whether it is
necessary was not tested: for an opaque context it cannot change the outcome.

## Design notes

**Why `prepare.mjs` injects rather than the server.** A server that rewrites what it serves is
executing app logic, and the owner's standing position is that an app's host is a plain static
file server. Injection is a build step; serving is a file read.

**Why the manifest declares `*:*` next to sixteen literal hosts.** Video bytes come from
googlevideo.com hosts whose names rotate per video and per request
(`rr1---sn-4g5ednsk.googlevideo.com`). A connect pattern cannot be a sub-glob, so nothing narrower
than `*:*` reaches them. The sixteen literals are every other host FreeTube is known to reach: the
seven Invidious instances, YouTube's API and image hosts, SponsorBlock and Return YouTube Dislike.
On a live origin no Orivon CSP applies, so the wildcard costs nothing there. On the installed path
the served CSP omits it, which costs the app its images, for the reason
[`../freetube/README.md`](../freetube/README.md) gives.

**`consentGranularity` is `all-or-nothing` here, unlike the port next door.** That is the honest
setting for an app that never knew Orivon existed: FreeTube has no code path for a capability it
declared being refused, and the manifest contract says silence means exactly this. The port next
door declares `per-capability` because it was written to degrade.
