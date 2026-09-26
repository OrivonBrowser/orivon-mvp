# `src/shim/polyfills/`: the core polyfills

**What lives here.** The environment-shape modules a dependency graph needs just to *evaluate*,
independent of any capability: `buffer.ts`, `crypto.ts`, `os.ts`, `path.ts`, `util.ts`,
`util-types.ts` and `zlib.ts` (each a local wrapper over its package, correcting or completing
it), plus the hand-written `assert.ts`, `deep-equal.ts` (shared by `assert.ts` and `util.ts`),
`querystring.ts`, `string-decoder.ts`, `timers.ts`, `timers-promises.ts`, `url.ts` and
`stream-promises.ts`. `module-proxy.ts` is the wrapper every package-backed module here uses to
refuse an unbuilt member by name.

**What it depends on.** [`../../contracts/`](../../contracts/), [`../errors.ts`](../errors.ts),
[`../unimplemented.ts`](../unimplemented.ts) and [`../virtual-root.ts`](../virtual-root.ts)
(`os.ts`'s `homedir()`/`tmpdir()`).

**What it must never import.** `electron`, or [`../../broker/`](../../broker/) -- see the parent
README's "What it must never import".

**Owner stream.** `shim`, build step 3.

## Design notes

**An app tab's `Buffer` global is the `buffer` package, and [`buffer.ts`](buffer.ts) adopts
it.** `installGlobals` may not name anything outside its own body, so it cannot import the
package; the preload installs it instead ([`../../preload/page-buffer.ts`](../../preload/page-buffer.ts),
and [`../../preload/README.md`](../../preload/README.md)'s Design notes say how the package gets
there). An app's bundle still carries its own copy of the package behind `buffer`, and two copies
are two classes, so `buffer.ts` exports the page's global instead of its own when the global is
the package's class (it has `TYPED_ARRAY_SUPPORT`; Node's own Buffer, which a unit test runs
under, does not), with `SlowBuffer` rebuilt over it. `require('buffer').Buffer === Buffer` then
holds and `instanceof` agrees either way. A realm without the global (a worker, a subframe, an
ordinary tab) keeps the package's own class.

**Polyfill-grade vs Orivon-grade primitives, and why the gap is documented rather than closed
here (A132, T26 in `../../../docs/architecture/security-model.md`).** The placement is the
mitigation, and it is the right one: the eight core polyfills (`Buffer`, `stream`, `events`,
`path`, `os`, `crypto`, `zlib`, `util`) run inside the untrusted renderer, on the far side of the
broker's boundary, so a backdoored `crypto-browserify` cannot reach a socket the broker never
authorised -- that is what makes admitting nine third-party packages (one carrying an advisory,
`../../../docs/planning/shim-dependency-review.md`) survivable at all. **The gap T26 names:** an
app calling `crypto.createHash(...)` through `../module-map.ts` cannot tell it is getting a
polyfill rather than a vetted primitive, and the two differ in security properties:
`orivon.id.*`'s WebCrypto-backed signing is a different grade from what this package presents
under an unrelated name (`crypto`). This package does not invent an API to distinguish them; that
would be a `src/contracts/` change, decided elsewhere. **Recommended, not built:** some way for
an app to ask which grade a given primitive is would need to live in `src/contracts/`, not here.

**A package-backed module is a local wrapper, except `stream` and `events`.** `buffer`, `path`,
`os`, `crypto`, `zlib` and `util` alias to a file here that re-exports the package's members by
name and wraps its default export with `module-proxy.ts`'s `nodeModule`, so a member the package
lacks (`crypto.generateKeyPairSync`, `zlib.brotliCompressSync`, `path.win32`) refuses by name
instead of being `undefined`. A wrapper imports its package by a name the alias map does not
match (`'buffer/'`, `'path-browserify'`), never by the specifier it stands for, which would
resolve back to itself. `stream` and `events` stay unwrapped: their module value is itself a
constructor apps subclass and compare by identity, and a Proxy default export would make `import
EventEmitter from 'events'` a different object from `EventEmitter.EventEmitter`.

**[`util.ts`](util.ts) stands on the `util` package, and corrects it.** **AI recommendation, not
owner-reviewed.** Rule 6: `format`, `inspect` and the `types` predicates are the parts of `util`
most costly to get right by hand, and the package already has them, approved and installed. The
cost is its dependency tree (about thirty small, pure-JS packages from the `is-*`/`get-intrinsic`
family) in any bundle that imports `util`, which includes every bundle using `stream`:
readable-stream reads `util.debuglog` and `util.inspect`. Its `util.js` also reads
`process.env.NODE_DEBUG` at load, so it needs the `process` global the preload installs. Four
members are this file's own: `promisify` (the package keys its custom form on a private
`Symbol`, so a library marking one with `Symbol.for('nodejs.util.promisify.custom')` goes
unseen), `inherits` (the package's replaces `ctor.prototype`, dropping methods already on it;
Node's uses `setPrototypeOf`), `isDeepStrictEqual` (newer than the package;
[`deep-equal.ts`](deep-equal.ts), shared with `assert`) and `TextEncoder`/`TextDecoder` (the
platform's own).
