import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'electron-vite'
import { build, normalizePath, type Plugin } from 'vite'
import { aliasPattern, buildAliasEntries } from './src/shim/module-map.js'

const root = dirname(fileURLToPath(import.meta.url))

/** The name src/preload/page-buffer.ts's installer reads the `buffer` package through. */
export const BUFFER_PACKAGE_PLACEHOLDER = '__ORIVON_BUFFER_PACKAGE__'
const PAGE_BUFFER_SOURCE = normalizePath(resolve(root, 'src/preload/page-buffer.ts'))

/** One expression evaluating to the `buffer` package's exports: the copy the shim's own `buffer` module imports, bundled whole. */
async function bufferPackageExpression (): Promise<string> {
  const entry = createRequire(resolve(root, 'src/shim/polyfills/buffer.ts')).resolve('buffer/')
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['iife'], name: 'bufferPackage' },
      rollupOptions: { output: { exports: 'named' } }
    }
  })
  const chunk = [result].flat().flatMap((out) => 'output' in out ? out.output : [])[0]
  if (chunk?.type !== 'chunk') throw new Error('bundling the buffer package produced no chunk')
  return `(function () {\n${chunk.code}\nreturn bufferPackage.default\n})()`
}

/**
 * Inlines the `buffer` package into src/preload/page-buffer.ts's installer,
 * which contextBridge.executeInMainWorld serialises alone. Fails the build
 * rather than ship the placeholder, which the page would meet as a
 * ReferenceError.
 */
export function pageBufferPackage (): Plugin {
  let expression: Promise<string> | undefined
  return {
    name: 'orivon:page-buffer-package',
    enforce: 'post',
    async transform (code, id) {
      if (normalizePath(id.split('?')[0] ?? id) !== PAGE_BUFFER_SOURCE) return null
      const uses = code.split(BUFFER_PACKAGE_PLACEHOLDER).length - 1
      if (uses !== 1) throw new Error(`${PAGE_BUFFER_SOURCE} must name ${BUFFER_PACKAGE_PLACEHOLDER} exactly once, not ${String(uses)} times`)
      expression ??= bufferPackageExpression()
      const inlined = await expression
      // A function, not the string: a replacement string expands `$&` and `$'` found in the package's source.
      return { code: code.replace(BUFFER_PACKAGE_PLACEHOLDER, () => inlined), map: null }
    }
  }
}

