import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const appModules = resolve(here, '../app/node_modules')

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
      // THE LOAD-BEARING LINE FOR THIS GATE. webtorrent's browser field maps
      // bittorrent-dht to false; here we use the REAL package (pure JS, no
      // native deps) and give it a shimmed dgram to speak through.
      { find: /^dgram$/, replacement: resolve(here, 'shim/dgram.js') },
      { find: /^bittorrent-dht$/, replacement: resolve(appModules, 'bittorrent-dht/index.js') },

      // Carried over from gate 1a. See spike/gate1a/vite.config.js.
      { find: /^net$/, replacement: resolve(here, 'shim/net.js') },
      { find: /^\.\/mse\.js$/, replacement: resolve(here, 'shim/mse-stub.js') },
      // bittorrent-dht calls crypto.createHash for node IDs and infohashes.
      // Pure JS, so Rule 8 is unaffected -- the same alias that makes MSE work.
      { find: /^crypto$/, replacement: resolve(appModules, 'crypto-browserify/index.js') },
      // crypto-browserify's Hash extends cipher-base, which extends
      // stream.Transform. Without these two, Transform is undefined and the
      // failure reads "Cannot read properties of undefined (reading 'call')"
      // from deep inside the hash constructor -- naming neither `stream` nor
      // `crypto`.
      { find: /^stream$/, replacement: resolve(appModules, 'stream-browserify/index.js') },
      { find: /^string_decoder$/, replacement: resolve(appModules, 'string_decoder/lib/string_decoder.js') },
      { find: /^events$/, replacement: resolve(appModules, 'events/events.js') },
      // The DHT stack (k-bucket / k-rpc) calls util.inherits at module scope.
      { find: /^util$/, replacement: resolve(appModules, 'util/util.js') },
      { find: /^path$/, replacement: resolve(appModules, 'path-browserify/index.js') },
      { find: /^buffer$/, replacement: resolve(appModules, 'buffer/index.js') },
      { find: /^process$/, replacement: resolve(appModules, 'process/browser.js') },
      { find: /^streamx$/, replacement: resolve(appModules, 'streamx/index.js') }
    ]
  }
})
