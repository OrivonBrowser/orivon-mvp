# `test/apps/freetube/`: the FreeTube demo app

**What lives here.** A YouTube frontend written as an ordinary Orivon app: search, channel
pages, watch metadata, related videos, watch history, and a player. No dependencies, no build
step, no `src/` import at runtime -- it holds exactly the privileges its manifest declares and a
person granted, the same as any third-party app would.

**What it depends on.** `orivon.*` at runtime, and nothing else. Not even
[`src/contracts/`](../../../src/contracts/), which it reads as documentation rather than importing.

**What it must never import.** Anything under `src/`.

**Owner stream.** Unassigned. This is a **test subject, not a porting project** -- `A102`'s
standing framing, which this directory does not change.

**Status: the app works.** Served by a plain static file server at its own URL, granted
per-origin, with nothing installed to disk: search, channels, watch metadata, thumbnails **and
video playback** all work, reaching live YouTube through the broker. Proven by
`test/e2e-freetube-live-origin.test.ts`.

Opening its URL raises the real consent prompt, and accepting it is the last step -- see §Consent
without installing. Playback still depends on YouTube serving a stream at
all, which for most videos it will not (§Wall 2).

## Consent without installing

**Capabilities are granted to a URL. Installing is a separate feature**, and this app needs only
the first. `tab-view.ts`'s `appTabArgsFor` gates the app-tab flag, and therefore routed fetch, on
`broker.app.isRegisteredSync(origin)` alone -- no pin, no cached bundle.

**The install path refuses a loopback origin**: `Loader.load()` applies
`ensurePublicUnicastOrigin` before any manifest is read (A46, T12). So a loopback origin's
`<link rel="orivon-manifest">` hint never goes there:
[`app-install-subsystem.ts`](../../../src/main/install/app-install-subsystem.ts) hands it to
[`grant-without-install.ts`](../../../src/main/install/grant-without-install.ts) instead, in every
build, which fetches only the manifest, registers the origin, and raises the same consent prompt
an install raises. Nothing is fetched as a bundle, hashed, pinned or served from cache; this
directory's own `serve.mjs` keeps serving the page. It is bounded:

- **Loopback only** -- a loopback literal such as `127.0.0.1` or `[::1]`, or a `localhost` name,
  which Chromium resolves to loopback itself. An orivon-ports `.eth` name takes the same path only
  under `npm run dev`, and never over `https:`: no such name will ever present a certificate, so
  an attempt could not be told apart from a real one.
- **Session-only** -- a loopback grant is never persisted (T13c).
- **A re-hint cannot widen a held grant.** If the manifest now asks for more than was granted on a
  capability already held, the hint is refused rather than re-prompted, because an
  all-or-nothing accept would re-grant it under a row the prompt labels as already allowed.
- **Not enforced:** that the navigation was *typed*. A link to a loopback URL leads to the same
  prompt.

Separating consent from install for public origins too touches ADR-0007/ADR-0009's framing, and is
an owner-level decision this directory does not settle.

---

## What this port answers

`orivon-ports`'s `docs/freetube-recon.md` read FreeTube 0.25.3 and
concluded: its renderer is a pure browser app over 32 `fetch` call sites, so the Node shim does
nothing for it, and routing `fetch` with app-chosen forbidden headers is the whole difference
between working and not working. [`ADR-0017`](../../../docs/decisions/ADR-0017-orivon-owns-the-app-http-path.md)
was accepted on that basis.

**Both halves of that hold, measured rather than assumed.** This app reaches YouTube's private
InnerTube API by setting `Origin`, `User-Agent` and `Accept-Encoding` on its own requests --
three headers a browser forbids a page to set, on an origin CORS would refuse outright. It
imports no Node builtin and no `electron` module. `npm run verify` (below) exercises that path
end to end.

It also found things the reconnaissance could not, because it read source rather than running
it. Those are §The two walls.

## What works

Verified by `node verify.mjs`, 11/11 passing on 2026-09-17 against live YouTube:

