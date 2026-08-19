# App compatibility tiers

Referenced by ADR-0002. This is the answer to *"are we integrating each Web3 app separately?"*

The answer: **no — but how much you get for free depends on what form the app already
exists in.** What Orivon eliminates is writing a *backend* per app and *modifying the
browser* per app. It does not eliminate frontends. Apps that already have a web frontend get
one for free; apps that don't, don't.

| Tier | App's current form | Frontend | Backend | Examples |
|---|---|---|---|---|
| **1** | Already a web app | **reuse as-is** | none needed | Nostr clients (snort, noStrudel, Coracle), DeFi frontends |
| **2** | Electron / Node desktop app | **reuse as-is** — it is already HTML | swap Node calls for `orivon-node-shim` | Ledger Live, Trezor Suite, Frame, IPFS Desktop, MyCrypto, Exodus |
| **3** | Native / JVM / Qt desktop app | **must rewrite** | bundle a supervised helper process | Bisq, Monero GUI, Electrum, Sparrow, Wasabi |
| **4** | Does not exist yet | **must write** | **must write** | torrent streaming in a browser |

## What this implies for the MVP

**Nostr is tier 1 and costs ~1 day.** Orivon injects `window.nostr` (NIP-07) backed by
`orivon.id`, and every existing Nostr web client works unmodified with no extension
installed. Nothing is bundled and no frontend is written.

**Mastodon was considered and rejected** (ADR-0001). Its *client* is tier 1, but the system
is not trustless: identity is `@user@instance`, owned by the instance admin, and the feed
comes from a party you must trust. Running the Mastodon *server* in a URL — as `mastodon.eth`
in the public docs implies — is Rails + Postgres, i.e. tier 3, the hardest case. Nostr
dominates it on both axes.

**The torrent app is tier 4**, and it is the only tier-4 item in the MVP. That is exactly why
it costs the most *and* why it is the differentiator: the most expensive thing to build is
the thing nobody else has. Even there, reuse is available — `webtorrent-desktop` is
MIT-licensed Electron with a working player UI whose components can be lifted.

**Bisq is tier 3** and is out of the MVP. Its UI is JavaFX, so nothing is reusable: it needs
both a new frontend *and* a bundled JVM, for an app used episodically rather than daily.

## The genericity test

The torrent and Nostr apps must be built **using only the public capability API**, with no
privileged shortcuts and no special-casing inside the shell. If they cannot be, the API is not
generic and that is discovered in week 2 rather than month 6. They are the API's first
consumers and its validation suite.

The measurable claim: **app #3 should cost dramatically less than app #1.** If it does not,
the design has failed.

## Where WASM fits

Tier 3 is out of reach of the `orivon-node-shim` *and* out of reach of WASM — those apps would
need full recompilation plus threads plus a GUI toolkit. So WASM is not the answer to tier 3.

`orivon-runtime`'s real jobs are narrower and both post-MVP (ADR-0002): **containment for
untrusted third-party code**, and **portability to mobile**.

## Licensing caution

Tier 1 and tier 2 reuse means shipping or endorsing third-party code. Licences must be
checked per app before anything is pre-cached or recommended — several Nostr clients are
AGPL, which has real implications for how they are distributed alongside Orivon.
