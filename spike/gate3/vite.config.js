import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const appModules = resolve(here, '../app/node_modules')

// GATE 3: does MP4/H.264 play with seeking?
//
// No DHT here -- the fixture torrent is played by explicit peer address
// against a local seeder (same pattern as gate 1a), so bittorrent-dht is
// stubbed disabled rather than wired to a real dgram, exactly as gate 1a did.
//
// Protocol encryption is ON, not stubbed. Gate 1a proved `secure: 2` (RC4
// required, no plaintext fallback) works end to end through crypto-browserify,
// so gate 3 uses the real mse.js unconditionally rather than gating it behind
// an env var -- this is what v0 should actually ship.
export default defineConfig({
  root: here,
  // Vite's default '/' resolves to the filesystem root under file://.
  base: './',
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(here, 'index.html') },
    minify: false
  },
  resolve: {
    alias: [
      // THE LOAD-BEARING LINE. webtorrent's browser field maps `net` to
      // false, which makes torrent.js:2104 bail out and leaves a WebRTC-only
      // client. This shim also exports isIP/isIPv4/isIPv6 -- its absence
      // silently disabled the DHT's sends in gate 1b.
      { find: /^net$/, replacement: resolve(here, 'shim/net.js') },

      // No DHT in this gate -- see file header.
      { find: /^bittorrent-dht$/, replacement: resolve(here, 'shim/dht-disabled.js') },

      // MSE (protocol encryption), ON by default in this gate.
      { find: /^\.\/mse\.js$/, replacement: resolve(appModules, 'bittorrent-protocol/mse.js') },
      { find: /^crypto$/, replacement: resolve(appModules, 'crypto-browserify/index.js') },
      // crypto-browserify's Hash extends cipher-base, which extends
      // stream.Transform. Without these two, Transform is undefined and the
      // failure reads "Cannot read properties of undefined (reading 'call')"
      // from deep inside the hash constructor -- naming neither `stream` nor
      // `crypto`.
      { find: /^stream$/, replacement: resolve(appModules, 'stream-browserify/index.js') },
      { find: /^string_decoder$/, replacement: resolve(appModules, 'string_decoder/lib/string_decoder.js') },

      // Named imports from Vite's empty externalized-module stub are hard
      // build errors, not warnings.
      { find: /^events$/, replacement: resolve(appModules, 'events/events.js') },
      { find: /^util$/, replacement: resolve(appModules, 'util/util.js') },
      { find: /^path$/, replacement: resolve(appModules, 'path-browserify/index.js') },
      { find: /^buffer$/, replacement: resolve(appModules, 'buffer/index.js') },
      { find: /^process$/, replacement: resolve(appModules, 'process/browser.js') },

      // App-asset tree, never the shell tree (Rule 8).
      { find: /^webtorrent$/, replacement: resolve(appModules, 'webtorrent/index.js') },
      { find: /^streamx$/, replacement: resolve(appModules, 'streamx/index.js') }
    ]
  }
})
