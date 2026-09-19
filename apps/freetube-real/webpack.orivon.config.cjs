// Our own build wrapper for upstream FreeTube's Electron-shaped renderer,
// moved here from the clone's untracked `_scripts/webpack.web-localapi.config.js`
// so it is version-controlled (FreeTube's own source and build output stay
// out of this repo -- AGPL-3.0-or-later -- only this config is ours).
//
// Requires upstream's OWN `_scripts/webpack.web.config.js` from a clone path
// (FREETUBE_CLONE) and changes only what compiling the Electron renderer,
// rather than a browser tab, needs. See apps/freetube-real/README.md's "Why
// the Electron renderer, not the web build" for the reasoning.
//
// Run from the clone (`cd <clone> && npx webpack --config
// <this file's absolute path>`), so `npx webpack` resolves the clone's own
// webpack-cli. This file's own `require('webpack')` is resolved against the
// clone too (below), not against this repo, which has no webpack of its own.
'use strict'
const path = require('path')

const CLONE = process.env.FREETUBE_CLONE ?? '/home/jhon/git/freetube-src'

function requireFromClone (specifier) {
  return require(require.resolve(specifier, { paths: [CLONE] }))
}

const webpack = requireFromClone('webpack')
const HtmlWebpackPlugin = requireFromClone('html-webpack-plugin')
const CopyWebpackPlugin = requireFromClone('copy-webpack-plugin')
const ProcessLocalesPlugin = require(path.join(CLONE, '_scripts', 'ProcessLocalesPlugin.js'))
const { sigFrameTemplateParameters } = require(path.join(CLONE, '_scripts', 'sigFrameConfig.js'))
const config = require(path.join(CLONE, '_scripts', 'webpack.web.config.js'))

const OUTPUT_PATH = path.join(CLONE, 'dist', 'orivon-electron-web')
const OLD_WEB_DIST = path.join(CLONE, 'dist', 'web')

// youtubei.js and googlevideo are stubbed to `{}` upstream, for a browser
// that cannot reach YouTube directly. Bundle them for real.
delete config.externals

// The one DefinePlugin instance carries every process.env.* the renderer
// checks at build time. Asserting there is exactly one, as the clone's own
// web-localapi wrapper does, catches upstream restructuring this silently.
//
// src/index.ejs's own `<% if (process.env.IS_ELECTRON) %>` reads THIS SAME
// define -- html-webpack-plugin compiles the ejs template through webpack
// itself, so setting it true here also switches the template to upstream's
// real sigFrame markup (below) instead of the PWA manifest/service-worker
// branch. That is a build-time substitution, unrelated to whether the
// actual Node process running webpack has an IS_ELECTRON env var.
let patched = 0
for (const plugin of config.plugins) {
  if (!(plugin instanceof webpack.DefinePlugin)) continue
  if (plugin.definitions['process.env.SUPPORTS_LOCAL_API'] === undefined) continue
  plugin.definitions['process.env.SUPPORTS_LOCAL_API'] = true
  plugin.definitions['process.env.IS_ELECTRON'] = true
  patched += 1
}
if (patched !== 1) {
  throw new Error(`expected exactly one DefinePlugin carrying SUPPORTS_LOCAL_API, patched ${patched} -- upstream's web config changed shape`)
}

// With IS_ELECTRON true the template now takes the branch that renders
// `<iframe id="sigFrame" src="<%= sigFrameSrc %>" ...>` -- upstream's own
// _scripts/webpack.renderer.config.js supplies these two variables the same
// way, from upstream's own sigFrameConfig.js. Without this the build fails
// at HtmlWebpackPlugin time ("sigFrameSrc is not defined"), not silently.
let htmlPluginsPatched = 0
for (const plugin of config.plugins) {
  if (!(plugin instanceof HtmlWebpackPlugin)) continue
  plugin.options.templateParameters = sigFrameTemplateParameters
  htmlPluginsPatched += 1
}
if (htmlPluginsPatched !== 1) {
  throw new Error(`expected exactly one HtmlWebpackPlugin, patched ${htmlPluginsPatched} -- upstream's web config changed shape`)
}

