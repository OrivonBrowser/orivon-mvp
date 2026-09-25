# A torrent app: what is already known

**An idea, not a build step.** A BitTorrent streaming app is listed under
[`mvp-scope.md`](../mvp-scope.md) §LATER: nobody is building it, and nothing in this repository
waits on it. [`ADR-0001`](../decisions/ADR-0001-flagship-app-bittorrent-streaming.md) has the
case for building one. This page keeps what the week-0 spike and the planning around it
established, so whoever picks the idea up does not re-derive it.

The platform side is built: `net.connect`, `net.listen`, `net.udpBind` and `fs` reach a page
through the broker, and the shim runs `webtorrent`'s Node dependency graph in a renderer
([`spike-verdict.md`](spike-verdict.md), `src/shim/tests/real-bittorrent-dht.test.ts`). What is
described below is the app.

## Shape

`webtorrent` via the shim, player UI, magnet input, file list, resume. Ships as a pre-built app
asset, never as a shell dependency: `node-datachannel` is a hard transitive dependency and needs
a C++ toolchain, which breaks run-from-source ([`build-plan.md`](build-plan.md) §Platform policy).

A naive renderer bundle is **WebRTC-only**: webtorrent's `browser` field maps `net`,
`bittorrent-dht`, `ut_pex`, `utp` and `conn-pool` to `false`, which is Brave parity. The fix is
per-module resolution overrides (`ARCHITECTURE.md` §Two facts that are expensive to rediscover).

## Media path

**Serve pieces to `<video>` over a range-capable custom scheme**, not MSE and not a localhost
HTTP server. MSE would require fMP4 you do not have and forces hand-implemented seeking; a
localhost socket is `security-model.md` T15. A `protocol.handle()` streaming response, or
webtorrent's Service-Worker `createServer({ controller })`, which is renderer-local and
origin-scoped, gives seeking and track selection to Chromium for free and is **unreachable by
other local processes**, which is strictly stronger than T15's token mitigation.

**`createServer` takes a second parameter**, confirmed 2026-08-25 and documented nowhere else
in this corpus: `client.createServer(opts, force)`, where `force: 'browser' | 'node'` exists
specifically for environments that run both Node and a browser context, and Electron is named
explicitly in webtorrent's own docs as the intended use case. Without it, webtorrent may select
its Node implementation in the renderer and attempt to open a real listening socket rather than
using the Service-Worker path. Call it as `client.createServer({ controller }, 'browser')`.

Separately confirmed by the spike (`week-0-spike-plan.md` §Gate 3): Electron treats a `file://`
origin loaded via `loadFile()` as a secure context, so service worker registration for this path
needs no fallback: `navigator.serviceWorker.register(...)` succeeds without any extra scheme
registration. The `protocol.handle()` custom-scheme path remains the fallback if that changes.

**Format support is MP4/H.264 only.** MSE cannot demux Matroska and neither can Chromium's
`<video>`, so MKV has no path without a remuxer (`libav-wasm`, pure-WASM). Stock Electron ships
H.264/AAC (`proprietary_codecs = true`), so this needs no extra work; HEVC is
hardware-decode-only and therefore out.

Lift **presentation only** from `webtorrent-desktop`: control layout, keyboard shortcuts,
subtitle rendering, file-list UI. Its playback plumbing is stale (last release 2020, pinned to
Electron 27 and webtorrent 1.9.7) and points at the localhost-server + VLC-handoff design this
page rejects. Same status as `orivon-browser-v2`: **visual reference only.**

## Protocol encryption (MSE): available, and it should be ON

Measured at gate 1a. WebCrypto does not usefully provide Diffie-Hellman, a synchronous SHA-1 or
RC4, and none of that stops MSE working in the renderer:

- `mse.js` already ships a **complete pure-JS RC4 fallback**, selected whenever `nativeRC4` is
  false.
- The only missing pieces were `createHash('sha1')` and `createDiffieHellman`, and
  **`crypto-browserify` supplies both**, in pure JS, so Rule 8 is unaffected.
- Aliasing `crypto` → `crypto-browserify` and restoring the real `mse.js` produced a
  **successful encrypted handshake at `secure: 2`** (RC4 required, *no plaintext fallback*)
  against a Node seeder using native crypto. A piece verified in 479 ms.

**Cost:** the renderer bundle grows from 427 KB to 1.70 MB (95 KB → 336 KB gzipped), irrelevant
against Electron's ~150-200 MB floor, and it buys reachability with peers that require
encryption plus resistance to ISP shaping of plaintext BitTorrent.

**Recommendation: ship `secure: 1`** (encrypt, fall back to plaintext) for maximum swarm reach.
`secure: 2` also works but refuses plaintext-only peers.

**Honesty note for the UI:** MSE is *obfuscation, not privacy*. Its DH exchange is
unauthenticated and RC4 is broken; it exists to defeat traffic shaping, not eavesdroppers. It
must never be presented as making torrenting private. The IP-visibility limitation below is the
one that actually governs, and `ADR-0006` exists to prevent exactly this kind of overclaim.

## Limitations it would state in-product

- **MP4/H.264 only.**
- **Swarm peers see the user's IP.** There is no Tor in the MVP.
- **Seeding behind NAT is reduced.** No UPnP, so no automatic port forwarding.
- **Local peer discovery is unavailable.** The manifest grammar has no multicast bind.
- **UDP binds are IPv4-only**, so the DHT does not work at all on an IPv6-only network, and a
  peer reachable only over IPv6 is unreachable (`open-questions.md` A89).

## What else it would need

- **A named, pinned, well-seeded MP4/H.264 torrent** for any release check, recorded by name.
  With an unpinned torrent, pass/fail tracks that day's swarm health rather than the code.
- **`fs.quotaBytes` enforcement and the disk-usage UI** (`ADR-0003`), since a torrent is the
  likeliest way an app fills a disk.
- **Protocol routing** (`"protocols": ["magnet"]`), so a magnet link reaches the app. It is
  specified (`capability-api.md`, `security-model.md` T23) and unbuilt.
- **Brand handling** (`ADR-0001` §Consequences): never ship default content, never bundle an
  index or search, position strictly as "P2P content, self-verifying by hash".
