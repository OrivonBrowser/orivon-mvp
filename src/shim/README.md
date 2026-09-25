# `src/shim/`: `orivon-node-shim`

**What lives here.** Two different kinds of thing, and the distinction matters:

1. Node's `net`, `dgram` and `fs` APIs, reconstructed on top of `orivon.*`, so that ordinary
   Node libraries run unmodified inside a renderer. Load-bearing, not a developer nicety:
   without it no Node.js app can be a URL-delivered app
   ([`ADR-0005`](../../docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
2. **Core polyfills** (queue item 3.1): the environment-shape modules a dependency graph
   needs just to *evaluate*, independent of any capability: `Buffer`, `stream`, `events`,
   `path`, `os`, `crypto`, `zlib`, `util`, plus the hand-written `url`, `querystring`,
   `string_decoder`, `timers` and `assert`. `compatibility-matrix.md` Table 3 calls these `dup`
   rows: closing them is ordinary shim work, no contracts change needed.

| Folder | Holds |
|---|---|
| (top level) | `globals.ts`, `virtual-root.ts` and `module-map.ts` (belong to neither group cleanly; they exist to make the two below reachable at all), plus the package-wide error mapper (`node-errors.ts`), the error/refusal machinery (`errors.ts`, `unimplemented.ts`), `orivon-global.ts` and `stream-bytes.ts` |
| [`fs/`](fs/) | Node's `fs` over `orivon.fs` |
| [`net/`](net/) | `net`, `tls`, `dgram` and `dns` over `orivon.net` |
| [`http/`](http/) | `http` and `https`, over `net/`'s real socket |
| [`polyfills/`](polyfills/) | The eight core polyfills |

**A bundler consuming this directory must alias each specifier exactly.** Every row matches its
specifier whole, bare or `node:`-prefixed (`aliasPattern`), because an alias that also captures
subpaths rewrites the shim's own imports into the shim itself: `polyfills/util.ts` imports the
package's `util/util.js`, which a prefix alias for `util` would send back to `polyfills/util.ts`.
`electron.vite.config.ts` and `test/e2e-app-loader-journey.test.ts`'s esbuild plugin both match
exactly for that reason; esbuild's own `alias` option cannot. A port that builds against
`src/shim/` with its own bundler needs the same, one exact entry per specifier (in webpack,
`resolve.alias` keys with the `$` suffix, `util$`), and the `node:`-prefixed forms mapped too.

**Tests run against the page's polyfills.** `vitest.config.ts` resolves a shim module's own
`stream`, `buffer`, `events`, ... imports to the same modules the renderer build does, so a
shim test exercises readable-stream 3 and the `buffer` package, not Node's builtins. A test
file and its `tests/support/` helpers keep `node:*`; `tests/support/page-buffer.ts` and
`page-stream.ts` give a test the page's own classes when it must compare against them.

**Dependency status.** All eight core polyfills are wired up, and their packages are runtime
dependencies in `package.json`.
[`docs/planning/shim-dependency-review.md`](../../docs/planning/shim-dependency-review.md)'s
`## Status` says why the full set was chosen over that review's own five-package
recommendation. `os` and `util` point at local wrappers over their packages (`polyfills/os.ts`,
`polyfills/util.ts`) that correct or complete them; see [`polyfills/README.md`](polyfills/README.md).
The `zlib` row is gzip/deflate only (`browserify-zlib` predates Node's brotli support); see the
review before assuming brotli works.

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

**Why `fs/`, `net/`, `http/` and `polyfills/` are each their own folder.** See
[`fs/README.md`](fs/README.md), [`net/README.md`](net/README.md), [`http/README.md`](http/README.md)
and [`polyfills/README.md`](polyfills/README.md) for what belongs to each and why it is shaped
the way it is; this file covers only what is common to the whole directory, or belongs to a
top-level file.

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

**Refusing an unimplemented member by name, not by absence (A135).** Without this, a caller
reaching `dns.resolve4(...)` or `socket.setBroadcast(...)` would get a bare `TypeError: ... is not
a function`: no name, no reason, no pointer to whether the gap is unbuilt, refused by design or
simply never considered. `src/shim-electron/`'s `unimplemented.ts` solves this for the `electron`
compatibility package, and this package reuses the same mechanism rather than re-inventing it,
on two module-namespace exports at a time: `net/dns.ts`, `fs/fs.ts`,
`http/http.ts`/`http/https.ts` and `net/net.ts` each wrap their default export (the shape a
bundled CJS `require(...)` resolves to) with `refusingProxy`, and every other module target
here does the same through [`polyfills/module-proxy.ts`](polyfills/module-proxy.ts)'s `nodeModule`,
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
would say, and merely reading the member never throws. The stand-in is an ordinary `function`,
never an arrow, and the same one for every read of a member through one proxy: `new member()` and
`class X extends member` construct fine at definition and refuse by name at construction,
`x instanceof member` answers `false`, and two reads compare equal. An arrow has no prototype,
so each of those would otherwise fail with a bare `TypeError` naming nothing.
The one place a throwing function would be dishonest is a member real Node exposes as DATA, not a
function -- `fs.constants`, `dns.promises` -- where `typeof` should say `'object'`, which no
throwing function can do. `fs/fs.ts` and `net/dns.ts` handle both by name in `refusingProxy`'s
own `known` object rather than routing them through `otherFsMember`/`otherDnsMember`. **Both hold
real values**: `fs.constants` (`fs/constants.ts`) carries the four `access()` mode flags a
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

**Every stream here passes `autoDestroy` and `emitClose` explicitly.** The renderer's `stream` is
readable-stream 3 (`stream-browserify`), which defaults `autoDestroy` to false; without the
option, a `net.Socket` whose two sides have both ended never emits `'close'` and never closes its
broker handle, and vitest, which resolves `node:stream`, would not show it. `ClientRequest` is the one
exception, with `autoDestroy: false` on purpose: Node's request emits `'close'` when the whole
exchange is over, not when its body has been sent, so it is destroyed explicitly once the response
ends or fails. Every `destroy()` override is idempotent, because readable-stream 3 re-emits
`'error'` when a destroyed stream is destroyed again with one, and that second `'error'` is an
uncaught exception for an app that already handled the first. `tests/support/`'s lifecycle
suites run each check under both stream implementations for this reason.

**[`node-errors.ts`](node-errors.ts) gives a mapped error Node's `errno`, in Linux
numbering.** A real `platformCode` is always used when the broker sends one. When it is absent,
the Node code is synthesised from the Orivon code and the operation: `timeout` becomes
`ETIMEDOUT`, `reset` becomes `ECONNRESET`, `unreachable` becomes `ENOTFOUND` during a lookup and
`ECONNREFUSED` otherwise, and `closed` during a write becomes `EPIPE`. `denied` never becomes an
errno. The negative numbers are Linux's (and libuv's `EAI_*`); Node's own differ on macOS and
Windows, but code branches on `err.code`, and the renderer has no platform table to read. An error
that already carries a string `code` keeps it.

**One virtual root: `/orivon/app` ([`virtual-root.ts`](virtual-root.ts)).** **AI recommendation,
not owner-reviewed.** Node code builds paths from `process.cwd()`, `os.homedir()`, `os.tmpdir()`,
`$HOME`/`$APPDATA` and, in an Electron port, `app.getPath('userData')`, then hands them to `fs`.
All of them name `/orivon/app` (the tmpdir is `/orivon/app/tmp`), and
[`fs/paths.ts`](fs/paths.ts)'s `confine` strips that prefix before any `orivon.fs` call,
so `path.join(os.homedir(), 'settings.json')` lands in the app's own files. `orivon.fs` itself
still takes only relative paths: the broker rejects every absolute one
([`../broker/policy/paths.ts`](../broker/policy/paths.ts)), and the mapping lives here, one layer
up, where the Node-shaped paths are. A relative path passes through exactly as written. A path
outside the root, absolute or by `..`, fails `EACCES` in the shim without reaching the broker:
the errno Node gives for a directory the process may not enter, where the broker would only say
`'denied'`. The tmpdir is created with one `mkdir -p` the first time a path inside it is used,
since Node's always exists and the app's files start empty. The value is not a real host path
and is not meant to look like one: a library branching on it cannot mistake it for a platform
directory it knows.