// src/renderer/i18n/index.js fetches `${locale}.json.br` instead of
// `${locale}.json` once IS_ELECTRON is true (its own comment: "locales are
// only compressed in our production Electron builds") -- that branch is
// live now too, so the locales this plugin emits have to match, or every
// locale fetch 404s before the renderer ever mounts. Upstream's own
// _scripts/webpack.renderer.config.js reaches this by constructing the
// plugin with `compress: true`; ours patches the already-constructed
// instance instead, since webpack.web.config.js builds it at module load
// (`this.compress` is a plain instance field, not touched after apply()
// walks it -- see ProcessLocalesPlugin.js's own processLocale).
let localesPluginsPatched = 0
for (const plugin of config.plugins) {
  if (!(plugin instanceof ProcessLocalesPlugin)) continue
  plugin.compress = true
  localesPluginsPatched += 1
}
if (localesPluginsPatched !== 1) {
  throw new Error(`expected exactly one ProcessLocalesPlugin, patched ${localesPluginsPatched} -- upstream's web config changed shape`)
}

// webpack.web.config.js's SECOND CopyWebpackPlugin (static/, pwabuilder-sw.js,
// shaka-player-locales) writes to HARDCODED `dist/web/...` absolute paths,
// not relative to `output.path` -- unlike its FIRST one (the swiper CSS
// copy, `to: 'swiper-x.css'`, a relative path CopyWebpackPlugin resolves
// against output.path itself, needing no patch here). Left alone, this
// build would silently write into `dist/web` -- exactly the directory this
// config exists to avoid touching (found the hard way: it did, once, before
// this patch existed). Rewrite every absolute `to` under the old prefix.
let copyPluginsPatched = 0
for (const plugin of config.plugins) {
  if (!(plugin instanceof CopyWebpackPlugin)) continue
  for (const pattern of plugin.patterns) {
    if (typeof pattern.to !== 'string' || !pattern.to.startsWith(OLD_WEB_DIST)) continue
    pattern.to = OUTPUT_PATH + pattern.to.slice(OLD_WEB_DIST.length)
    copyPluginsPatched += 1
  }
}
if (copyPluginsPatched === 0) {
  throw new Error('expected at least one CopyWebpackPlugin pattern targeting dist/web -- upstream\'s web config changed shape')
}

// FreeTube's own alias, patched from '.../handlers/web.js' (localForage,
// browser nedb -> IndexedDB) to '.../handlers/electron.js' (window.ftElectron
// dispatch, real nedb over real files) -- this is the whole point of this
// build. Asserted first, the same defensive style as every patch above:
// upstream restructuring this key should fail the build loudly, not
// silently keep pointing at the web handler.
const DB_HANDLERS_KEY = 'DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$'
const EXPECTED_WEB_HANDLER = path.join(CLONE, 'src', 'datastores', 'handlers', 'web.js')
config.resolve = config.resolve ?? {}
config.resolve.alias = config.resolve.alias ?? {}
if (config.resolve.alias[DB_HANDLERS_KEY] !== EXPECTED_WEB_HANDLER) {
  throw new Error(`expected ${DB_HANDLERS_KEY} to point at handlers/web.js -- upstream's web config changed shape`)
}
config.resolve.alias[DB_HANDLERS_KEY] = path.join(CLONE, 'src', 'datastores', 'handlers', 'electron.js')

// Present only in upstream's OWN renderer.config.js, absent from web.config.js
// -- see README.md's renderer-vs-web diff table. Safe here for a reason
// confirmed by reading the one consumer, not assumed: vSaferHtml.js's
// `USE_NATIVE_SANITIZER = process.env.IS_ELECTRON || (...)` is `true` as
// soon as IS_ELECTRON is (already the case, above), which makes every
// `DOMPurify.sanitize(...)` call site dead code -- this alias only stops
// webpack bundling the real (unused) dompurify package, exactly as
// upstream's own Electron build does.
config.resolve.alias.dompurify$ = path.join(CLONE, '_scripts', '_undefinedDefaultExport.mjs')

// youtubei.js reaches for a few node builtins on its isomorphic paths. Same
// fallback list as the clone's web-localapi wrapper: an empty fallback is
// the honest setting for a browser bundle, which checks for these rather
// than assuming them.
config.resolve.fallback = {
  ...config.resolve.fallback,
  fs: false,
  path: false,
  stream: false,
  crypto: false,
  http: false,
  https: false,
  zlib: false,
  url: false,
  net: false,
  tls: false,
  child_process: false
}

// The entry stays upstream's single `main.js`. With IS_ELECTRON true,
// local.js's own branch posts to #sigFrame for n/sig deciphering, so
// `orivon-sig-eval.js` (dead code under this define) is never added to it.

// Never `dist/web`: that directory is `pnpm run pack:web`'s, which another
// agent's run may depend on while this build runs (parallel-work.md).
config.output.path = OUTPUT_PATH

module.exports = config
