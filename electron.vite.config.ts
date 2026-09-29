import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { defineConfig } from 'electron-vite'
import { build, normalizePath, type Plugin } from 'vite'
import { aliasPattern, buildAliasEntries } from './src/shim/module-map.js'
import { isShimSource } from './src/shim/is-shim-source.js'

export const root = dirname(fileURLToPath(import.meta.url))

/** True for a file under src/shim/ itself, never its own tests (which drive real `node:*`
 * servers and disks): vitest.config.ts's own use of `isShimSource` applies the identical rule
 * for the unit suite; kept as its own export here since electron-vite's preload build needs it
 * too, and the two configs are not one bundle. */
export function isShimImporter (importer: string | undefined): boolean {
  return isShimSource(root, importer)
}

/** The Node modules a sandboxed preload's own `require` provides (Electron's sandboxed-preload
 * docs); every other builtin a bundled package asks for fails there at load time. */
const SANDBOX_PRELOAD_MODULES = new Set(['events', 'timers', 'url'])

/** A polyfill package the shim pulls into a preload (readable-stream, for one) asks for Node
 * builtins itself: those it could not `require` in a sandbox resolve through the shim's table too. */
function isPackageImporter (importer: string | undefined): boolean {
  return importer !== undefined && importer.replace(/\\/g, '/').includes('/node_modules/')
}

/** `specifier` (bare or `node:`-prefixed) stripped to the bare form module-map.ts's table keys on. */
function bareSpecifier (specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
}

/**
 * The preload build has no aliasing of its own, unlike the renderer build's
 * `resolve.alias` below -- so shim code bundled straight into a preload
 * (`src/shim/worker/host.ts`'s own header says which, and why) needs a bare
 * Node specifier resolved through the SAME table. `config` and `resolveId`
 * split one job neither can do alone; see src/shim/worker/README.md's
 * Design notes for why both exist.
 */
export function shimNodeSpecifiers (): Plugin {
  const targets = new Map(buildAliasEntries().map((entry) => [entry.specifier, entry]))
  const isOurs = (source: string, importer: string | undefined): boolean => {
    const bare = bareSpecifier(source)
    if (!targets.has(bare)) return false
    return isShimImporter(importer) || (isPackageImporter(importer) && !SANDBOX_PRELOAD_MODULES.has(bare))
  }

  return {
    name: 'orivon:shim-node-specifiers',
    enforce: 'pre',
    config (config) {
      const build = { ...config.build, rollupOptions: { ...config.build?.rollupOptions } }
      build.rollupOptions.external = (source: string, importer: string | undefined) =>
        !isOurs(source, importer) && (source === 'electron' || source.startsWith('electron/') || isBuiltin(source))
      config.build = build
    },
    async resolveId (source, importer, options) {
      if (!isOurs(source, importer)) return null
      const entry = targets.get(bareSpecifier(source))
      if (entry === undefined) return null
      const target = entry.kind === 'package' ? entry.implementation : resolve(root, 'src/shim', entry.implementation)
      return await this.resolve(target, importer, { ...options, skipSelf: true })
    }
  }
}

/** The renderer's dev-only settings a standalone Vite server (an e2e test
 * driving `ELECTRON_RENDERER_URL` itself) shares with electron-vite, so the
 * two never drift. A concrete `server.hmr.host` matters for a page whose
 * origin is `orivon://<page>`, not the dev server's: without one, Vite's
 * client infers the wrong socket host from that origin. `127.0.0.1`, not
 * Vite's own `localhost` default: `HERMETIC_RESOLVER` (test/smoke-helpers.mjs)
 * blackholes every other hostname, and `internalCsp` (serve.ts) must allow
 * the exact host named here. */
export const rendererHost = '127.0.0.1'
export const rendererRoot = resolve(root, 'src/renderer')
export const rendererAlias = buildAliasEntries().map(({ specifier, kind, implementation }) => ({
  find: aliasPattern(specifier),
  replacement: kind === 'package' ? implementation : resolve(root, 'src/shim', implementation)
}))
export const rendererHmr = { host: rendererHost } as const

/** The name src/preload/page-buffer.ts's installer reads the `buffer` package through. */
export const BUFFER_PACKAGE_PLACEHOLDER = '__ORIVON_BUFFER_PACKAGE__'
const PAGE_BUFFER_SOURCE = normalizePath(resolve(root, 'src/preload/page-buffer.ts'))

/**
 * Wraps a built preload's whole body in its own function scope. Electron's sandboxed preload
 * loader runs a preload as the body of a function already binding `Buffer`, `process` and others
 * as its own parameters -- measured: `vm.compileFunction(code, ['Buffer', ...])` throws the exact
 * `SyntaxError: Identifier 'Buffer' has already been declared` a real launch does, for a bundled
 * top-level `const`/`let`/`class` of the same name (`src/preload/README.md`'s Design notes has
 * which preload and why). A nested function scope may shadow an outer parameter freely, so one
 * more layer of function scope around the whole chunk defuses this for any such name, not just
 * `Buffer`.
 */
export function wrapSandboxedPreloadBody (entries: ReadonlySet<string> = new Set(['child-host'])): Plugin {
  return {
    name: 'orivon:wrap-sandboxed-preload-body',
    // Only the preloads that bundle shim code (today the child host's) need it; every other
    // preload's output stays exactly what it was.
    renderChunk (code, chunk) {
      if (!entries.has(chunk.name)) return null
      return { code: `(function () {\n${code}\n})();\n`, map: null }
    }
  }
}

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
        'orivon:crx-extensions-router': resolve(root, 'vendor/electron-chrome-extensions/src/browser/router.ts'),
        'orivon:crx-extensions-cookies': resolve(root, 'vendor/electron-chrome-extensions/src/browser/api/cookies.ts'),
        'orivon:crx-extensions-tabs': resolve(root, 'vendor/electron-chrome-extensions/src/browser/api/tabs.ts')
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
    // shimNodeSpecifiers must resolve BEFORE Rollup's own externalization
    // decides a bare Node specifier is a builtin with nothing to bundle --
    // its own header has the full reasoning. Order after pageBufferPackage
    // is not load-bearing (different id, `enforce: 'post'` besides).
    plugins: [pageBufferPackage(), shimNodeSpecifiers(), wrapSandboxedPreloadBody()],
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
          'child-host': resolve(root, 'src/preload/child-host.ts'),
          'extension-api': resolve(root, 'src/preload/extension-api.ts'),
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
    root: rendererRoot,
    server: { host: rendererHost, hmr: rendererHmr },
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
      alias: rendererAlias
    }
  }
})
