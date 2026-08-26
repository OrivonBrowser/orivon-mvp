# `apps/torrent/` — the flagship

**What lives here.** The BitTorrent streaming app: `webtorrent` over the shim, player UI,
magnet input, file list, resume. This is journey 1, the clip, and the distribution asset
([`ADR-0001`](../../docs/decisions/ADR-0001-flagship-app-bittorrent-streaming.md)).

**What it depends on.** [`src/contracts/`](../../src/contracts/) for types, and `orivon.*` at
runtime — the same interface any third-party app uses.

**What it must never import.** Anything under `src/` at runtime. It is an ordinary
URL-delivered app and **holds zero silent privileges**. If it needs a privileged path that a
third-party app could not take, the thesis is untested.

**Owner stream.** `torrent-app` — build step 5.

**Ships as a pre-built app asset, never a shell dependency.** `webtorrent` reaches
`node-datachannel` through `@thaunknown/simple-peer -> webrtc-polyfill`, which needs CMake and
a C++ toolchain. That is a hard, non-optional dependency, and it would break run-from-source on
Windows and macOS — [`CLAUDE.md`](../../CLAUDE.md) Rule 8. Keeping it out of the shell's
`package.json` is what makes `npm run check:natives` pass.

**Two v0 facts that shape the code:**
- **MP4/H.264 only.** MSE cannot demux Matroska and neither can Chromium's `<video>`. Stated
  in-product, not hidden.
- Media is served to `<video>` over webtorrent's Service-Worker `createServer({ controller },
  'browser')` — **the second argument is required**, or webtorrent may pick its Node
  implementation in the renderer and try to open a real listening socket.
