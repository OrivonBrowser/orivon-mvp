# Orivon

**A browser that runs applications Chrome cannot.**

A web page can't open a TCP socket, join a DHT, or write a file to your disk. That isn't an
oversight — it's the sandbox, and it's why some software has to be a desktop app even when it
has no business being one.

Orivon changes the terms. An app is still an ordinary web frontend delivered from a URL, but it
declares what it needs in a manifest, and **you grant it, per app, in plain words**. Not
"orivon.example.com wants to use your network" — *"connect to any computer on the internet"*.
No capability is implicit, and nothing an app didn't declare can ever be granted, even by you.

The proof is a BitTorrent client that runs in a tab. No client installed, no extension, no
native helper. Paste a magnet link, approve one prompt, watch the video.

> ### Status: pre-alpha. Nothing is released.
>
> **Build step 1 of 10 is done** — the browser shell: tabs, omnibox, back/forward, window
> chrome. It runs, and you can browse with it.
>
> **The capability broker — the actual product — is not written yet.** Neither is the Node
> shim, the app loader, or the torrent app. There is no packaged build, no installer, and no
> release. See [`docs/planning/build-plan.md`](docs/planning/build-plan.md) for the order of
> work, and [`CHANGELOG.md`](CHANGELOG.md) for what has actually landed.

## Try it

```bash
git clone https://github.com/OrivonBrowser/orivon-mvp.git
cd orivon-mvp
npm install
npm run dev
```

**No compiler needed** — not on Linux, Windows, or macOS. That's deliberate and enforced by a
check that fails the build if any dependency needs one: Windows and macOS are supported through
running from source rather than signed installers, and an `npm install` that demands Visual
Studio Build Tools would be a worse obstacle than the certificate it avoids.

Full prerequisites and the one environment trap worth knowing about:
[`docs/development/setup.md`](docs/development/setup.md).

## What's different

| | |
|---|---|
| **Capabilities are per app, declared, and granted by you** | An app gets what its manifest declares *and* you approve. Absence from the manifest means absence — not default-allow |
| **Apps come from a URL, not a store** | Type an address, choose "Open as app". The code is fetched, cached and hash-pinned. No review process, no gatekeeper, no account |
| **Your data stays on your machine** | Per-origin isolation, local-first storage. There is no Orivon server holding user data, because there is no Orivon server |
| **One identity, every site** | A Nostr identity that works across every client with no extension and no seed phrase to write down |

## How this relates to Web3

Directly, and not in the way you might expect.

**The problem Orivon is aimed at:** decentralised protocols are hard to *use* because the
browser refuses to speak them. A web page cannot open a BitTorrent connection, cannot join a
DHT, cannot hold a signing key, cannot talk to a node over a raw socket. So every "Web3" app in
a browser today routes through something centralised to compensate — an RPC provider, a
gateway, a hosted indexer, a wallet extension. **The decentralised protocol is real; the path
your browser takes to reach it usually isn't.**

That is a browser limitation, not a protocol limitation. Orivon removes it: the page gets the
capability, under a permission you granted, so a decentralised app can just be a web page.

Two things in this MVP demonstrate it:

- **BitTorrent in a tab.** Real peers, real DHT, no gateway, no seedbox, nothing in the middle.
- **One identity across every site.** A Nostr key held by the browser, so any Nostr client you
  visit signs you in — no extension, no seed phrase, no setup. Internally these are called
  *Web3 Accounts*.

**What is not in this MVP.** These are scope boundaries for *this month's build*, not
statements about where Orivon is going — the difference matters, so it is spelled out:

- **No funds movement.** The identity system here is what the project calls a **Web3
  Account**: keys, signing, and one identity across sites. It holds no funds, shows no seed
  phrase, and cannot send or receive.
  **The wallet is a long-term goal, not a rejected idea** — the design has three layers
  (Accounts, Crypto, Address book), and this MVP ships only the first. The other two need a
  meaningfully different security model and come later.
- **No ENS, no IPFS, no DDOC yet.** All three are real parts of the plan. Trustless name
  resolution in particular is substantial work, and much of the rest depends on it landing
  first.
