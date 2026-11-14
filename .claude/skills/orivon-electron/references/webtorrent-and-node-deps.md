# webtorrent and other Node dependency graphs in a renderer

## MSE works: do not assume otherwise

BitTorrent protocol encryption (MSE) runs in a renderer, although it needs Diffie-Hellman, a synchronous SHA-1 and
RC4, none of which WebCrypto usefully provides:

- `bittorrent-protocol/mse.js` already ships a **complete pure-JS RC4 fallback**, selected automatically whenever
  `crypto.createCipheriv('rc4', ...)` throws (which it does, on `crypto-browserify`). RC4 is not the blocker: the
  `nativeRC4` detection line alone suggests it is, and the fifteen lines under it are the fallback.
- The only genuinely missing pieces are `createHash('sha1')` and `createDiffieHellman`, and `crypto-browserify`
  supplies both, in pure JS.
- Verified end to end: a full encrypted handshake at `secure: 2` (RC4 required, **no** plaintext fallback) against a
  Node seeder using native crypto. A piece verified in 480 ms.

**Ship `secure: 1`** (encrypt when possible, plaintext fallback) for maximum swarm reach. Cost is real but small: the
renderer bundle grows from ~427 KB to ~1.7 MB (95 KB to 336 KB gzipped), irrelevant against Electron's ~150-200 MB
floor.

**UI honesty:** MSE is obfuscation against ISP traffic shaping, not privacy against eavesdroppers. Its DH exchange is
unauthenticated and RC4 is a broken cipher. Never present it as making torrenting private.

## A shim must mirror the whole surface a dependency touches, not the obvious methods

`bittorrent-dht`'s RPC layer calls `net.isIP(peer.host)` before every send, to decide whether to send directly or
resolve via DNS first. A `net` shim that implements `connect`, `createServer` and `Socket` (a complete-looking socket
API) but not `isIP` leaves the DHT with its listening socket bound and **sending nothing, ever**, with no error and no
warning.

It is silent because the throw happens inside a `process.nextTick` callback, and the spike's `globals.js` polyfills
`nextTick` with `queueMicrotask`. **Node's real `nextTick` surfaces an uncaught exception to the process;
`queueMicrotask` does not route into the same handlers.** A polyfill chosen for API-shape compatibility changes error
visibility in exactly the wrong direction for code whose job is partly security-relevant.

In `src/shim/`, `globals.ts` is where this is settled: an exception escaping a `nextTick` or `setImmediate` callback is
reported to a process `uncaughtException` listener, or else to the page's `reportError`. **Audit every Node timing
primitive (`nextTick`, `setImmediate`, microtask ordering) you add or change for this class of behavioural change, not
just for call-signature compatibility.** A shim that type-checks and passes a synthetic test can still be a black hole
for real dependency errors. The binding requirements are `docs/architecture/handle-contracts.md` section What the
shim must do.

## Why webtorrent isn't in the shell `package.json`

`node-datachannel` (`@thaunknown/simple-peer` to `webrtc-polyfill` to `node-datachannel`) is a **hard, non-optional**
transitive dependency of webtorrent. Its install script is:

```
prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)
```

It tries a prebuild and **falls back to compiling with CMake** when no prebuild matches the platform/ABI: exactly the
Rule 8 threat (breaks `npm install` on a machine without a C++ toolchain, i.e. most contributors on Windows/macOS).
Rule 8 bounds this repository's `npm install`, never the apps Orivon runs (ADR-0036). So webtorrent lives in the
isolated `spike/app/` with its own `package.json`, never installed at the shell level. The built renderer bundle
contains zero `node-datachannel` references (grep `dist/assets/*.js`), because `@thaunknown/simple-peer` and
`webrtc-polyfill` are deliberately left **unaliased**, so the renderer uses Chromium's native WebRTC instead.

`npm install --omit=optional` is **not a safe install mode** for the shell tree: it skips Rollup's platform-specific
native binary (itself an optional dependency the build genuinely needs) and the build crashes with
`MODULE_NOT_FOUND`. `check:natives` passes under either install mode (correctly: a missing prebuilt binary isn't a
Rule 8 violation), so the guard alone will not catch this. Contributors and CI must use a plain `npm install`.