// electron-vite 5's isolatedEntries reporter (preload, below) calls
// process.stdout.clearLine()/cursorTo()/moveCursor() unconditionally, and
// they exist only on a TTY, so every piped build (CI, `npm run smoke`)
// crashes. Stub only the missing ones, so a real terminal is untouched. A
// `script`/pty wrapper would break Windows, a run-from-source platform.
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
    // Maps the virtual specifiers electron-chrome-extensions-lib.d.ts
    // declares to the real vendored files, for BUNDLING only -- tsc never
    // sees this file, so it resolves those specifiers through the .d.ts's
    // ambient declarations instead of opening the real, more loosely typed
    // vendor source (that file's own header has the full reasoning).
    resolve: {
      alias: {
        'orivon:crx-extensions': resolve(root, 'vendor/electron-chrome-extensions/src/browser/index.ts'),
        'orivon:crx-extensions-partition': resolve(root, 'vendor/electron-chrome-extensions/src/browser/partition.ts'),
        'orivon:crx-extensions-router': resolve(root, 'vendor/electron-chrome-extensions/src/browser/router.ts')
      }
    },
    // Folds src/main/dev-grant.ts's compiled-in flag to a literal boolean --
    // `false` unless ORIVON_ENABLE_DEV_GRANT=1 was set (scripts/build-e2e.mjs
    // is the only caller that sets it) -- so the production minifier can
    // remove that file's contents from an ordinary build entirely, rather
    // than merely leaving a runtime check unreachable. See dev-grant.ts's own
    // header and scripts/check-dev-grant-absent.mjs, which proves this
    // against the actual compiled output.
    define: {
      __ORIVON_DEV_GRANT_ENABLED__: JSON.stringify(process.env.ORIVON_ENABLE_DEV_GRANT === '1')
    },
    build: {
      // Two processes: the shell, and the verifier host it forks as a
      // utility process (src/protocols/verifier-host/). Keys are the output names in
      // out/main/, which src/main/verifier/ forks by name.
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          'verifier-host': resolve(root, 'src/protocols/verifier-host/entry.ts')
        }
      },
      // Dependencies stay external, loaded from node_modules at run time,
      // except these ESM-only packages: this CommonJS output cannot require()
      // them, so they are bundled into whichever entry imports them instead.
      // `pbf` (extensions/crx.ts, vendor/electron-chrome-web-store's CRX3
      // reader) is `"type": "module"` -- measured: left external, a real
      // build's `new Pbf(...)` throws "Pbf is not a constructor" at runtime,
      // never caught by typecheck or a plain-vitest unit test, only a real
      // Electron launch.
      externalizeDeps: { exclude: ['multiformats', '@ipld/dag-pb', 'ipfs-unixfs', 'ipfs-unixfs-exporter', 'ipns', 'pbf'] }
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
    plugins: [pageBufferPackage()],
    build: {
      // CommonJS, which a sandboxed preload requires: it has no ESM context
      // and loads electron via require (see src/main/index.ts).
      //
      // One entry per privilege level: `app` for every ordinary tab, `shell`
      // for the chrome view only, `newtab` for a fresh tab only,
      // `settings`/`site-info` for the toolbar popups (those four re-check
      // their own URL before exposing anything), `embed` for a page an app
      // shows inside itself. Keys are
      // the output filenames src/main/ loads (`../preload/<key>.js`). APPEND
      // POINT: one line per entry (docs/development/parallel-work.md).
      rollupOptions: {
        input: {
          app: resolve(root, 'src/preload/app.ts'),
          shell: resolve(root, 'src/preload/shell.ts'),
          newtab: resolve(root, 'src/preload/newtab.ts'),
          permissions: resolve(root, 'src/preload/permissions.ts'),
          internal: resolve(root, 'src/preload/internal.ts'),
          'site-info': resolve(root, 'src/preload/site-info.ts'),
          menu: resolve(root, 'src/preload/menu.ts'),
          'split-frame': resolve(root, 'src/preload/split-frame.ts'),
          embed: resolve(root, 'src/preload/embed.ts'),
          'extension-api': resolve(root, 'vendor/electron-chrome-extensions/src/preload.ts'),
          'web-store': resolve(
            root,
            'vendor/electron-chrome-web-store/src/renderer/chrome-web-store.preload.ts'
          )
        }
      },
      // Preloads share local imports (./channels.js, ./surface/orivon.js).
      // Chunked, each would require('./chunks/...'), which a sandboxed
      // preload's allowlisted require() cannot load: it throws before
      // contextBridge runs, so e.g. window.orivonShell is silently undefined.
      // isolatedEntries makes each preload one self-contained bundle, and
      // electron-vite's guide pairs it with externalizeDeps: false.
      isolatedEntries: true,
      externalizeDeps: false
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    build: {
      // `index` is the privileged chrome view; `newtab` is the dashboard,
      // ordinary tab content loaded into a tab's own WebContentsView with
      // the unprivileged (well, narrowly scoped) newtab preload -- see
      // src/main/tabs.ts's createTab(). `permissions` and `site-info` are the
      // two toolbar popups (src/main/permissions/popover-view.ts). `intro` is
      // the welcome screen, a full-window view with no preload
      // (src/main/shell/intro-view.ts). Every entry must live inside `root`
      // above (src/renderer), not beside it, or the dev server won't serve
      // it at an ordinary path.
      rollupOptions: {
        input: {
          index: resolve(root, 'src/renderer/index.html'),
          newtab: resolve(root, 'src/renderer/newtab/index.html'),
          intro: resolve(root, 'src/renderer/intro/index.html'),
          permissions: resolve(root, 'src/renderer/permissions/index.html'),
          'page-settings': resolve(root, 'src/renderer/pages/settings/index.html'),
          'page-history': resolve(root, 'src/renderer/pages/history/index.html'),
          'page-profiles': resolve(root, 'src/renderer/pages/profiles/index.html'),
          'page-private': resolve(root, 'src/renderer/pages/private/index.html'),
          'page-extensions': resolve(root, 'src/renderer/pages/extensions/index.html'),
          'site-info': resolve(root, 'src/renderer/site-info/index.html'),
          menu: resolve(root, 'src/renderer/menu/index.html'),
          'split-frame': resolve(root, 'src/renderer/split-frame/index.html')
        }
      }
    },
    resolve: {
      // Generated from src/shim/module-map.ts's SHIM_MODULE_MAP: change it
      // there. 'local' resolves against src/shim/, 'package' is an npm
      // specifier; each matches bare or `node:`-prefixed, as in vitest.config.ts.
      // They must beat webtorrent's `browser` field, which maps `net`,
      // `bittorrent-dht`, `ut_pex`, conn-pool and utp to `false` and leaves
      // the renderer WebRTC-only (ADR-0001 reason 3). Never alias
      // `@thaunknown/simple-peer` or `webrtc-polyfill`: they keep Chromium's
      // WebRTC, so node-datachannel never enters the tree.
      alias: buildAliasEntries().map(({ specifier, kind, implementation }) => ({
        find: aliasPattern(specifier),
        replacement: kind === 'package' ? implementation : resolve(root, 'src/shim', implementation)
      }))
    }
  }
})
