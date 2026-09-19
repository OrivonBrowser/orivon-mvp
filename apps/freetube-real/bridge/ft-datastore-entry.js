// Entry point for webpack.orivon-datastore.config.cjs's own bundle: loads
// upstream's OWN main-process datastore code (src/datastores/handlers/base.js,
// unmodified) and exposes it on one global the bridge reads lazily, at call
// time -- prepare.mjs's --build step injects this bundle's <script> AFTER
// the bridge's but BEFORE FreeTube's own, so at the moment the bridge's own
// top-level `installFtElectronBridge(...)` call runs, this global does not
// exist yet. See README.md's "Where the data lands".
//
// 'freetube-datastore-handlers' is not a real package -- it is a marker
// specifier the datastore webpack config aliases to the clone's own
// src/datastores/handlers/base.js, the same technique
// DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$ already uses one file over.
import * as handlers from 'freetube-datastore-handlers'

globalThis.__orivonFtDatastore = handlers
