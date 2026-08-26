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

## The idea underneath

The durable thing here is **the interface**, not the browser.

Apps call `orivon.net.connect()`. Underneath, today, that's a Node socket in an Electron main
process. Later it's a Wasmtime host function. Later still it's Mojo IPC inside a Chromium fork.
**None of those transitions is visible to an app already written** — and that property, not any
particular engine, is what keeps the path to a real browser open.

That interface lives in [`src/contracts/`](src/contracts/): seven files, types only, no
implementation. If you want to know what Orivon actually is, read those before anything else.

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
