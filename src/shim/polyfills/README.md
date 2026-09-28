# `src/shim/polyfills/`: the core polyfills

**What lives here.** The modules a dependency graph needs just to *evaluate*, independent of any
capability: wrappers over the `buffer`, `crypto`, `os`, `path`, `util` and `zlib` packages, and
hand-written `assert`, `querystring`, `string_decoder`, `timers`, `url` and `stream/promises`,
and `module` (`createRequire` for a native addon's `.node` path, over [`../addon/`](../addon/)).

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../unimplemented.ts`](../unimplemented.ts) and [`../virtual-root.ts`](../virtual-root.ts)
(`os.ts`'s `homedir()`/`tmpdir()`); `module.ts` also on [`../addon/`](../addon/), which installs
`process.dlopen` when it loads, and on [`../module-map.ts`](../module-map.ts) for
`builtinModules`.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**A package-backed module is a local wrapper, except `stream` and `events`.** A wrapper re-exports
its package by name and wraps the default export with `module-proxy.ts`'s `nodeModule`, so a
member the package lacks refuses by name. It imports its package by a name the alias map does not
match (`'buffer/'`, `'path-browserify'`), never by the specifier it stands for, which would resolve
back to itself. `stream` and `events` stay unwrapped: apps subclass them and compare them by
identity, and a `Proxy` default would make `EventEmitter` differ from `EventEmitter.EventEmitter`.

**`crypto` is polyfill-grade, not Orivon-grade**, and an app cannot tell which it is using:
T26 in [`security-model.md`](../../../docs/architecture/security-model.md) (A132). Closing that
would be a `src/contracts/` change, not one here.

**[`util.ts`](util.ts) stands on the `util` package, and corrects it** (`d-0074`, Rule 6):
`format`, `inspect` and the `types` predicates are costly to get right by hand. The cost is about
thirty small pure-JS packages in any bundle importing `util`, which is every bundle using
`stream`. The package reads `process.env.NODE_DEBUG` at load, so it needs the `process` global
installed first. What `util.ts` replaces, and why: its header.
