import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const appModules = resolve(here, '../app/node_modules')

export default defineConfig({
  root: here,
  // Relative, because the page is loaded over file:// by loadFile(). Vite's
  // default base of '/' emits /assets/... which resolves to the FILESYSTEM
  // ROOT under file://, giving ERR_FILE_NOT_FOUND and a blank page.
  base: './',
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(here, 'index.html') },
    // Keep it readable: the gate inspects the bundle for node-datachannel.
    minify: false
  },
  resolve: {
    alias: [
      // THE LOAD-BEARING LINE. webtorrent's `browser` field maps `net` to
      // false, which makes torrent.js:2104 bail out and leaves a WebRTC-only
      // client -- Brave parity, and precisely what ADR-0001 reason 3 exists
      // to beat. This alias is what turns it back into BitTorrent.
      { find: /^net$/, replacement: resolve(here, 'shim/net.js') },

      // bittorrent-protocol browser-excludes ./mse.js but still imports named
      // bindings from it, which Rollup treats as a build error where
      // browserify did not. Required for ANY Vite-built webtorrent bundle,
      // unrelated to the net alias. See shim/mse-stub.js.
      { find: /^\.\/mse\.js$/, replacement: resolve(here, 'shim/mse-stub.js') },

      // Pure-JS polyfills for the Node builtins webtorrent's dependency graph
      // still imports in a browser build. Vite externalizes these to an empty
      // stub, and a named import from that stub is a Rollup build error --
      // the same failure shape as mse.js above. All three are pure JS, so
      // Rule 8 is unaffected.
      { find: /^events$/, replacement: resolve(appModules, 'events/events.js') },
      // `path` is genuinely CALLED at runtime (webtorrent/index.js uses
      // path.basename when naming a torrent from a file). Without it Rollup
      // externalizes path to an empty object AND -- because it does the same
      // for conn-pool.js -- gives both the same generated identifier, so the
      // failure surfaces as the baffling "ConnPool.join is not a function".
      { find: /^path$/, replacement: resolve(appModules, 'path-browserify/index.js') },
      { find: /^buffer$/, replacement: resolve(appModules, 'buffer/index.js') },
      { find: /^process$/, replacement: resolve(appModules, 'process/browser.js') },

      // GATE 1a ONLY. Gate 1b swaps this for the real bittorrent-dht over a
      // shimmed dgram. See shim/dht-disabled.js.
      { find: /^bittorrent-dht$/, replacement: resolve(here, 'shim/dht-disabled.js') },

      // webtorrent lives in the app tree, not the shell tree (Rule 8).
      { find: /^webtorrent$/, replacement: resolve(appModules, 'webtorrent/index.js') },
      // Share ONE streamx instance between the shim and webtorrent, or
      // pipeline() would be joining two different stream implementations.
      { find: /^streamx$/, replacement: resolve(appModules, 'streamx/index.js') }
    ]
  }

  // Deliberately NOT aliased: @thaunknown/simple-peer and webrtc-polyfill keep
  // browser resolution, so Chromium's native WebRTC is used and
  // node-datachannel never enters the bundle. Gate 2 verifies that.
})
