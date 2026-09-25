# Orivon

**A browser that runs applications Chrome cannot.**

A web page can't open a TCP socket, join a DHT, or write a file to your disk. That is the
sandbox doing its job, and it is why some software has to be a desktop app even when it has no
business being one.

Orivon changes the terms. An app is still an ordinary web frontend delivered from a URL, but it
declares what it needs in a manifest, and you grant it, per app, in plain words. The prompt says
*"connect to any computer on the internet"*, not "orivon.example.com wants to use your network".
No capability is implicit, and nothing an app didn't declare can ever be granted, even by you.

The proof is ordinary desktop apps running from a URL. FreeTube and Element are Electron apps;
in Orivon each one is an address. Open it, approve one prompt, and it runs in a tab with the
network access its desktop version had: no client installed, no extension, no native helper, and
no fork of the app.

> ### Status: pre-alpha. Nothing is released.
>
> Build steps 1 to 4 of 10 are done: the browser shell, the capability broker, the Node shim
> and the app loader. Orivon can hold per-app permissions and enforce them over network, TLS and
> filesystem access, and it can run Node programs inside a tab.
>
> Visiting a page that declares itself an app triggers discovery, fetch, hash-pinning and
> caching automatically; a person is asked once, in plain words, what the app may do; accepting
> installs it, and later visits are served from local cache with the network unplugged. When the
> site publishes its bundle's hash tree, the site-info popover shows whether the installed files
> match it (DDOC). A first visit can still see an early permission check denied before that
> one-time dialog has been answered, which is bounded to the first visit only and not yet closed.
>
> Build step 5 is under way: FreeTube, Element, AirGap Vault and ASGARDEX are ported in
> [orivon-ports](https://github.com/OrivonBrowser/orivon-ports) and run from a local developer
> origin. There is no packaged build, no installer, and no release. See
> [`docs/planning/build-plan.md`](docs/planning/build-plan.md) for the order of work,
> [`docs/planning/compatibility-matrix.md`](docs/planning/compatibility-matrix.md) for what
> works cell by cell, and [`CHANGELOG.md`](CHANGELOG.md) for what has landed.

## Try it

```bash
git clone https://github.com/OrivonBrowser/orivon-mvp.git
cd orivon-mvp
npm install
npm run dev
```

No compiler is needed on Linux, Windows, or macOS. That is deliberate, and a check fails the
build if any dependency needs one: Windows and macOS are supported through running from source
rather than signed installers, and an `npm install` that demands Visual Studio Build Tools would
be a worse obstacle than the certificate it avoids.

Full prerequisites and the one environment trap worth knowing about:
[`docs/development/setup.md`](docs/development/setup.md).

## What's different

| | |
|---|---|
| **Capabilities are per app, declared, and granted by you** | An app gets what its manifest declares *and* you approve. Absence from the manifest means absence, never default-allow |
| **Apps come from a URL, not a store** | Visit the address; there is nothing else to choose. The code is fetched, cached and hash-pinned automatically, then you're asked once, up front, what it may do. No review process, no gatekeeper, no account |
| **Your data stays on your machine** | Per-origin isolation, local-first storage. There is no Orivon server holding user data, because there is no Orivon server |
| **Names and content you can check** | A `.eth` name is resolved on your machine and proved against the Ethereum chain, and IPFS content is checked against its hash. The servers along the way supply data; none of them is trusted to be right |

## How this relates to Web3

Orivon is aimed at one problem: decentralised protocols are hard to *use* because the browser
refuses to speak them. A web page cannot open a BitTorrent connection, cannot join a DHT, cannot
hold a signing key, cannot talk to a node over a raw socket. So every "Web3" app in a browser
today routes through something centralised to compensate: an RPC provider, a gateway, a hosted
indexer, a wallet extension. The decentralised protocol is real; the path your browser takes to
reach it usually isn't.

That is a browser limitation, not a protocol limitation. Orivon removes it: the page gets the
capability, under a permission you granted, so a decentralised app can just be a web page.

Two things in this MVP demonstrate it:

- Desktop apps in a tab. Node.js and Electron apps that needed a desktop client to reach the
  network run from a URL instead, under permissions you granted.
- Names and content with no trusted server. `name.eth` is resolved by a light client on your
  machine, and IPFS content is verified block by block, so no RPC provider or gateway is trusted
  for correctness. It is trust-minimised rather than trustless: the root is a chain checkpoint,
  and the servers can still withhold.

**What is not in this MVP.** These are scope boundaries for *this month's build*, not statements
about where Orivon is going. The difference matters, so it is spelled out:

- **No funds movement.** An app can hold a signing key the browser derives for it
  (`orivon.id`), which the project calls a Web3 Account. It holds no funds, shows no seed
  phrase, and cannot send or receive. The wallet is a long-term goal rather than a rejected idea: the design
  has three layers (Accounts, Crypto, Address book), and this MVP ships only the first. The
  other two need a meaningfully different security model and come later.
- **No torrent client and no Nostr identity.** Both are ideas the project may come back to, and
  neither is scheduled in this build.
- **No token, chain, DAO or governance *in the product*.** Orivon does have a
  [DAO plan](https://github.com/OrivonBrowser/orivon-docs): treasury, merit-tracked
  contribution, the lot. It is organisational rather than a browser feature, so it lives outside
  this repository entirely. You will not find it here, and its absence here says nothing about
  whether it is happening.

The longer framing, in the project's own words, is *Web4*: easy interfaces to **use** Web3, in
the way Web2 gave easy interfaces to read and write Web1. That vision, including the wallet
layers and the DAO, lives in
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs). This repository is deliberately
narrower than the vision: it is one testable claim, tested first.

## Roadmap

**In this MVP.** [`docs/planning/build-plan.md`](docs/planning/build-plan.md) has the detail.
Strictly dependency-ordered; each step needs the one before it.

| | Step | State |
|---|---|---|
| 0 | Feasibility spike: can a renderer really run a torrent client? | **done** ([verdict](docs/planning/spike-verdict.md)) |
| 1 | **Shell**: tabs, omnibox, back/forward, window chrome | **done** |
| 2 | **Capability broker**: manifests, grants, per-origin enforcement | **done**, including per-app session partitions; `net.listen` now reaches a page too ([A114](docs/open-questions.md), resolved) |
| 3 | **Node shim**: `net`, `dgram`, `fs` over `orivon.*` | **done**, plus `http`/`https`, the core polyfills, `net.createServer` and `dns.lookup` over real broker capabilities ([A114](docs/open-questions.md)/[A107](docs/open-questions.md), both resolved) |
| 4 | **App loader**: manifest discovery, fetch, cache, hash-pinning, DDOC | **done**: discovery, fetch, caching, hash-pinning, the update decision, DDOC and the served bundle's CSP are all reachable from a real page behind a real, one-time consent dialog. The folder picker (`fs.userSelected`) is a separate, still-unbuilt capability; see the compatibility matrix |
| 5 | **Node.js apps**: real desktop apps, ported to run from a URL, as the platform's test cases | **under way** in [orivon-ports](https://github.com/OrivonBrowser/orivon-ports): FreeTube, Element, AirGap Vault, ASGARDEX |
| 6 | **ENS and IPFS**: `.eth` names and IPFS content, verified on your machine rather than trusted to a server | **done**: a `.eth` name loads from IPFS, its name proven by a light client and every byte checked against its CID, and installs like any app ([`ADR-0030`](docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md)). One check is left: a run from source on Windows and macOS with the light client in the tree |
| 7 | **Trust indicator**: what an app actually did, and what a score provider judged, never a bare grade | groundwork in [`src/trust/`](src/trust/) |
| 8 | **Telemetry**: with the first-run disclosure | groundwork in [`src/telemetry/`](src/telemetry/) |
| 9 | **Developer mode**: load an unpacked app | |
| 10 | **Packaging**: AppImage and deb | |

**Deliberately deferred.** These are choices, not oversights, and every one of them is still on
the long-term plan ([`docs/mvp-scope.md`](docs/mvp-scope.md)): DDOC anchored in DNS · Arweave as
a delivery path · an app store · the wallet's Crypto and Address-book layers · identity export
and backup · `subprocess` and `hid` capabilities · signed Windows and macOS installers.

**Ideas, not scheduled:** a BitTorrent streaming app · Nostr identity (`window.nostr` across
every client).

**Longer term, and not scheduled:** a WebAssembly runtime for containing untrusted apps ·
mobile · Tor and proxy chains · cross-device sync. A browser-engine fork is a hypothesis about
where this could eventually go. Nobody is working on it, and nothing here depends on it
happening.

*This roadmap covers the product. Orivon's organisational plans (the DAO, the treasury,
contribution and token distribution) are real, and they live in
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs) rather than here, because they are
not browser features.*

