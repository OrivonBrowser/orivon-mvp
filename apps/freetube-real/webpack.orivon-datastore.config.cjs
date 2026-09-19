// The second bundle build/orivon-electron needs: upstream's OWN
// main-process datastore code (src/datastores/handlers/base.js over
// src/datastores/index.js over @seald-io/nedb), compiled to run in the page
// instead of Electron's main process. See README.md's "Where the data
// lands" for why this is a separate webpack config rather than a second
// entry on webpack.orivon.config.cjs: that config's own `resolve.fallback`
// deliberately stubs fs/path/stream/crypto/... to nothing for the renderer
// bundle (a browser page has no business touching them), which is the
// exact opposite of what this bundle needs from the same specifiers.
//
// Requires webpack from the clone, same as webpack.orivon.config.cjs, so
// both bundles compile with the exact webpack version FreeTube itself pins.
// Run from the clone (`cd <clone> && npx webpack --config <this file>`).
'use strict'
const path = require('path')

const CLONE = process.env.FREETUBE_CLONE ?? '/home/jhon/git/freetube-src'
const HERE = __dirname
const REPO_ROOT = path.join(HERE, '..', '..')

function requireFromClone (specifier) {
  return require(require.resolve(specifier, { paths: [CLONE] }))
}

/** Same resolution as requireFromClone, but the path only -- for a plugin option (ProvidePlugin, below) that wants a module to resolve to, not one to execute here. */
function resolveFromClone (specifier) {
  return require.resolve(specifier, { paths: [CLONE] })
}

const webpack = requireFromClone('webpack')

const OUTPUT_PATH = path.join(CLONE, 'dist', 'orivon-electron-datastore')
const SHIM_FS_BUNDLE = path.join(HERE, 'build', 'shim', 'fs.js')

/**
 * Resolves an orivon-mvp dependency the same way `apps/freetube-real/`
 * itself resolves node_modules -- from this file's own location upward,
 * which reaches the repo root's node_modules whether this is a real
 * checkout or a worktree with node_modules symlinked in (CLAUDE.md's own
 * "a new worktree needs node_modules" note).
 *
 * THE TRAILING SLASH IS LOAD-BEARING for 'events', 'buffer' and 'util':
 * those are also Node CORE module names, and plain `require.resolve('buffer')`
 * short-circuits to the core module (returning the bare string 'buffer'
 * right back) before ever consulting node_modules, regardless of an
 * installed package of the same name -- Node's own documented resolution
 * order checks core modules first. A trailing slash defeats that
 * short-circuit by making the specifier path-like, the standard trick for
 * resolving an npm package that happens to share a core module's name.
 * `path-browserify`/`stream-browserify`/`crypto-browserify` need no such
 * trick, since their names do not collide with a core module.
 */
function requireFromRepo (specifier) {
  return require.resolve(`${specifier}/`, { paths: [REPO_ROOT] })
}

module.exports = {
  name: 'orivon-datastore',
  mode: process.env.NODE_ENV ?? 'production',
  devtool: false,
  entry: { datastore: path.join(HERE, 'bridge', 'ft-datastore-entry.js') },
  output: {
    path: OUTPUT_PATH,
    filename: '[name].js',
    scriptType: 'text/javascript'
  },
  target: 'web',
  node: {
    __dirname: false,
    __filename: false
  },
  resolve: {
    // Disables webpack's default browser-field remapping for EVERY package
    // in this graph, not only a top-level one -- @seald-io/nedb's own
    // package.json remaps lib/storage.js, lib/customUtils.js and
    // lib/byline.js to its browser-version/ (localForage/IndexedDB)
    // counterparts, and webpack applies that remap during ordinary relative
    // `require()` resolution inside the package too, not only at its entry
    // point. This is the mechanism behind "resolving @seald-io/nedb to its
    // Node build, not the browser field" (README.md).
    aliasFields: [],
    alias: {
      'freetube-datastore-handlers$': path.join(CLONE, 'src', 'datastores', 'handlers', 'base.js'),
      // The one src/shim/ module this bundle needs, pre-compiled to plain
      // JS by build-shim.mjs (webpack itself has no TypeScript loader).
      fs$: SHIM_FS_BUNDLE,
      // Everything else nedb's real Node storage layer imports
      // (storage.js, persistence.js, byline.js, datastore.js, cursor.js --
      // read directly, not guessed) is either a plain npm polyfill package
      // module-map.ts already approves for this exact purpose, or (util,
      // timers) a package/local file this bundle alone needs -- see
      // README.md's "Where the shim comes from" for why util is the real
      // npm package here rather than src/shim/node-util.ts, which is
      // deliberately narrowed to one export (inherits) for a different
      // dependency graph.
      path$: requireFromRepo('path-browserify'),
      stream$: requireFromRepo('stream-browserify'),
      events$: requireFromRepo('events'),
      buffer$: requireFromRepo('buffer'),
      crypto$: requireFromRepo('crypto-browserify'),
      util$: requireFromRepo('util'),
      timers$: path.join(HERE, 'bridge', 'ft-datastore-timers-shim.js')
    },
    extensions: ['.js'],
    // crypto-browserify's own default export pulls in createSign/createVerify
    // (browserify-sign -> parse-asn1 -> asn1.js), which reaches for `vm` --
    // a real gap, but a dead one for this bundle: nedb's own customUtils.js
    // (the only caller in this graph) calls nothing but
    // `crypto.randomBytes()`. `false` here is the same "honest for a
    // browser bundle, checked rather than assumed" stub
    // webpack.orivon.config.cjs already uses for the renderer bundle's own
    // unused builtins.
    fallback: { vm: false }
  },
  plugins: [
    new webpack.DefinePlugin({
      // src/datastores/index.js's own branch: falsy here keeps it on the
      // `${name}.db` relative-filename, autoload: true path (README.md's
      // "Where the data lands"), and folds away its `require('electron')`/
      // `require('fs')`/`require('path')` branch as dead code during
      // webpack's own parse -- the same DefinePlugin-folds-a-require
      // mechanism FreeTube's own webpack.main.config.js relies on to set
      // this flag true for the real main-process bundle.
      'process.env.IS_ELECTRON_MAIN': false
    }),
    // Found by actually running this build in a real page, not assumed:
    // some Node-history package in this graph (a crypto-browserify
    // transitive dependency, going by the minified stack) reads bare
    // `process` -- `process.browser`/`process.nextTick`-style
    // environment checks, the standard Browserify-era pattern -- and
    // target 'web' provides no such global on its own, unlike Electron's
    // real main process, which has real Node's. `web.config.js` already
    // solves this the identical way for the renderer bundle, for the
    // identical reason (a plain page has no `process` either): resolved
    // from the clone rather than requiring this repo to add a `process`
    // devDependency of its own for one polyfill already sitting in the
    // clone's own node_modules.
    new webpack.ProvidePlugin({
      process: resolveFromClone('process/browser.js')
    })
  ]
}
