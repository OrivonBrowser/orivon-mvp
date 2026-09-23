# `src/shim/`: `orivon-node-shim`

**What lives here.** Two different kinds of thing, and the distinction matters:

1. Node's `net`, `dgram` and `fs` APIs, reconstructed on top of `orivon.*`, so that ordinary
   Node libraries run unmodified inside a renderer. Load-bearing, not a developer nicety:
   without it the flagship cannot be a URL-delivered app
   ([`ADR-0005`](../../docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
2. **Core polyfills** (queue item 3.1): the environment-shape modules a dependency graph
   needs just to *evaluate*, independent of any capability: `Buffer`, `stream`, `events`,
   `path`, `os`, `crypto`, `zlib`, `util`, plus the hand-written `url`, `querystring`,
   `string_decoder`, `timers` and `assert`. `compatibility-matrix.md` Table 3 calls these `dup`
   rows: closing them is ordinary shim work, no contracts change needed.

`globals.ts` (ambient `process`/`global`/`setImmediate`), `virtual-root.ts` (the one directory
every Node-shaped path agrees on; see §Design notes) and `module-map.ts` (the single table
`electron.vite.config.ts`'s alias map and `vitest.config.ts`'s shim resolution are generated
from; see its own header) belong to neither group cleanly; they exist to make the two above
reachable at all.

**Tests run against the page's polyfills.** `vitest.config.ts` resolves a shim module's own
`stream`, `buffer`, `events`, ... imports to the same modules the renderer build does, so a
shim test exercises readable-stream 3 and the `buffer` package, not Node's builtins. A test
file and its `tests/support/` helpers keep `node:*`; `tests/support/page-buffer.ts` and
`page-stream.ts` give a test the page's own classes when it must compare against them.

**Dependency status.** All eight core polyfills are wired up, and their packages are runtime
dependencies in `package.json`.
[`docs/planning/shim-dependency-review.md`](../../docs/planning/shim-dependency-review.md)'s
`## Status` says why the full set was chosen over that review's own five-package
recommendation. `os` and `util` point at local wrappers over their packages (`node-os.ts`,
`node-util.ts`) that correct or complete them; see §Design notes. The `zlib` row is
gzip/deflate only (`browserify-zlib` predates Node's brotli support); see the review before
assuming brotli works.

**What it depends on.** [`src/contracts/`](../contracts/), and
[`src/shim-electron/unimplemented.ts`](../shim-electron/unimplemented.ts)'s `refusingProxy` --
see §Design notes below.

**What it must never import.** `electron`, or [`src/broker/`](../broker/). The shim runs in the
renderer and reaches the broker only through `orivon.*`. Importing the broker would hand it
main-process authority it must not have.

**Owner stream.** `shim`, build step 3. Also owns the `renderer.resolve.alias` map in
`electron.vite.config.ts`; no other stream writes there.

**Five binding requirements** from [`handle-contracts.md`](../../docs/architecture/handle-contracts.md)
§What the shim must do. Read them before writing a line here; each cost real time to discover:

1. **Completeness is measured against a dependency's real call graph, never this repo's
   anticipated surface.** `bittorrent-dht` calls `net.isIP()` before every send. It is not a
   socket operation and is easy to omit; its absence made the DHT bind successfully and then
   send nothing, forever, with no error.
2. **A polyfilled timing primitive must make errors louder, not quieter.** A
   `queueMicrotask`-based `process.nextTick` swallows exceptions that real Node surfaces to the
   process.
3. **Every reply-carrying message over a `MessagePortMain` needs an explicit timeout.** This
   transport fails by silence.
4. **No transferables on the renderer -> main path, ever.** `electron#34905`: the message
   silently never arrives.
5. **Synchronous Node accessors are served from values captured at acquisition**, never from a
   cache an event fills in later.

Also read [`.claude/skills/orivon-electron/SKILL.md`](../../.claude/skills/orivon-electron/SKILL.md).

## Design notes

**[`globals.ts`](globals.ts) writes `process`, `global`, `setImmediate` and `clearImmediate`
with a plain assignment, not `Object.defineProperty`, on purpose.** That is the descriptor Node
gives its own: ordinary, writable, replaceable. ADR-0021 makes it a rule rather than an accident
-- an app may shadow or replace any of them, and a locked one would kill a bundle that ponyfills
it while its module graph is still evaluating, naming no cause. `npm run check:page-globals`
guards the source and [`tests/globals.test.ts`](tests/globals.test.ts) guards the behaviour.

**`process` answers what libraries read without claiming to be Node.** **AI recommendation, not
owner-reviewed.** `version` is `''` and `versions` is an empty object, not a plausible Node
version: a check for `process.versions.node` or `.electron` then takes its browser branch,
where a fabricated value would send it down a Node-only path this shim cannot back, and an absent
`versions` would throw on `undefined.node`. `platform`, `title`, `arch` and `release.name` say
`'browser'`/`'javascript'` for the same reason, values no check for a real platform can match.
`argv`/`execArgv` are empty, `pid` is 1, `umask()` is the POSIX default and changes nothing.
`exit()` emits `'exit'` and throws a named error: an app tab cannot end its own process, and
silently returning would let the code after it run as if it had. `process` is a small event
emitter; `'uncaughtException'` and `'warning'` listeners receive what Node would send them.

**An uncaught `nextTick`/`setImmediate` error reaches the page's own error reporting.** The
preload passes no reporter: a function crossing `contextBridge` runs in the isolated world, so
it would log where the page's own `window` `'error'` handlers never see it. Without one,
`installGlobals` calls the page's `reportError` (the HTML one), which behaves as an uncaught
exception would. A warning with no `'warning'` listener goes to the page console.

**`setImmediate` is a `MessageChannel` task, not `setTimeout(0)`.** A timer is clamped to 4 ms
once nested and to 1 s in a hidden tab, and a scheduler that adopts `setImmediate` when present
(React's does) would inherit both. A message task has neither clamp, and keeps Node's ordering:
one callback per task, in the order queued.

**No `Buffer` page global yet.** `global` is `globalThis` and costs nothing, but `Buffer` is the
`buffer` package, and `installGlobals` may not name anything outside its own body, so it cannot
import one. Putting it on the page needs the package's source in the main world: a build step
that bundles it into a function the preload can serialise, or an owner decision to inject it
with `webFrame.executeJavaScript`, whose timing before the page's own scripts is unverified here.
Until then a bundle referring to a bare `Buffer` needs its bundler to provide it (webpack's
`ProvidePlugin`, for one).


**Polyfill-grade vs Orivon-grade primitives, and why the gap is documented rather than closed
here (A132, T26 in `docs/architecture/security-model.md`).** The placement is the mitigation, and
it is the right one: the eight core polyfills (`Buffer`, `stream`, `events`, `path`, `os`,
`crypto`, `zlib`, `util`) run inside the untrusted renderer, on the far side of the broker's
boundary, so a backdoored `crypto-browserify` cannot reach a socket the broker never authorised --
that is what makes admitting nine third-party packages (one carrying an advisory,
`shim-dependency-review.md`) survivable at all. **The gap T26 names:** an app calling
`crypto.createHash(...)` through `module-map.ts` cannot tell it is getting a polyfill rather than
a vetted primitive, and the two differ in security properties: `orivon.id.*`'s WebCrypto-backed
signing is a different grade from what this package presents under an unrelated name (`crypto`).
This package does not invent an API to distinguish them; that would be a `src/contracts/` change,
decided elsewhere. **Recommended, not built:** some way for an app to ask which grade a
given primitive is would need to live in `src/contracts/`, not here.

**Refusing an unimplemented member by name, not by absence (A135).** Without this, a caller
reaching `dns.resolve4(...)` or `socket.setBroadcast(...)` would get a bare `TypeError: ... is not
a function`: no name, no reason, no pointer to whether the gap is unbuilt, refused by design or
simply never considered. `src/shim-electron/`'s `unimplemented.ts` solves this for the `electron`
compatibility package, and this package reuses the same mechanism rather than re-inventing it,
on two module-namespace exports at a time: `node-dns.ts`, `node-fs.ts`,
`node-http.ts`/`node-https.ts` and `node-net.ts` each wrap their default export (the shape a
bundled CJS `require(...)` resolves to) with `refusingProxy`, and every other module target
here does the same through [`node-module-proxy.ts`](node-module-proxy.ts)'s `nodeModule`,
so any member they have not built
throws a named, closed-reason `OrivonShimError` (`errors.ts`) when a caller CALLS it, instead of
a bare `TypeError`. It throws on the call, never on the read (A169); the next section says why.

**What `refusingProxy`'s `get` trap returns for an unbuilt member, and the one case it cannot
honestly cover (A169).** `unimplemented.ts`'s `refusingFunction`, named after the prop it
stands in for so a stack trace reads legibly, so `typeof`, optional chaining and destructuring
all see a real, present function instead of throwing on the mere read; only calling it runs
`classify(prop)`'s Error. This is a deliberate, unavoidable trade-off, not a free win: a function
is the one JS value that is both safe to merely hold (`typeof f === 'function'` never throws) and
throws precisely when invoked, but `typeof` on it necessarily reports `'function'`, never
`'undefined'`: there is no way to make a value both callable-when-invoked and typeof-false at
the same read (a `Proxy`'s callability, and hence its `typeof`, is fixed by its target at
construction, not by any trap; verified empirically, not just from the spec). For the vast majority of this surface (`fs.watchFile`, `dns.resolve4`, ...)
that is the right answer anyway, since real Node genuinely does expose them as functions --
`typeof` reporting `'function'` is the TRUTHFUL answer for those, matching what real Node itself
would say, and merely reading the member never throws.
The one place a throwing function would be dishonest is a member real Node exposes as DATA, not a
function -- `fs.constants`, `dns.promises` -- where `typeof` should say `'object'`, which no
throwing function can do. `node-fs.ts` and `node-dns.ts` handle both by name in `refusingProxy`'s
own `known` object rather than routing them through `otherFsMember`/`otherDnsMember`. **Both hold
real values**: `fs.constants` (`node-fs-constants.ts`) carries the four `access()` mode flags a
ported dependency reads directly (`fs.constants.F_OK`, `@seald-io/nedb`'s own `storage.js`), and
`dns.promises.lookup` is built. The mechanism this paragraph documents -- listing a data-shaped
member in `known` with an explicit value rather than a throwing-function stand-in -- stays
available for a member real Node exposes as data and this package has not built. No member is in
that state today.

**Why this package's own `OrivonShimError`/`ShimRefusalReason`, not `shim-electron`'s
`ElectronShimError`.** Same shape, deliberately not the same union: a Node-stdlib gap and an
Electron desktop-shell gap are different situations for a porting developer (code-
guidelines.md Rule 3: "same shape is not the same reason"). Four reasons, reconciling A135's own
wording ("unbuilt, refused by design, or a gap nobody noticed") with this package's actual
gaps: `'not-built'` (a decision is on record and a build path is named; `FileHandle.createReadStream`/
`createWriteStream`'s A184 is the live example), `'unimplemented'` (nothing has decided either way, covering most of the
surface here), `'excluded'` (an owner policy row, compatibility-matrix.md Table 1's 🚫 rows --
not currently emitted by any file in this package: `hid`/`subprocess` have no shim target yet,
and ambient-FS exclusion is enforced by the broker's path policy, not by a member name), and
`'not-applicable'` (a real Node member exists because of a runtime concept, such as an event-loop
handle or a POSIX uid/gid, with no Orivon equivalent; a substrate difference, not a capability
gap). `fs.chmod`/`chown` are this package's `'not-applicable'` example.

**Why the mechanism is imported directly from `src/shim-electron/`, not moved to
`src/shared/`.** `src/shared/` exists specifically for a helper needed on the `src/broker/` <->
`src/shim/` trust boundary (CLAUDE.md, `src/shared/README.md`'s own "two callers on opposite
sides of a boundary" bar): two directories that must never import each other because one holds
main-process authority. `src/shim-electron/` sits on the *same* side of that boundary as this
package: both are renderer-only, hold no broker access, and are already named as sibling
families under `compatibility-matrix.md` Table 2. Routing this through `src/shared/` would
stretch that directory past the crossing it was built for, for no benefit. `refusingProxy`'s
`classify` returns the `Error` to throw directly, so this package's error type flows through it
without `shim-electron` knowing this caller exists; see
`src/shim/unimplemented.ts` and `src/shim-electron/unimplemented.ts`'s own header. **Provisional**: nothing in either package's "must never import" list
forbids this one direction (`src/shim-electron/`'s list forbids the reverse), but the direction
is unconfirmed until the owner rules on it.

**Why `net.Socket`/`dgram.Socket` instances are NOT wrapped the same way.** A throw-on-*read*
proxy is exactly wrong for a stateful, duck-typed instance real Node libraries feature-detect
before calling (`if (typeof socket.setBroadcast === 'function') ...`, `'unref' in socket`): it
would make that defensive check itself throw, turning a graceful, intentional skip into a crash.
That would be a *regression*, not an improvement, **and it is exactly the regression A169 found
`refusingProxy` itself shipped with at the module-namespace grain** (`node-net.ts`/`node-dns.ts`/
etc.), months after this paragraph named the failure mode; A169's fix (the entry above) makes
`refusingProxy` itself safe to read, closing that gap at its source. `class` prototypes remain
non-writable/non-configurable regardless (`Socket.prototype = proxy` throws), so wrapping is
still not mechanically available at the prototype level the way it is for a plain exported
object. That structural reason, not the now-fixed throw-on-read behaviour, is why instances
stay on their own mechanism. `node-net-socket.ts` and `node-dgram-socket.ts` add the handful of
real Node members a porting app is likely to hit as actual present methods: the same "present,
throws when called" shape `node-fs-unsupported.ts`'s `syncUnsupported`,
`node-http-unsupported.ts`'s `createServer`, and `refusingProxy` itself
(post-A169) all use for their own decided gaps. Two of those (`ref`/`unref`) are safe NO-OPS
rather than throws: real Node's contract for them is "no meaning, returns `this`", so a no-op is
the objectively correct behaviour here too (there is no event-loop handle to ref/unref in this
environment): throwing would be strictly worse than today's absence for any caller that
already guards them defensively. The rest (`setTimeout`, `setBroadcast`, the multicast family)
throw when called: a silent no-op there would misreport a real capability as applied instead of
naming the gap, which is the exact failure A135 exists to fix.

**`fs.createReadStream`/`fs.createWriteStream` run over the local per-open cursor, not A184's
broker `readable()`/`writable()`.** **AI recommendation, not owner-reviewed.** `@seald-io/nedb`'s
`lib/storage.js` captures both at module load and its persistence layer calls them on every
database load and every compaction, so they could not stay refused the way `FileHandle`'s own
instance `createReadStream`/`createWriteStream` still are (A184). `node-fs-streams.ts` builds them
as real `stream.Readable`/`Writable` subclasses over `node-fs-handle.ts`'s positional `read`/
`write`, which are page-reachable today: one 64 KiB chunk per round trip. The cost is N round trips
instead of one continuous WHATWG transfer, and a fixed chunk size instead of the broker's own
credit window. For nedb's small line-oriented files that should not matter. Once A184 makes
`readable()`/`writable()` reachable from the page, this file can be rewritten over them with no
app-facing change. **Still open:** whether this is the permanent shape or a placeholder.
Both streams destroy themselves at end/finish and after a failed write, which releases the handle
and emits `'close'`, as Node's `autoDestroy` does: readable-stream 3 defaults `autoDestroy` off,
and turning it on for a Writable there swallows the failed write's `'error'` event.

**`fs.access`'s `mode` is not distinguished: every mode checks existence only.** **AI
recommendation, not owner-reviewed.** Node fails `access(path, mode)` when the process lacks the
permission `mode` names. `orivon.fs` has no POSIX permission model at all (the same reason
`chmod`/`chown` refuse as `'not-applicable'`), so `node-fs-core.ts`'s `doAccess` answers `F_OK`,
`R_OK`, `W_OK` and `X_OK` alike with one `stat()`. A confined or grant-denied path already fails
that the way a real permission check would. nedb, the only caller today, passes `F_OK` alone.
**Still open:** what a future dependency asking `W_OK` to mean something narrower should get,
which `orivon.fs`'s contract currently gives this file nothing to answer with.

**A package-backed module is a local wrapper, except `stream` and `events`.** `buffer`, `path`,
`os`, `crypto`, `zlib` and `util` alias to a file here that re-exports the package's members by
name and wraps its default export with `nodeModule`, so a member the package lacks
(`crypto.generateKeyPairSync`, `zlib.brotliCompressSync`, `path.win32`) refuses by name
instead of being `undefined`. A wrapper imports its package by a name the alias map does not
match (`'buffer/'`, `'path-browserify'`), never by the specifier it stands for, which would
resolve back to itself. `stream` and `events` stay unwrapped: their module value is itself a
constructor apps subclass and compare by identity, and a Proxy default export would make
`import EventEmitter from 'events'` a different object from `EventEmitter.EventEmitter`.

**[`node-util.ts`](node-util.ts) stands on the `util` package, and corrects it.** **AI
recommendation, not owner-reviewed.** Rule 6: `format`, `inspect` and the `types` predicates are
the parts of `util` most costly to get right by hand, and the package already has them,
approved and installed. The cost is its dependency tree (about thirty small, pure-JS packages
from the `is-*`/`get-intrinsic` family) in any bundle that imports `util`, which includes every
bundle using `stream`: readable-stream reads `util.debuglog` and `util.inspect`. Its
`util.js` also reads `process.env.NODE_DEBUG` at load, so it needs the `process` global the
preload installs. Four members are this file's own: `promisify` (the package keys its custom
form on a private `Symbol`, so a library marking one with
`Symbol.for('nodejs.util.promisify.custom')` goes unseen), `inherits` (the package's replaces
`ctor.prototype`, dropping methods already on it; Node's uses `setPrototypeOf`),
`isDeepStrictEqual` (newer than the package; [`node-deep-equal.ts`](node-deep-equal.ts), shared
with `assert`) and `TextEncoder`/`TextDecoder` (the platform's own).

**One virtual root: `/orivon/app` ([`virtual-root.ts`](virtual-root.ts)).** **AI recommendation,
not owner-reviewed.** Node code builds paths from `process.cwd()`, `os.homedir()`, `os.tmpdir()`,
`$HOME`/`$APPDATA` and, in an Electron port, `app.getPath('userData')`, then hands them to `fs`.
All of them name `/orivon/app` (the tmpdir is `/orivon/app/tmp`), and
[`node-fs-path.ts`](node-fs-path.ts)'s `confine` strips that prefix before any `orivon.fs` call,
so `path.join(os.homedir(), 'settings.json')` lands in the app's own files. `orivon.fs` itself
still takes only relative paths: the broker rejects every absolute one
([`src/broker/policy/paths.ts`](../broker/policy/paths.ts)), and the mapping lives here, one layer
up, where the Node-shaped paths are. A relative path passes through exactly as written. A path
outside the root, absolute or by `..`, fails `EACCES` in the shim without reaching the broker:
the errno Node gives for a directory the process may not enter, where the broker would only say
`'denied'`. The tmpdir is created with one `mkdir -p` the first time a path inside it is used,
since Node's always exists and the app's files start empty. The value is not a real host path
and is not meant to look like one: a library branching on it cannot mistake it for a platform
directory it knows.

**A path resolving to the app's own ROOT is answered locally, never sent to orivon.fs.**
**AI recommendation, not owner-reviewed.** The broker's own confinement policy
(`src/broker/policy/paths.ts`) refuses ANY requested path that resolves to the root itself
(`deny('is-root')`), unconditionally, regardless of grant -- by design, not a gap: `orivon.fs`
confines every call to somewhere STRICTLY INSIDE the root. But the root always exists (the broker
creates it), exactly the way a process's cwd always exists in real Node, and a ported dependency
routinely asks for it: `@seald-io/nedb`'s `lib/storage.js` computes `path.dirname('settings.db')`
(`'.'`) for its parent-directory `mkdir`, and fsyncs that same `'.'` after every crash-safe
rename. [`node-fs-root.ts`](node-fs-root.ts) answers every call on the root in the shim:
`stat`/`access` succeed with a directory (size and mtime 0: the broker has no metadata to give
for the one path it refuses); `mkdir(root, {recursive:true})` is a no-op success and fails
`EEXIST` without it; `readFile`/`writeFile`/`appendFile` fail `EISDIR`; `rm`/`unlink`/`rename`
fail `EACCES`, since nothing may remove or move the app's files. `fs.open(root, 'r')` returns a
local directory handle whose `sync()`/`datasync()`/`close()` succeed and whose
`read()`/`write()`/`truncate()` fail `EISDIR`/`EBADF`/`EINVAL` respectively -- checked against
real Node on Linux, not assumed (`stat()` on that handle SUCCEEDS). Any other open flag on the
root fails `EISDIR`, matching Node's own refusal to open a directory for writing.

**`readdir` of the root is the one root call the shim cannot answer.** Listing it needs the
broker, which refuses the root itself, and the shim has no listing of its own. It fails `EACCES`
with a message naming the gap rather than returning a fabricated empty list. Closing it is a
broker policy change (a read-only listing of the root), not a shim one. A folder inside the root
lists normally.

**A directory fsync of the root is therefore a NO-OP, not a real fsync of anything.**
`orivon.fs` exposes no handle on the root at all, so there is nothing this shim can actually ask
the OS to flush on the app's behalf -- a rename's directory entry is only as durable as the
broker's own `rename()` call already makes it, no more. nedb's own crash-safety model (documented
in `persistence.js`) already tolerates a platform where opening a directory for fsync fails
outright (its own EISDIR handling), so this no-op costs it nothing further than that platform
already costs it; nothing here promises a stronger durability guarantee than the broker's rename
itself provides.
