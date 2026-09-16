# `src/shim/` — `orivon-node-shim`

**What lives here.** Two different kinds of thing, and the distinction matters:

1. Node's `net`, `dgram` and `fs` APIs, reconstructed on top of `orivon.*`, so that ordinary
   Node libraries run unmodified inside a renderer. Load-bearing, not a developer nicety:
   without it the flagship cannot be a URL-delivered app
   ([`ADR-0005`](../../docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
2. **Core polyfills** (queue item 3.1) — the environment-shape modules a dependency graph
   needs just to *evaluate*, independent of any capability: `Buffer`, `stream`, `events`,
   `path`, `os`, `crypto`, `zlib`, `util`. `compatibility-matrix.md` Table 3 calls these `dup`
   rows: closing them is ordinary shim work, no contracts change needed. This directory's own
   scope statement used to name only the first group — corrected here because Table 3 already
   called that gap out as "narrower than Table 2's family, and owned by nobody".

`globals.ts` (ambient `process`/`nextTick`/`setImmediate`) and `module-map.ts` (the single table
`electron.vite.config.ts`'s alias map is generated from — see its own header) belong to neither
group cleanly; both exist to make the two above reachable at all.

**Dependency status.** All eight core polyfills are wired up. The owner approved the full set
2026-09-10 (the wider set, not the review's own five-package recommendation — see
[`docs/planning/shim-dependency-review.md`](../../docs/planning/shim-dependency-review.md)'s
`## Status` for why), and this repository's first runtime dependencies now live in
`package.json`. `util` is the one exception worth knowing about: the `util` package is installed
and approved, but `module-map.ts` still points `util` at a hand-written, `inherits`-only file
(`node-util.ts`) rather than the package — Rule 6 reasoning is in that file and the review, and
it did not change just because the package cleared the dependency gate. The `zlib` row is
gzip/deflate only (`browserify-zlib` predates Node's brotli support) — see the review before
assuming brotli works.

**What it depends on.** [`src/contracts/`](../contracts/), and
[`src/shim-electron/unimplemented.ts`](../shim-electron/unimplemented.ts)'s `refusingProxy` --
see §Design notes below.

**What it must never import.** `electron`, or [`src/broker/`](../broker/). The shim runs in the
renderer and reaches the broker only through `orivon.*`. Importing the broker would hand it
main-process authority it must not have.

**Owner stream.** `shim` — build step 3. Also owns the `renderer.resolve.alias` map in
`electron.vite.config.ts`; no other stream writes there.

**Five binding requirements** from [`handle-contracts.md`](../../docs/architecture/handle-contracts.md)
§What the shim must do. Read them before writing a line here — each cost real time to discover:

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

**Polyfill-grade vs Orivon-grade primitives, and why the gap is documented rather than closed
here (A132, T26 in `docs/architecture/security-model.md`).** The placement is the mitigation, and
it is the right one: the eight core polyfills (`Buffer`, `stream`, `events`, `path`, `os`,
`crypto`, `zlib`, `util`) run inside the untrusted renderer, on the far side of the broker's
boundary, so a backdoored `crypto-browserify` cannot reach a socket the broker never authorised --
that is what makes admitting nine third-party packages (one carrying an advisory,
`shim-dependency-review.md`) survivable at all. **The gap T26 names:** an app calling
`crypto.createHash(...)` through `module-map.ts` cannot tell it is getting a polyfill rather than
a vetted primitive, and the two differ in security properties -- `orivon.id.*`'s WebCrypto-backed
signing is a different grade from what this package presents under an unrelated name (`crypto`).
This package does not invent an API to distinguish them; that would be a `src/contracts/` change,
decided elsewhere. **AI recommendation, not built:** some way for an app to ask which grade a
given primitive is would need to live in `src/contracts/`, not here.

**Refusing an unimplemented member by name, not by absence (A135).** Before this, a caller
reaching `dns.resolve4(...)` or `socket.setBroadcast(...)` got a bare `TypeError: ... is not a
function` -- no name, no reason, no pointer to whether the gap is unbuilt, refused by design or
simply never considered. `src/shim-electron/` (`unimplemented.ts`, PR #151) already solved this
for the `electron` compatibility package; this extends the same mechanism here rather than
re-inventing it, on two module-namespace exports at a time: `node-dns.ts`, `node-fs.ts`,
`node-http.ts`/`node-https.ts` and `node-net.ts` each wrap their default export (the shape a
bundled CJS `require(...)` resolves to) with `refusingProxy`, so any member they have not built
throws a named, closed-reason `OrivonShimError` (`errors.ts`) when a caller CALLS it, instead of
a bare `TypeError`. **Corrected (A169):** the first shipped version of this threw on the READ
itself, not the call -- see this section's last entry below for why that was a regression, and
why the fix moved the throw from `get` to the returned value's invocation instead.

**What `refusingProxy`'s `get` trap returns for an unbuilt member, and the one case it cannot
honestly cover (A169).** `unimplemented.ts`'s `refusingFunction` -- named after the prop it
stands in for, so a stack trace reads legibly -- so `typeof`, optional chaining and destructuring
all see a real, present function instead of throwing on the mere read; only calling it runs
`classify(prop)`'s Error. This is a deliberate, unavoidable trade-off, not a free win: a function
is the one JS value that is both safe to merely hold (`typeof f === 'function'` never throws) and
throws precisely when invoked, but `typeof` on it necessarily reports `'function'`, never
`'undefined'` -- there is no way to make a value both callable-when-invoked and typeof-false at
the same read (a `Proxy`'s callability, and hence its `typeof`, is fixed by its target at
construction, not by any trap; verified empirically, not just from the spec, before this was
accepted as final). For the vast majority of this surface (`fs.watchFile`, `dns.resolve4`, ...)
that is the right answer anyway, since real Node genuinely does expose them as functions --
`typeof` reporting `'function'` is the TRUTHFUL answer for those, matching what real Node itself
would say, and the important part of the regression (reading no longer *throws*) is fully fixed.
The one place a throwing function would be dishonest is a member real Node exposes as DATA, not a
function -- `fs.constants`, `dns.promises` -- where `typeof` should say `'object'`/`'undefined'`,
which no throwing function can do. `node-fs.ts` and `node-dns.ts` handle these two by name,
listing them in `refusingProxy`'s own `known` object with an explicit `undefined` value rather
than routing them through `otherFsMember`/`otherDnsMember` -- genuinely absent, the same as a
member never considered at all, rather than faked as callable. This does mean `'constants' in fs`
and `'promises' in dns` report `true` (the key exists, valued `undefined`) where every other
unbuilt member reports `false` -- a deliberate, narrow exception for the two names this package
has explicitly decided it cannot honestly present as functions, not a hole in the `in`-truthful
guarantee for anything else.

**Why this package's own `OrivonShimError`/`ShimRefusalReason`, not `shim-electron`'s
`ElectronShimError`.** Same shape, deliberately not the same union -- a Node-stdlib gap and an
Electron desktop-shell gap are different situations for a porting developer (code-
guidelines.md Rule 3: "same shape is not the same reason"). Four reasons, reconciling A135's own
wording ("unbuilt, refused by design, or a gap nobody noticed") with this package's actual
gaps: `'not-built'` (a decision is on record and a build path is named -- `FileHandle.createReadStream`/
`createWriteStream`'s A184 is the live example; `dns.lookup`'s D-0006 and `net.createServer`'s A114
were this reason's original examples and are now built), `'unimplemented'` (nothing has decided either way -- most of the
surface here), `'excluded'` (an owner policy row, compatibility-matrix.md Table 1's 🚫 rows --
not currently emitted by any file in this package: `hid`/`subprocess` have no shim target yet,
and ambient-FS exclusion is enforced by the broker's path policy, not by a member name), and
`'not-applicable'` (a real Node member exists because of a runtime concept -- an event-loop
handle, a POSIX uid/gid -- with no Orivon equivalent; a substrate difference, not a capability
gap). `fs.chmod`/`chown` are this package's `'not-applicable'` example.

**Why the mechanism is imported directly from `src/shim-electron/`, not moved to
`src/shared/`.** `src/shared/` exists specifically for a helper needed on the `src/broker/` <->
`src/shim/` trust boundary (CLAUDE.md, `src/shared/README.md`'s own "two callers on opposite
sides of a boundary" bar) -- two directories that must never import each other because one holds
main-process authority. `src/shim-electron/` sits on the *same* side of that boundary as this
package: both are renderer-only, hold no broker access, and are already named as sibling
families under `compatibility-matrix.md` Table 2. Routing this through `src/shared/` would
stretch that directory past the crossing it was built for, for no benefit. `refusingProxy` itself
needed generalising first (`classify` now returns the `Error` to throw directly, rather than a
record `shim-electron` used to convert via a hardcoded `refuse()` call) so this package's error
type flows through it without `shim-electron` knowing this caller exists -- see
`src/shim/unimplemented.ts` and `src/shim-electron/unimplemented.ts`'s own header. **AI
recommendation, not an owner decision** -- nothing in either package's "must never import" list
forbids this one direction (`src/shim-electron/`'s list forbids the reverse), but the choice
itself was not put to the owner.

**Why `net.Socket`/`dgram.Socket` instances are NOT wrapped the same way.** A throw-on-*read*
proxy is exactly wrong for a stateful, duck-typed instance real Node libraries feature-detect
before calling (`if (typeof socket.setBroadcast === 'function') ...`, `'unref' in socket`) -- it
would make that defensive check itself throw, turning a graceful, intentional skip into a crash.
That would be a *regression*, not an improvement -- **and it is exactly the regression A169 found
`refusingProxy` itself shipped with at the module-namespace grain** (`node-net.ts`/`node-dns.ts`/
etc.), months after this paragraph named the failure mode; A169's fix (the entry above) makes
`refusingProxy` itself safe to read, closing that gap at its source. `class` prototypes remain
non-writable/non-configurable regardless (`Socket.prototype = proxy` throws), so wrapping is
still not mechanically available at the prototype level the way it is for a plain exported
object -- that structural reason, not the now-fixed throw-on-read behaviour, is why instances
stay on their own mechanism. `node-net-socket.ts` and `node-dgram-socket.ts` add the handful of
real Node members a porting app is likely to hit as actual present methods -- the same "present,
throws when called" shape `node-fs-unsupported.ts`'s `syncUnsupported`,
`node-http-unsupported.ts`/`node-net-unsupported.ts`'s `createServer`, and `refusingProxy` itself
(post-A169) all use for their own decided gaps. Two of those (`ref`/`unref`) are safe NO-OPS
rather than throws: real Node's contract for them is "no meaning, returns `this`", so a no-op is
the objectively correct behaviour here too (there is no event-loop handle to ref/unref in this
environment) -- throwing would be strictly worse than today's absence for any caller that
already guards them defensively. The rest (`setTimeout`, `setBroadcast`, the multicast family)
throw when called: a silent no-op there would misreport a real capability as applied instead of
naming the gap, which is the exact failure A135 exists to fix.
