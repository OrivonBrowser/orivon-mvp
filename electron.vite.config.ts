import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const root = dirname(fileURLToPath(import.meta.url))

// WORKAROUND, found 2026-08-28: electron-vite 5.0.0's own `isolatedEntries`
// preload feature (used below -- see the `preload` config's own comment for
// why it's necessary) calls process.stdout.clearLine()/moveCursor()
// UNCONDITIONALLY from its build-progress reporter, with no check for
// whether stdout is a real TTY. Those methods only exist when stdout IS a
// TTY -- they are simply undefined on a plain pipe, which is exactly how
// most non-interactive shells and every CI runner invoke `npm run build`.
// The result is a hard crash (`process.stdout.clearLine is not a function`)
// on every non-interactive build, including this repo's own `npm run
// smoke`. Confirmed against electron-vite's installed source
// (dist/chunks/lib-*.js's isolateEntriesPlugin/transformReporterPlugin);
// this is electron-vite's bug, not a config mistake, and 5.0.0 is the
// latest stable release (6.x is beta-only, not appropriate to depend on
// for this reason alone). A `script`/pty wrapper would "fix" this on
// Linux/macOS but silently break Windows, a supported run-from-source
// platform (Rule 8) -- `script` doesn't exist there. Patching only the
// specific methods, only when missing, keeps real interactive terminal
// behaviour (a genuine TTY) completely untouched.
if (process.stdout.clearLine === undefined) {
  process.stdout.clearLine = () => true
}
if (process.stdout.cursorTo === undefined) {
  process.stdout.cursorTo = () => true
}
if (process.stdout.moveCursor === undefined) {
  process.stdout.moveCursor = () => true
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve(root, 'src/main/index.ts') }
    }
  },
  preload: {
    // Below `info` quiets isolatedEntries' own per-file "transforming
    // (N) path" progress line -- its documented `shouldLog` gate. The
    // stdout shim above is what actually prevents a crash (that gate
    // doesn't cover every call site electron-vite's reporter makes);
    // this just keeps the remaining, now-harmless calls from being noisy
    // in piped/CI output.
    logLevel: 'warn',
    build: {
      // CommonJS by default, which is what a sandboxed preload requires --
      // it has no ESM context and loads electron via require. See the note
      // in src/main/index.ts.
      //
      // Three preloads, different privilege (build step 1, extended
      // 2026-08-28 for the new-tab dashboard): `app` is loaded by every
      // ordinary tab and exposes only `orivon.version`; `shell` is
      // loaded ONLY by the chrome view and exposes tab commands;
      // `newtab` is loaded ONLY for a genuinely fresh tab and exposes
      // read-only bookmark access plus navigate-this-tab-only -- see its
      // own file for why it independently re-checks its own URL before
      // exposing anything. Keys match the output filenames window.ts and
      // tabs.ts reference (`../preload/app.js`, `../preload/shell.js`,
      // `../preload/newtab.js`).
      //
      // APPEND POINT. One line per entry, so a stream adding a preload adds
      // one key and touches nothing else in this file.
      // Ownership: docs/development/parallel-work.md.
      rollupOptions: {
        input: {
          app: resolve(root, 'src/preload/app.ts'),
          shell: resolve(root, 'src/preload/shell.ts'),
          newtab: resolve(root, 'src/preload/newtab.ts')
        }
      },
      // BUG (found 2026-08-28, real regression): `shell.ts` and
      // `newtab.ts` both import from `./channels.js` -- the first time two
      // preload entries had shared a local import. (No longer the sole
      // example: build step 2's IPC task has `app.ts` share `./channels.js`
      // too, plus `./orivon-surface.js` with `newtab.ts`. isolatedEntries
      // already covers both cases the same way.) Without isolatedEntries,
      // Rollup's default multi-entry
      // behaviour extracts that shared import into `chunks/channels-
      // *.js` and each preload's own output calls
      // `require('./chunks/channels-*.js')` -- but a SANDBOXED preload's
      // require() is restricted to a small Electron/Node allowlist
      // (electron, events, timers, url) and cannot load an arbitrary
      // local chunk file. It fails SILENTLY from the chrome view's own
      // perspective: shell.ts's top-level require() throws before
      // `contextBridge.exposeInMainWorld` ever runs, so `window.orivonShell`
      // is simply undefined and every click/keypress in the chrome UI
      // does nothing, with no error visible anywhere the smoke script or
      // an ordinary run would surface it (confirmed via a direct
      // window.orivonShell probe, not guessed). `isolatedEntries` is
      // electron-vite 5's own documented fix for exactly this: each
      // preload entry becomes one fully self-contained bundle again,
      // duplicating the shared code rather than chunking it --
      // `externalizeDeps: false` is paired with it per electron-vite's
      // own guide, for full bundling under isolated entries.
      isolatedEntries: true,
      externalizeDeps: false
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    build: {
      // Two entries: `index` is the privileged chrome view; `newtab` is
      // the dashboard, ordinary tab content loaded into a tab's own
      // WebContentsView with the unprivileged (well, narrowly scoped)
      // newtab preload -- see src/main/tabs.ts's createTab(). Both must
      // live inside `root` above (src/renderer), not beside it, or the
      // dev server won't serve the second one at an ordinary path.
      rollupOptions: {
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          newtab: resolve(root, 'src/renderer/newtab/index.html')
        }
      }
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