| Area | State |
|---|---|
| Search (videos, channels, playlists) | Works. 20 results parsed per query, every card named |
| Watch metadata (title, channel, views, date, description) | Works |
| Related videos | Works |
| Channel pages (name, handle, subscriber count, uploads) | Works |
| Thumbnails and channel avatars | Hosts are declared literally, so the served CSP names them |
| Watch history, search history, settings | Works, persisted as real nedb NDJSON over `orivon.fs` |
| Running with a refused `fs` grant | Works: every collection falls back to memory and says so |
| Running with a refused `https` grant | Works: the app loads and names what is missing |
| Stream URL resolution | Works for videos YouTube will answer for -- see wall 2 |
| **Video playback** | **Works on a live origin** (measured: `readyState 4`, 213s duration), for videos YouTube will serve at all -- see §Wall 2. Blocked for an INSTALLED copy of this app, whose manifest names no CDN host -- see §Wall 1 |

## The two walls

### Wall 1: an installed copy of this app cannot name the video CDN -- **INSTALLED APPS ONLY**

**This is a property of one serving path, not of the platform.** Granting capabilities to a URL
and installing an app are separate features; this app only ever needed the first, and on a live
origin **playback works**:

```
PLAYBACK on a live origin: "Playing over direct." (readyState 4, duration 213s)
media-src on a LIVE origin -- violations: []
```

A page served by its own host gets no CSP from Orivon's cache, because the cache is not serving
it, so nothing constrains `<video>` and the rotating CDN host is reachable. Everything below
applies when the app has been INSTALLED -- pinned and served from cache under ADR-0007 -- and
comes from this app's own manifest, not from a limit of that path.

YouTube serves media from `rr1---sn-uxaxpu5ap5-2hve.googlevideo.com` and a different
subdomain on the next request. A literal pattern cannot name that host:

- [`connect-patterns.ts`](../../../src/broker/policy/connect-patterns.ts)'s `hostSpecKind` returns
  `authorises-nothing` for any host containing `*`, and `patternRejection` names `sub-glob`
  explicitly. `*.googlevideo.com:443` is a rejected pattern, deliberately -- "a wildcard that
  silently spans a registry boundary" is the reason given, and it is a good one.
- The one pattern that covers it is `*:443` under `https.connect`: unlimited HTTPS. For that
  grant the served CSP ([`src/loader/serve/csp.ts`](../../../src/loader/serve/csp.ts)) emits the
  `https:` scheme source in `media-src`, `img-src`, `font-src` and `connect-src`, and every
  request it admits is re-authorised by the app's own request handler, which still refuses
  loopback and private addresses.

This app's [manifest](.well-known/orivon.json) names its API and image hosts literally and asks
for no `*`, so on an installed copy **a `<video src>` pointing at a googlevideo URL is refused by
the page's own CSP before any request leaves.** Routing the bytes through a `fetch` does not get
round it for the same reason: a routed `fetch` reaches only a granted host, and the CDN is not
one.

The header does not stand in MSE playback's way: `media-src` admits `blob:`, the URL MSE hands the
`<video>`. `test/e2e-freetube-app.test.ts` asserts it against a live `<video>` element under the
installed app's own served CSP. `lib/playback.js` also refuses a route-3 stream over 16 MiB, a
limit of its own (`ROUTED_FETCH_BODY_CAP`): the routed `fetch` itself has no body cap.

**What would open playback on an installed copy:** declaring `https.connect: ["*:443"]`, at the
price of a prompt that asks for unlimited HTTPS, or a bounded sub-glob pattern kind
(`*.googlevideo.com`), which argues against a rule `connect-patterns.ts` adopted on purpose. The
app detects a refusal via `securitypolicyviolation` and says so in the player, rather than going
blank.

### Wall 2: YouTube's bot-guard (external, not a platform problem)

Measured 2026-09-17 across six InnerTube client identities and five videos: every client except
`ANDROID_VR` returns `UNPLAYABLE`, `LOGIN_REQUIRED` or HTTP 400 for a stream request, and
`ANDROID_VR` itself answered for **1 of 5** test videos. The rest return `LOGIN_REQUIRED --
"Sign in to confirm you're not a bot"`. Public Invidious instances, which FreeTube's other
backend uses and which do this work server-side, were **all unreachable** on the same day (four
returned 401/403/404/500; the rest did not resolve).

This is the `GENERATE_PO_TOKEN` handler the reconnaissance listed as *Unassessed*. **It is now
assessed: it is load-bearing, not optional.** Producing the token means executing YouTube's own
bot-guard script, which needs somewhere to run untrusted code plus real HTTP. Nothing in this
repository offers that, and a `WASM`/sandbox route is out of scope by `mvp-scope.md`.

