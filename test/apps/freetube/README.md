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

Under `npm run dev`, opening its URL raises the real consent prompt and accepting it is the last
step -- see §Consent without installing. Playback still depends on YouTube serving a stream at
all, which for most videos it will not (§Wall 2).

## Consent without installing

**Capabilities are granted to a URL. Installing is a separate feature**, and this app needs only
the first. `tab-view.ts`'s `appTabArgsFor` gates the app-tab flag, and therefore routed fetch, on
`broker.app.isRegisteredSync(origin)` alone -- no pin, no cached bundle.

**The install path refuses a loopback origin, by design, and still does by default.**
`<link rel="orivon-manifest">` -> [`manifest-hint.ts`](../../../src/main/manifest-hint.ts) ->
`installApp` -> [`app-install.ts`](../../../src/main/app-install.ts)'s `installFromHint` ->
`Loader.load()`, which applies `ensurePublicUnicastOrigin` before any manifest is read (A46, T12).

**Under `npm run dev` a loopback origin takes a second path instead:**
[`dev-app-origin.ts`](../../../src/main/dev-app-origin.ts) fetches only the manifest, registers the
origin, and raises the same consent prompt an install raises. Nothing is fetched as a bundle,
hashed, pinned or served from cache; this directory's own `serve.mjs` keeps serving the page. It
is bounded:

- **Only `npm run dev` enables it** -- `scripts/dev.mjs` sets `ORIVON_DEV_ORIGINS=1`. `npm start`,
  which is what a run-from-source user runs, never does, so the refusal above stands for them.
- **Loopback literals and `.eth` names only** -- `127.0.0.1`, `[::1]`, or a single-label
  `<name>.eth`, never a `localhost` *name*, whose answer depends on a resolver. `https:` is
  refused for an `.eth` name outright: no such name will ever present a certificate, so an
  attempt could not be told apart from a real one.
- **Session-only** -- a loopback grant is never persisted (T13c).
- **A re-hint cannot widen a held grant.** If the manifest now asks for more than was granted on a
  capability already held, the hint is refused rather than re-prompted, because an
  all-or-nothing accept would re-grant it under a row the prompt labels as already allowed.
- **Not enforced:** A46's refinement that the navigation be *user-typed*.

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
| **Video playback** | **Works on a live origin** (measured: `readyState 4`, 213s duration), for videos YouTube will serve at all -- see §Wall 2. Blocked for an INSTALLED app -- see §Wall 1 |

## The two walls

### Wall 1: the served CSP cannot name a video CDN host -- **INSTALLED APPS ONLY**

**This is a property of one serving path, not of the platform.** Granting capabilities to a URL
and installing an app are separate features; this app only ever needed the first, and on a live
origin **playback works**:

```
PLAYBACK on a live origin: "Playing over direct." (readyState 4, duration 213s)
media-src on a LIVE origin -- violations: []
```

A page served by its own host gets no CSP from `serve.ts`, because `serve.ts` is not serving it,
so nothing constrains `<video>` and the rotating CDN host is reachable. Everything below applies
when an app has been INSTALLED -- pinned and served from cache under ADR-0007 -- and is a real
constraint on that path, not on running an app.

YouTube serves media from `rr1---sn-uxaxpu5ap5-2hve.googlevideo.com` and a different
subdomain on the next request. A manifest cannot name that host:

- [`connect-patterns.ts`](../../../src/broker/policy/connect-patterns.ts)'s `hostSpecKind` returns
  `authorises-nothing` for any host containing `*`, and `patternRejection` names `sub-glob`
  explicitly. `*.googlevideo.com:443` is a rejected pattern, deliberately -- "a wildcard that
  silently spans a registry boundary" is the reason given, and it is a good one.
- The remaining option is `*:*`, and
  [`connect-src.ts`](../../../src/broker/policy/connect-src.ts) omits exactly that from the emitted
  CSP (`host-any-public-unicast`), because a bare CSP `*` would also permit loopback and the LAN.

So `img-src`/`font-src`/`media-src`, which
[`serve.ts`](../../../src/loader/serve.ts)'s `cspHeaderValue` builds from the `https.connect` grant,
can be `'self'` plus literal hosts, or `'self'` alone -- never a pattern that covers a rotating
CDN. **A `<video src>` pointing at a googlevideo URL is refused by the page's own CSP before any
request leaves, no matter what was granted.**

The obvious way around it does not work either, for a separate reason. A routed `fetch` is
explicitly *not* subject to CSP (`ADR-0017`'s own Consequences), so the bytes can be fetched --
but they then have to reach the element as a `blob:` URL, and `media-src 'self'` does not cover
`blob:`.

**Settled by measurement, in a real app tab** (`test/e2e-freetube-app.test.ts`). Both routes were
driven against a live `<video>` element under the app's own served CSP, and both raised a real
`securitypolicyviolation`:

```
media-src <- blob
media-src <- https://rr1---sn-4g5ednsk.googlevideo.com/videoplayback?probe=1
```

So the wall is confirmed from both sides: the CDN host cannot be named, and the blob fallback the
routed fetch would produce is refused by the same directive. `lib/playback.js` reports whichever
of the two refused it rather than going blank.

**Two possible platform-side fixes, neither of them settled:**

1. Add `blob:` to `appReachCspHeaderValue`'s directive list. Narrow, and it only admits bytes the
   app already fetched through a grant-checked routed fetch -- no new reach.
2. Support a bounded sub-glob (`*.googlevideo.com`) as a pattern kind. Much larger, and it argues
   against a rule `connect-patterns.ts` adopted on purpose.

Neither belongs in this directory, so neither is done here. This app instead detects the
refusal via `securitypolicyviolation` and says so in the player, rather than going blank.

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
mean FreeTube cannot be a playback demo for the platform on its own, which is a scheduling fact
worth knowing before build step 5's clip.

## Running it

**To use it yourself:**

```bash
node apps/freetube/serve.mjs           # terminal 1: a plain static server on http://127.0.0.1:8874
npm run dev                            # terminal 2: then open http://127.0.0.1:8874 and accept
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
node apps/freetube/verify.mjs          # API + storage layers only, against live YouTube
node apps/freetube/serve.mjs           # static server on http://127.0.0.1:8874
```

`verify.mjs` runs in Node on purpose. Node's `fetch` shares the two properties `ADR-0017` gives a
routed fetch -- no CORS, no forbidden-header list -- so it is an honest test of this app's network
layer. It models nothing else about an app tab: not the served CSP, not the 16 MiB routed-fetch
body cap, not `<video>`. It reports "a stream URL was resolved", never "a video played".

### Opened any other way, it stays inert -- on purpose

**In an ordinary browser**, `window.orivon` is absent: the app renders its "No Orivon runtime
detected" banner and makes no request, since a browser would refuse the origin under CORS and
strip the headers YouTube needs.

**In Orivon without `npm run dev`** -- `npm start`, say -- the loopback origin takes the install
path, which refuses it (§Consent without installing). No prompt appears, the tab is never
registered, and `fetch` is never rerouted. `lib/views.js` names that state on screen before any
request, rather than letting a doomed one report `Failed to fetch`.

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