## The idea underneath

This repository is an Electron app, and it is meant to be replaceable. The thing built to last
is the *interface* apps are written against: seven files of TypeScript types in
[`src/contracts/`](src/contracts/), with no implementation in them at all.

An app calls `orivon.net.connect()`. Today that reaches a Node socket in an Electron main
process. The interface is designed so it could reach something else entirely one day without any
app already written having to change a line.

That is a property engineered into the design rather than a roadmap: nobody is building a
browser engine, and nothing in this MVP depends on anyone ever doing so. It costs nothing extra
now, and it means apps written this year aren't thrown away if the thing underneath them
changes.

If you want to know what Orivon actually is, read those seven files before anything else.
[`ARCHITECTURE.md`](ARCHITECTURE.md) explains how they fit together, and which design choices
were deliberate.

## Where to go next

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit, in five minutes |
| [`docs/README.md`](docs/README.md) | The documentation index: three tracks, pick one |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the rules, how to get a change merged |

The long-term vision lives in a separate repository,
[orivon-docs](https://github.com/OrivonBrowser/orivon-docs) (deployed at docs.orivonstack.com).
This repository is deliberately narrower: it is the MVP, and
[`docs/mvp-scope.md`](docs/mvp-scope.md) says what is in it and what is not.

## Known limitations of v0

Stated here rather than discovered later. All of these are real and none is a bug:

- **Peers see your IP address.** There is no Tor integration, so a peer-to-peer app connects
  from your real address.
- **No automatic port forwarding.** There is no UPnP in v0, so behind NAT an app listening for
  peers is reachable only through a port you forward yourself.
- **Local peer discovery is unavailable.** The manifest grammar has no multicast bind.
- **Text typed in the address bar that isn't an address goes to DuckDuckGo.** Your search text
  leaves your machine. A privacy-branded browser should say that out loud rather than bury it.
- **Every launch contacts Ethereum servers, and `.eth` lookups tell servers what you open.** The
  light client that proves `.eth` names starts at launch and follows the chain through
  `ethereum-beacon-api.publicnode.com` and one of three RPCs (`eth.drpc.org`, `rpc.mevblocker.io`,
  `ethereum-rpc.publicnode.com`): about 20 MB an hour, whether or not you open a `.eth` name.
  Opening one tells those RPCs the name, the IPFS gateways (`trustless-gateway.link`,
  `ipfs.orbitor.dev`, `ipfs.filebase.io`) the content, and, for some names, `name.web3.storage`,
  a DNS-over-HTTPS resolver (`cloudflare-dns.com`, `dns.google`) or a server the name's own
  resolver chooses. None of them is trusted for correctness, and Settings lists them all.
  `ORIVON_ETH_LIGHT_CLIENT=off` switches it off for a run, and then no `.eth` name loads.
- **A first-ever visit to an app can see an early permission check answered "no" before you've
  answered the one-time install prompt.** The app's own code can start running before that
  dialog resolves. Every visit after the first is unaffected: the grant is already held, and
  nothing is asked again ([A146](docs/open-questions.md)).

## Licence

[AGPL-3.0-only](LICENSE). Copyright (C) 2026 Davide Martinico.

Use it, fork it, build on it. If you distribute a modified version, or let others
use one over a network, its complete source goes out under the same licence.
