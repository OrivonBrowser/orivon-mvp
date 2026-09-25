# App compatibility tiers

Referenced by ADR-0002. This is the answer to *"are we integrating each Web3 app separately?"*

The answer is no, but how much you get for free depends on what form the app already
exists in. What Orivon eliminates is writing a *backend* per app and *modifying the
browser* per app. It does not eliminate frontends. Apps that already have a web frontend get
one for free; apps that don't, don't.

| Tier | App's current form | Frontend | Backend | Examples |
|---|---|---|---|---|
| **1** | Already a web app | **reuse as-is** | none needed | Nostr clients (snort, noStrudel, Coracle), DeFi frontends |
| **2** | Electron / Node desktop app | **reuse as-is**, since it is already HTML | swap Node calls for `orivon-node-shim`, plus one small per-app bridge (below) | IPFS Desktop. The hardware-wallet cluster (Ledger Live, Trezor Suite, Frame) is tier 2 in form but blocked on `hid` |
| **3** | Native / JVM / Qt desktop app | **must rewrite** | bundle a supervised helper process | Bisq, Monero GUI, Electrum, Sparrow, Wasabi |
| **4** | Does not exist yet | **must write** | **must write** | torrent streaming in a browser |

## What this implies for the MVP

**The MVP's apps are tier 2.** Build step 5 ports Node.js and Electron desktop apps (FreeTube,
Element, AirGap Vault, ASGARDEX), each its own unmodified frontend plus one bridge file, in
`orivon-ports`. Tier 2 is where the thesis is most literal: software that had to be a desktop app
because a web page could not reach the network or the disk.

**Nostr would be tier 1, at ~1 day.** Orivon would inject `window.nostr` (NIP-07) backed by
`orivon.id`, and every existing Nostr web client would work unmodified with no extension
installed. It is an idea, not a build step (`../mvp-scope.md` §LATER).

**Mastodon was considered and rejected** (ADR-0001). Its *client* is tier 1, but the system
is not trustless: identity is `@user@instance`, owned by the instance admin, and the feed
comes from a party you must trust. Running the Mastodon *server* in a URL, as `mastodon.eth`
in the public docs implies, is Rails + Postgres, i.e. tier 3, the hardest case. Nostr
dominates it on both axes.

**A torrent app would be tier 4**: the most expensive thing to build, and the thing nobody else
has. It is an idea, not a build step; `../planning/torrent-app.md` keeps what is known.
Reuse is available even there: `webtorrent-desktop` is MIT-licensed Electron with a working
player UI whose components can be lifted.

**Bisq is tier 3** and is out of the MVP. Its UI is JavaFX, so nothing is reusable: it needs
both a new frontend *and* a bundled JVM, for an app used episodically rather than daily.

> **A fourth path for tier 3, parked:**
> [`../planning/container-apps-opportunity.md`](../planning/container-apps-opportunity.md).
> Run the app unmodified inside a Linux container and stream its windows into a tab, so tier 3
> costs an image build instead of a rewrite. It would also reach the tier-2 wallet cluster that
> waits on `hid` (below). Post-MVP, unverified, and it reopens `subprocess`. But the
> "must rewrite" column above is not the only option, and that document says what it would cost.

**What tier 2 actually reaches in v0.** Ledger Live, Trezor Suite and Frame are
**hardware-wallet applications requiring `hid`/USB**, which `capability-api.md` excludes from v0
entirely, for every tier. The apps build step 5 ports are the v0 examples; the wallet cluster
waits on `hid`, a post-MVP capability.

**"Swap Node calls for the shim" understates the shim's real surface.** Running `webtorrent` in a
sandboxed renderer needs `Buffer`, `stream`, `events`, `crypto`, `path`, `os` and `process`
polyfills alongside the capability-backed `net`/`dgram`/`fs`, plus an HTTP client for trackers
and web seeds, since a renderer's `fetch` is CORS-bound. The capability-backed part is the small
part. Telling developers it is one import is the same category of dishonesty the trust indicator
exists to prevent.

## Tier 2 needs one small file per app

An Electron app is really two programs: a **web page** you see, and a **helper** that does what a
web page is not allowed to do, like opening network sockets or writing files. The page asks the
helper for favours over a private channel the app invented for itself, usually `window.<something>`.

Orivon takes the helper's place. The page does not know that. It still calls
`window.ftElectron.chooseDefaultFolder()`, or whatever names that app picked, and if nothing
answers it stops on its first line.

So every ported tier-2 app ships **one small file** that answers those calls and passes them on to
`orivon.*`. It belongs with the app, never in `src/`. Ports live in the `orivon-ports`
repository, one directory per app, alongside the harness that builds and serves them.

**It cannot be written once for all apps.** The names are each app's own inventions, with no
standard behind them. Only that app's own source says what `chooseDefaultFolder` was meant to do.

**It stays small.** Most calls are not missing powers. In the one measured port
(`orivon-ports`'s `apps/freetube/`), of 34 calls: 7 the browser already does itself, 19 are
answered inertly because there is no second program left to talk to, 5 are refused by design,
2 use `orivon.fs`, and 1 needs `orivon.web.context`.

**Three ways to make it smaller**, cheapest first:

1. Declare the file in the manifest, instead of injecting a `<script>` tag into the app's HTML.
2. Cover more of the `electron` module in [`src/shim-electron/`](../../src/shim-electron/).
   Whatever the shim covers, the per-app file does not have to.
3. Record the calls at runtime behind a `Proxy` and generate the stub, leaving only the
   judgement calls to a person.

**What stays manual.** Anywhere an Orivon capability is deliberately shaped differently from the
Electron one. A picked folder resolves to a handle and never to a host path, so an app that builds
a path string and writes to it has to be re-shaped by hand, not translated.

## The genericity test

The torrent and Nostr apps must be built using only the public capability API, with no
privileged shortcuts and no special-casing inside the shell. If they cannot be, the API is not
generic and that is discovered in week 2 rather than month 6. They are the API's first
consumers and its validation suite.

The measurable claim: app #3 should cost dramatically less than app #1. If it does not,
the design has failed.

## Where WASM fits

Tier 3 is out of reach of the `orivon-node-shim` *and* out of reach of WASM: those apps would
need full recompilation plus threads plus a GUI toolkit. So WASM is not the answer to tier 3.

`orivon-runtime`'s real jobs are narrower and both post-MVP (ADR-0002): containment for
untrusted third-party code, and portability to mobile.

## Licensing caution

Tier 1 and tier 2 reuse means shipping or endorsing third-party code. Licences must be
checked per app before anything is pre-cached or recommended: several Nostr clients are
AGPL, which has real implications for how they are distributed alongside Orivon.
