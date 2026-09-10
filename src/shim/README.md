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

**What it depends on.** [`src/contracts/`](../contracts/).

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
