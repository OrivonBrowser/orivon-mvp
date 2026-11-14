# Bundling a Node dependency graph into a renderer

The live alias map is generated from `src/shim/module-map.ts` (`src/shim/README.md`), and a port bundles with
`src/shim/bundler/`. The recipe below is what the week-0 spike measured, with the reason for each row, so a row is not
removed without knowing what it stops. Its reference implementations are `spike/gate1a/vite.config.js` and
`spike/gate1b/vite.config.js`, and neither carries the whole list: gate 1b has the DHT, `crypto`, `stream`,
`string_decoder` and `util` entries over a stub `./mse.js`; gate 1a has the `webtorrent` alias and `ORIVON_MSE=1`,
which swaps the stub for the real `mse.js`. The table is their union.

webtorrent's `browser` field maps `net`, `bittorrent-dht`, `ut_pex`, `conn-pool`, `crypto`, `fs`, `http`, `os` and
more to `false`, which makes it WebRTC-only, precisely the outcome `ADR-0001` reason 3 exists to defeat. Beating this
needs a specific, non-obvious set of Vite aliases.

| Alias target | Replacement | Why |
|---|---|---|
| `net` | the spike's `shim/net.js`; live: `src/shim/net/net.ts` | **The load-bearing one.** webtorrent's `torrent.js` refuses all TCP unless `typeof net.connect === 'function'`. Must also export `isIP`/`isIPv4`/`isIPv6` (see `webtorrent-and-node-deps.md`). |
| `dgram` | the spike's `shim/dgram.js`; live: `src/shim/net/dgram.ts` | Only if DHT is needed. An `EventEmitter`, not a stream: `bind()`, `send(msg, port, host, cb)`, `'message'`/`'listening'`/`'error'` events. `address()` must be **synchronous**, so cache it from the `'listening'` broker message rather than round-tripping. |
| `./mse.js` | real `bittorrent-protocol/mse.js` | Protocol encryption. **Use the real file, not a stub** (see `webtorrent-and-node-deps.md`). |
| `crypto` | `crypto-browserify` | Needed by both MSE and DHT node-ID hashing. Pure JS. |
| `stream`, `string_decoder` | `stream-browserify`, its own polyfill | `crypto-browserify`'s `Hash` extends `cipher-base`, which extends `stream.Transform`. Skip these and the failure reads `Cannot read properties of undefined (reading 'call')` deep inside the hash constructor, naming neither `stream` nor `crypto`. |
| `path` | `path-browserify` | Genuinely **called** at runtime (`webtorrent/index.js` uses `path.basename`). Skipping it produces the most misleading error in this list (below). |
| `events`, `buffer`, `process`, `util` | their respective browser polyfills | Named imports from Vite's empty externalized-module stub are hard build errors, not warnings. The DHT stack (`k-bucket`, `k-rpc`) calls `util.inherits` at module scope. |
| `bittorrent-dht` | real package, or a disabled stub | Pure JS, no native deps. Stub it (export `Client: undefined`) when a gate doesn't need DHT: `torrent-discovery` checks `typeof DHT !== 'function'` and disables gracefully, exactly matching webtorrent's own browser-build behaviour. |
| `webtorrent`, `streamx` | resolve into the isolated app tree | webtorrent is a pre-built **app asset**, never a shell dependency (Rule 8); see `webtorrent-and-node-deps.md`. One `streamx` instance is shared between the shim and webtorrent, or `pipeline()` joins two stream implementations. |

`@thaunknown/simple-peer` and `webrtc-polyfill` stay **unaliased**, so they keep browser resolution and the renderer
uses Chromium's native WebRTC; `node-datachannel` never enters the bundle.

Also mandatory:
- **`base: './'`** in the Vite config. The default `/` resolves to the filesystem root under `file://`, giving a
  blank page with `ERR_FILE_NOT_FOUND`.
- **A `globals.js` shim, imported FIRST**, before any other import in the renderer entry point. A sandboxed renderer
  has no `process`/`global`/`Buffer`, and several dependencies read them at *module-evaluation time*, not lazily:
  import order matters.
- **A `package.json` in the app directory.** Electron cannot find the app without one, even for a throwaway test
  harness.
- **`sw.min.js` (for the Service-Worker media path) must be copied into `dist/` after every build.** Vite does not
  include it automatically: it is fetched dynamically by `navigator.serviceWorker.register()`, not referenced from
  HTML, so Vite's asset pipeline never sees it. The real path is `node_modules/webtorrent/dist/sw.min.js`: note the
  `dist/`; a path without it looks plausible and fails as a silent 404.

## A missing `path` polyfill: when an error names the wrong thing entirely

A missing `path` alias does not produce a "cannot find module 'path'" error. It produces:

```
ConnPool.join is not a function
```

Rollup externalizes an unresolved Node builtin to an empty object, and it does this for `conn-pool.js` (webtorrent's
own module, correctly browser-excluded) as well as for `path` (which Vite doesn't know is needed). **Rollup gives both
the same generated identifier**, so the error names `ConnPool` when the real problem is `path`. **When a Rollup/Vite
build error names something that makes no sense given the code you wrote, `grep` the built bundle
(`dist/assets/*.js`) around the line number in the stack trace**: do not trust the symbol name alone.
