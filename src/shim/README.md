# `src/shim/`: `orivon-node-shim`

**What lives here.** Two kinds of thing:

1. Node's `net`, `dgram`, `fs`, `tls`, `dns` and `http` APIs rebuilt on `orivon.*`, so ordinary
   Node libraries run unmodified in a renderer. Without it no Node.js app can be a URL-delivered
   app ([`ADR-0005`](../../docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
2. **Core polyfills**: the modules a dependency graph needs just to *evaluate* (`Buffer`,
   `stream`, `events`, `path`, `os`, `crypto`, `zlib`, `util`, plus hand-written `url`,
   `querystring`, `string_decoder`, `timers`, `assert`), the `dup` rows of
   [`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md) Table 3.

| Folder | Holds |
|---|---|
| (top level) | `globals.ts`, `virtual-root.ts`, `module-map.ts` (the alias table), `node-errors.ts`, `errors.ts`, `unimplemented.ts`, `orivon-global.ts`, `bind-scope.ts`, `stream-bytes.ts`, `encoding.ts`, `warn-once.ts` |
| [`fs/`](fs/) | Node's `fs` over `orivon.fs` |
| [`net/`](net/) | `net`, `tls`, `dgram` and `dns` over `orivon.net` |
| [`http/`](http/) | `http` and `https`: the client, and `http.createServer`, over `net/`'s real socket and listener |
| [`polyfills/`](polyfills/) | The core polyfills |
| [`wasi/`](wasi/) | A WASI preview1 host over `orivon.fs`, and Node's `wasi` module over it |
| [`wasi-p2/`](wasi-p2/) | A WASI 0.2 host over `orivon.fs` and `orivon.net`, for a component `spawn` runs from jco's output |
| [`worker/`](worker/) | What a child needs to run in a Web Worker, its `orivon.*` calls carried to the page |
| [`child-process/`](child-process/) | Node's `child_process` over those Workers |
| [`addon/`](addon/) | Native addons, loaded as their WebAssembly builds through emnapi |

**A bundler must alias each specifier exactly** (`module-map.ts`'s `aliasPattern`). A prefix
alias also captures subpaths and sends the shim's own imports back into the shim
(`polyfills/util.ts` imports `util/util.js`). A port bundling against `src/shim/` with its own
bundler needs one exact entry per specifier, `node:` forms included (webpack: `util$`).

**Tests run against the page's polyfills** (`vitest.config.ts`), not Node's builtins. Test files
and `tests/support/` keep `node:*`; `tests/support/page-buffer.ts` and `page-stream.ts` give a
test the page's own classes.

**`zlib` is gzip/deflate only**: `browserify-zlib` predates brotli. Why each polyfill package was
chosen: [`shim-dependency-review.md`](../../docs/planning/shim-dependency-review.md) §Status.

**What it depends on.** [`src/contracts/`](../contracts/), and
[`src/shim-electron/unimplemented.ts`](../shim-electron/unimplemented.ts)'s `refusingProxy`, the
one import across the two sibling packages (`unimplemented.ts` says why not `src/shared/`;
provisional until the owner confirms it, A160). Its npm dependencies are the polyfill packages
and `@emnapi/core` and `@emnapi/runtime`, which `addon/` loads native addons' WebAssembly builds
through (`d-0163`).

**What it must never import.** `electron`, or [`src/broker/`](../broker/). The shim runs in the
renderer and reaches the broker only through `orivon.*`; importing the broker would hand it
main-process authority.

**Owner stream.** `shim`, build step 3. It also owns the renderer alias map, generated from
`module-map.ts`.

**Binding requirements.** Read
[`handle-contracts.md`](../../docs/architecture/handle-contracts.md) §What the shim must do
before writing a line here; code cites its rules by number:

1. Completeness is measured against a dependency's real call graph (`net.isIP()`, which
   `bittorrent-dht` calls before every send).
2. A polyfilled timing primitive makes errors louder, never quieter (`globals.ts`).
3. Every reply over a `MessagePortMain` has an explicit timeout.
4. No transferables on the renderer -> main path (`electron#34905`).
5. Synchronous accessors are served from values captured at acquisition.
6. The raw `MessagePortMain` never enters the main world.

Also read [`.claude/skills/orivon-electron/SKILL.md`](../../.claude/skills/orivon-electron/SKILL.md).

## Design notes

**`globals.ts` writes its globals by plain assignment**, never a locked `defineProperty`:
[`ADR-0021`](../../docs/decisions/ADR-0021-page-globals-carry-the-platform-descriptor.md).
`npm run check:page-globals` and `tests/globals.test.ts` guard it.

**`process` answers what libraries read without claiming to be Node.** Provisional (`d-0079`):
each value and its reason is in `globals-types.ts`; where a `nextTick`/`setImmediate` error goes,
and why `setImmediate` is a `MessageChannel` task, is in `globals.ts`.

**Refusing an unbuilt member by name (A135, A169).** `net/net.ts`, `net/dns.ts`, `fs/fs.ts` and
`http/http.ts`/`https.ts` wrap their default export with `refusingProxy`; every other module does
it through [`polyfills/module-proxy.ts`](polyfills/module-proxy.ts)'s `nodeModule`. An unbuilt
member throws a named `OrivonShimError` when **called**, never when read, so feature detection
(`typeof`, `?.`, destructuring) cannot crash. The cost: `typeof` says `'function'`, which is true
of real Node for almost all of this surface. A member Node exposes as **data** (`fs.constants`,
`dns.promises`) must be listed in `refusingProxy`'s `known` with a real value; a throwing stand-in
would lie about its type.

**The same refusal reaches a bundled CommonJS `require()` too (A287).** The proxy above only
guards the *default* export; a bundler's CJS interop can hand `require()` the module's ESM
*namespace* instead (esbuild does), where an unbuilt member was plain `undefined`. Each covered
local module target re-exports a generated file, `<its own folder>/generated/<name>.ts`
(alongside the module it stands in for, rather than pooled elsewhere, so a reader already in
that folder sees both halves) -- one named export per Node function/class member the module does
not provide itself, throwing the identical `OrivonShimError` its own classify function already
throws for that name. An explicit export of the same name in the hand-written module shadows the
generated one, so a member this shim later builds drops its stand-in on the next regeneration. A
member Node exposes as data gets no stand-in there either (same reason as above), and is listed
in that file's `DATA_GAPS` instead. [`node-builtin-exports.ts`](node-builtin-exports.ts) is the
checked-in list of what real Node exports per module-map.ts specifier -- compared against, never
against a live `require()` (CI's Node version is not guaranteed to be the one it was written
from). [`tests/generated-refusals.test.ts`](tests/generated-refusals.test.ts) freshness-checks
every generated file and rewrites them with `ORIVON_WRITE_SHIM_REFUSALS=1`.
[`tests/support/generated-refusal-targets.ts`](tests/support/generated-refusal-targets.ts) lists
which local targets this covers, and why the subpath rows (`fs/promises` and the like) do not
yet have one.

**Why a second error class.** A Node-stdlib gap and an Electron desktop-shell gap are different
situations for a porting developer (code-guidelines Rule 3), so this package has its own
`OrivonShimError`; `errors.ts` documents its four reasons.

**Every stream here passes `autoDestroy` and `emitClose` explicitly.** The page's `stream` is
readable-stream 3, which defaults `autoDestroy` off: a `net.Socket` whose sides have both ended
would never emit `'close'` or release its broker handle, and vitest on `node:stream` would not
show it. `ClientRequest` is the exception (`http/client.ts` says why). Every `destroy()` override
is idempotent: readable-stream 3 re-emits `'error'` on a second destroy, an uncaught exception for
an app that handled the first. `tests/support/`'s lifecycle suites run under both streams.

**`node-errors.ts` synthesises errnos in Linux numbering** (`d-0078`). Node's differ on macOS and
Windows, but code branches on `err.code`, and the renderer has no platform table to read.

**One virtual root: `/orivon/app` ([`virtual-root.ts`](virtual-root.ts)).** Provisional
(`d-0073`). `process.cwd()`, `os.homedir()`, `$HOME`, `$APPDATA` and Electron's
`app.getPath('userData')` all name it; `tmpdir` is `/orivon/app/tmp`, created on first use.
[`fs/paths.ts`](fs/paths.ts)'s `confine` strips it before any `orivon.fs` call, since the broker
takes only relative paths. A path outside it fails `EACCES` in the shim, the errno Node gives,
where the broker would only say `'denied'`. The value is deliberately no real host path, so no
library can mistake it for a platform directory it knows.
