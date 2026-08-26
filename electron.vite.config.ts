import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve(root, 'src/main/index.ts') }
    }
  },
  preload: {
    build: {
      // CommonJS by default, which is what a sandboxed preload requires --
      // it has no ESM context and loads electron via require. See the note
      // in src/main/index.ts.
      //
      // Two preloads, different privilege (build step 1, this session's
      // plan): `app` is loaded by every ordinary tab and exposes only
      // `orivon.version`; `shell` is loaded ONLY by the chrome view and
      // exposes tab commands. Keys match the output filenames window.ts
      // and tabs.ts reference (`../preload/app.js`, `../preload/shell.js`).
      //
      // APPEND POINT. One line per entry, so a stream adding a preload adds
      // one key and touches nothing else in this file.
      // Ownership: docs/development/parallel-work.md.
      rollupOptions: {
        input: {
          app: resolve(root, 'src/preload/app.ts'),
          shell: resolve(root, 'src/preload/shell.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') }
    },
    resolve: {
      // Populated by the week-0 spike, Task 3.
      //
      // These aliases must beat webtorrent's `browser` field, which maps
      // `net`, `bittorrent-dht`, `ut_pex`, `./lib/conn-pool.js` and
      // `./lib/utp.cjs` to `false`. Left alone, the renderer bundle is
      // WebRTC-only -- which is Brave parity, and the exact thing ADR-0001
      // reason 3 exists to beat.
      //
      // Deliberately NOT aliased: `@thaunknown/simple-peer` and
      // `webrtc-polyfill` keep browser resolution, so the renderer uses
      // Chromium's native WebRTC and node-datachannel never enters the tree.
      //
      // APPEND POINT, owned by the `shim` stream (build step 3). No other
      // stream writes to this map. Ownership: docs/development/parallel-work.md.
      alias: {}
    }
  }
})