**This wall is not Orivon's.** It refuses `curl` and a stock browser tab the same way. It does
mean FreeTube cannot be a playback demo for the platform on its own, which is worth knowing
before choosing one.

## Running it

**To use it yourself:**

```bash
node test/apps/freetube/serve.mjs      # terminal 1: a plain static server on http://127.0.0.1:8874
npm start                              # terminal 2: then open http://127.0.0.1:8874 and accept
```

That is the whole of it: open the URL, answer the prompt, use the app.

**The installed-app assertion run** -- pins this directory, grants through the dev-only hook
rather than a prompt, and checks instead of showing a window:

```bash
node scripts/build-e2e.mjs
node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-app.test.ts
```

That pins the real files from this directory, grants the manifest's own capabilities through the
dev-only hook, navigates a tab to the origin, and drives a real search. **It deliberately does
not pass `HERMETIC_RESOLVER`**, so it talks to real YouTube -- which is what makes it meaningful
and also what makes it unfit to gate CI.

The two offline helpers:

```bash
node test/apps/freetube/verify.mjs     # API + storage layers only, against live YouTube
node test/apps/freetube/serve.mjs      # static server on http://127.0.0.1:8874
```

`verify.mjs` runs in Node on purpose. Node's `fetch` shares the two properties `ADR-0017` gives a
routed fetch -- no CORS, no forbidden-header list -- so it is an honest test of this app's network
layer. It models nothing else about an app tab: not the served CSP, not `<video>`. It reports "a stream URL was resolved", never "a video played".

### Opened any other way, it stays inert -- on purpose

**In an ordinary browser**, `window.orivon` is absent: the app renders its "No Orivon runtime
detected" banner and makes no request, since a browser would refuse the origin under CORS and
strip the headers YouTube needs.

**In Orivon, until the prompt is answered**, the first load runs in an ordinary tab: the origin
is not registered yet, and `fetch` is not rerouted (§Consent without installing). `lib/views.js`
names that state on screen before any request, rather than letting a doomed one report
`Failed to fetch`.

## Design notes

**Why this is an Orivon-native app and not vendored FreeTube.** FreeTube's renderer is a Vue 3
application built by webpack, and `youtubei.js` is a dependency tree of its own. Vendoring it
means a build step and an npm dependency set inside this directory -- both of which this
repository's Rule 8 and its zero-build-step app convention (see
[`../fixture/README.md`](../fixture/README.md)) exist to keep out. What is reusable from a real
port was built instead: `lib/ft-electron.js` is FreeTube's own `window.ftElectron` bridge,
rebuilt over `orivon.*`. A real FreeTube renderer dropped in later talks to that object and
needs no edit of its own. The UI on top of it exists to prove the bridge works.

**Why the manifest declares eleven literal hosts rather than `*:*`.** Unlimited HTTPS is the
widest permission in the system, and `connect-src.ts` omits it from the CSP entirely -- so
declaring it would *lose* this app its thumbnails, which are the one subresource class that does
work. Literal hosts cost the app a user-typed Invidious instance (below) and buy it every image
on every page. That trade is only available because this app's hosts are knowable in advance;
wall 1 is what happens when they are not.

**The user-typed Invidious instance is the gap `ADR-0017` named, hit concretely.** FreeTube lets
a person type any instance hostname. No manifest can predict it, so no grant can cover it. This
port ships a fixed list of four declared instances and the settings screen says why a free-text
field is not offered. **Still open**: whether a person choosing a host at runtime deserves a
route at all is not a question this directory can answer.

**Why `lib/parse.js` reads two generations of renderer shape.** InnerTube returns
`videoRenderer` on search and `lockupViewModel` on related rails; they share no field paths, and
a `lockupViewModel` has a `contentType` that must be checked, because a playlist fills the same
positional metadata rows with its first two *entries*. Parsing one as the other yields a video
whose "channel" is another video's title -- measured, and the reason that check exists.

**Why the store writes nedb's on-disk format.** FreeTube's datastores are `@seald-io/nedb`
collections, and nedb's format is append-only NDJSON. Writing that exact format rather than one
of our own keeps a collection written here loadable by the real nedb a full port would use.
