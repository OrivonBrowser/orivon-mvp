// `timers` target for webpack.orivon-datastore.config.cjs's own alias table
// -- NOT part of src/shim/ (that package's module-map.ts has no `timers`
// row; this stays local to apps/freetube-real/, matching prepare.mjs's own
// "no FreeTube source and no orivon-mvp shim source, only our own glue"
// rule).
//
// The one caller in the whole datastore dependency graph is
// @seald-io/nedb's own lib/byline.js (`timers.setImmediate`, reading each
// line of a datafile during load) -- confirmed by reading that file, not
// guessed. `setImmediate` runs after I/O callbacks and before timers in
// real Node's event loop; `setTimeout(fn, 0)` runs in the next macrotask
// instead, which orders slightly differently but settles the same
// eventually-consistent line-by-line read this module drives. Node's own
// browser-facing packages (e.g. timers-browserify) make the identical
// trade for the identical reason.
export function setImmediate (callback, ...args) {
  return setTimeout(callback, 0, ...args)
}

export function clearImmediate (handle) {
  clearTimeout(handle)
}
