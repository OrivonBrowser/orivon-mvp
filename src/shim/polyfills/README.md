# `src/shim/polyfills/`: the core polyfills

**What lives here.** The modules a dependency graph needs just to *evaluate*, independent of any
capability: wrappers over the `buffer`, `crypto`, `os`, `path`, `util` and `zlib` packages, and
hand-written `assert`, `querystring`, `string_decoder`, `timers`, `url` and `stream/promises`,
`module` (`createRequire`: a native addon's `.node` path over [`../addon/`](../addon/), and any other file through [`cjs-loader.ts`](cjs-loader.ts)),
`worker_threads` (`Worker` over [`../child-process/`](../child-process/)'s Web Worker runtime,
`isMainThread`/`parentPort`/`workerData` read at evaluation time) and `vm`
(code run in the page's own context), and the modules a server's dependency graph asks for as it
loads: `tty`, `readline`, `http2`, `diagnostics_channel`, `async_hooks`, `perf_hooks`, `console` and `process`.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../unimplemented.ts`](../unimplemented.ts) and [`../virtual-root.ts`](../virtual-root.ts)
(`os.ts`'s `homedir()`/`tmpdir()`); `module.ts` also on [`../addon/`](../addon/), which installs
`process.dlopen` when it loads, and on [`../module-map.ts`](../module-map.ts) for
`builtinModules`; `worker-threads.ts` also on [`../child-process/`](../child-process/)'s
`thread.ts` for `Worker` and [`../worker/`](../worker/)'s `node-port.ts` (the Node-shaped
`MessagePort`) and `runtime-thread.ts` (the registered symbol a thread's own copy of this module
reads).

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

**`tty`, `readline` and `http2` load and refuse by name.** An app has no terminal, so
`tty.isatty()` is false for every descriptor and the stream classes refuse as *not-applicable*;
`readline` has no member yet and each refuses as *unimplemented*. `http2` carries Node's real
`constants` ([`http2-constants.generated.json`](http2-constants.generated.json), a snapshot of
one Node version), which `http2-wrapper` and `undici` destructure as they evaluate; every
function refuses as *not-built*, since `orivon.net` carries no HTTP/2 session, and a client
falls back to HTTP/1.1 on the error.

**`async_hooks` cannot follow an `await`.** A page has no per-continuation context, so
[`async-hooks.ts`](async-hooks.ts) keeps one table of current stores. `AsyncLocalStorage#run`
sets its store for the synchronous run of the callback, and `AsyncResource` captures the table
when it is made and restores it in `runInAsyncScope` and `bind`: a callback bound inside `run`
sees the store when it is called later, and a continuation after `await` or a timer that nothing
bound sees `undefined`. `createHook` returns a hook that never fires, since no resource is
reported; `express`'s `on-finished` wraps every response in an `AsyncResource` and needs no
more. Provisional: what would settle it is the platform's `AsyncContext`, which no engine ships.

**`diagnostics_channel` is real JavaScript** ([`diagnostics-channel.ts`](diagnostics-channel.ts)):
one channel per name held by a `WeakRef`, `bindStore`/`runStores` over `AsyncLocalStorage`, and
`tracingChannel`. A subscriber that throws surfaces on the next tick, as in Node.

**The run-time `require` reads files and names builtins; it never searches `node_modules`**
([`cjs-loader.ts`](cjs-loader.ts), behind `createRequire` and a forked child's global
`require`). A relative or absolute path loads through the exact name, `.js`, `.cjs`, `.json` and
`/index.js`, read with the shim's `readFileSync` (so it works on a page as well as in a Worker)
and evaluated by `vm.compileFunction` with `(exports, require, module, __filename, __dirname)`.
That evaluation needs the served CSP's `'unsafe-eval'`, which a page's document and the child
host's document both carry, and a Worker started from a `blob:` URL inherits; where a CSP refuses
it the call fails with a named error, never silently. A bare name is answered from
[`cjs-builtins.ts`](cjs-builtins.ts)'s table, or fails `MODULE_NOT_FOUND` with a message that says
there is no `node_modules` resolution: `ws`'s `try { require('bufferutil') }` depends on that
code. `child_process`, `wasi`, `worker_threads` and `electron` are left out of the table, since
each stands on machinery a loader should not pull into every bundle; `registerBuiltin` adds
one. Every module's `require` shares one cache, keyed by resolved path. Cycles return the partial
exports as Node does, and a module that throws is dropped from the cache. Provisional: package
resolution would settle whether a `node_modules` directory ever appears in an app's own fs.

**`process` is the global, with forwarding named exports** ([`process.ts`](process.ts)): the default
export is the global itself, so a bundled `require('process') === process`. The named function members
forward to the global at call time, and the data members are what the global holds when the module
loads.

**Four members that `express` and `got` reach through their dependencies are answered, not
refused.** `url.Url` is the legacy class (`parseurl` builds one with `new Url()`), `StringDecoder` is
a function that `StringDecoder.call(this, encoding)` can extend (`iconv-lite` does, for every body
`body-parser` reads), `buffer.isUtf8` and `isAscii` exist (`ws` prefers them, and destructuring a
refusing stand-in would have made it pick one that throws), and `util.types.isProxy` returns false,
since a Proxy cannot be told from its target in userland (a request timer asks it of every socket).