- **No token, chain, DAO or governance *in the product*.** Orivon does have a
  [DAO plan](https://github.com/OrivonBrowser/orivon-docs) — treasury, merit-tracked
  contribution, the lot. It is **organisational rather than a browser feature**, so it lives
  outside this repository entirely. You will not find it here, and its absence here says
  nothing about whether it is happening.

The longer framing, in the project's own words, is *Web4*: easy interfaces to **use** Web3, in
the way Web2 gave easy interfaces to read and write Web1. That vision — including the wallet
layers and the DAO — lives in
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs). **This repository is deliberately
narrower than the vision**: it is one testable claim, tested first.

## Roadmap

**In this MVP** — [`docs/planning/build-plan.md`](docs/planning/build-plan.md) has the detail.
Strictly dependency-ordered; each step needs the one before it.

| | Step | State |
|---|---|---|
| 0 | Feasibility spike — can a renderer really run a torrent client? | **done** — [verdict](docs/planning/spike-verdict.md) |
| 1 | **Shell** — tabs, omnibox, back/forward, window chrome | **done** |
| 2 | **Capability broker** — manifests, grants, per-origin enforcement | next |
| 3 | **Node shim** — `net`, `dgram`, `fs` over `orivon.*` | |
| 4 | **App loader** — manifest discovery, fetch, cache, hash-pinning | |
| 5 | **Torrent app** — the flagship, and the demo clip | |
| 6 | **Trust indicator** — what an app actually did, not a grade | |
| 7 | **Nostr identity** — `window.nostr` across every client | |
| 8 | **Telemetry** — with the first-run disclosure | |
| 9 | **Developer mode** — load an unpacked app | |
| 10 | **Packaging** — AppImage and deb | |

**Deliberately deferred** — choices, not oversights, and every one of them is still on the
long-term plan ([`docs/mvp-scope.md`](docs/mvp-scope.md)): trustless name resolution (ENS and
friends) · DDOC · IPFS and Arweave as a second delivery path · an app store · **the wallet's
Crypto and Address-book layers** · identity export and backup · `subprocess` and `hid`
capabilities · signed Windows and macOS installers.

**Longer term, and not scheduled:** a WebAssembly runtime for containing untrusted apps ·
mobile · Tor and proxy chains · cross-device sync. A browser-engine fork is a hypothesis about
where this could eventually go — **nobody is working on it, and nothing here depends on it
happening.**

*This roadmap covers the **product**. Orivon's organisational plans — the DAO, the treasury,
contribution and token distribution — are real, and they live in
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs) rather than here, because they are
not browser features.*

## The idea underneath

**This repository is an Electron app, and it is meant to be replaceable.** The thing built to
last is the *interface* apps are written against — seven files of TypeScript types in
[`src/contracts/`](src/contracts/), with no implementation in them at all.

An app calls `orivon.net.connect()`. Today that reaches a Node socket in an Electron main
process. The interface is designed so it could reach something else entirely one day **without
any app already written having to change a line**.

That is a property engineered into the design, not a roadmap — nobody is building a browser
engine, and nothing in this MVP depends on anyone ever doing so. It costs nothing extra now, and
it means apps written this year aren't thrown away if the thing underneath them changes.

If you want to know what Orivon actually is, read those seven files before anything else.
[`ARCHITECTURE.md`](ARCHITECTURE.md) explains how they fit together, and which design choices
were deliberate.

## Where to go next

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit, in five minutes |
| [`docs/README.md`](docs/README.md) | The documentation index — three tracks, pick one |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the rules, how to get a change merged |

The long-term vision lives in a separate repository,
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs) (deployed at docs.orivonstack.com).
This repository is deliberately narrower: it is the MVP, and
[`docs/mvp-scope.md`](docs/mvp-scope.md) says what is in it and what is not.

## Known limitations of v0

Stated here rather than discovered later. All of these are real and none is a bug:

- **MP4/H.264 video only.** MSE cannot demux Matroska and neither can Chromium's `<video>`, so
  MKV has no path without a remuxer. Deferred, not forgotten.
- **Swarm peers see your IP address.** There is no Tor integration. Protocol encryption defeats
  ISP traffic shaping — it is *obfuscation, not privacy*, and it will never be described as
  anything else.
- **Seeding behind NAT is reduced.** No UPnP in v0, so no automatic port forwarding.
- **Local peer discovery is unavailable.** The manifest grammar has no multicast bind.
- **Text typed in the address bar that isn't an address goes to DuckDuckGo.** Your search text
  leaves your machine. A privacy-branded browser should say that out loud rather than bury it.

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Davide Martinico.

Use it, fork it, build on it. If you ship a modified version, say what you changed.
