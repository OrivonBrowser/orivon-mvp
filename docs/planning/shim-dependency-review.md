# Shim dependency review -- queue item 3.1's core polyfills

**What this is.** This repository has zero runtime dependencies today (`package.json`'s
`dependencies` is `null`). Every package below would be the first, which is stop condition 4 in
[`unattended-build-queue.md`](unattended-build-queue.md) -- an owner gate, not something a build
lane can decide on its own. This document is the review that gate asks for, and the batched
question it produces is parked in lane P3-1's log rather than asked eight separate times.

**Method.** Rather than trust [`compatibility-matrix.md`](compatibility-matrix.md) Table 3's
six-module list (plus [`freetube-port-recon.md`](freetube-port-recon.md)'s `zlib`/`util`
correction) as a closed set, this review re-derived need from the real, live dependency tree of
`webtorrent@3.0.21` (the current npm `latest`, published 2026-07-27) and its own dependencies,
fetched from the public registry and read directly (`unpkg`). Every "confirmed" row below has a
file and line behind it, not an inference from documentation.

**Headline finding: the real webtorrent tree is leaner than the floor list assumed.** webtorrent
3.x is a from-scratch rewrite that avoids several Node builtins its predecessor needed --
`streamx` (its own stream implementation, not Node's `stream`) and `uint8-util`'s `hash()` (using
WebCrypto, not Node's `crypto`) both sidestep builtins the matrix listed. But two things the
floor list did **not** name turned up instead: `bittorrent-dht`'s RPC transport
(`k-rpc` -> `k-rpc-socket@1.11.1`) needs real `dns.lookup`, not just `net.isIP` (the already-known
finding, still true -- confirmed at `k-rpc-socket`'s `index.js:3,162`); `dns` is a new, unfiled
gap, noted at the end of this document rather than folded into the package list below, because no
pure-JS polyfill answers it -- it needs actual resolution, which is a broker capability question,
not a shim question.

## The table

| Package | Polyfills | Version | License | Downloads/wk | Last publish | Maintenance | Pure JS | Own transitive deps | `check:natives` |
|---|---|---|---|---|---|---|---|---|---|
| `buffer` | `Buffer` | 6.0.3 | MIT | 149M | 2020-11-23 | Stale by date, but the de facto standard (bundled by webpack, browserify, Vite's own commonjs interop) | Yes | 2 (`base64-js`, `ieee754`) | Pass |
| `events` | `events` (`EventEmitter`) | 3.3.0 | MIT | 63M | 2021-02-27 | Stale by date, standard (webpack 5's own default) | Yes | 0 | Pass |
| `path-browserify` | `path` | 1.0.1 | MIT | 40M | 2020-03-03 | Stale by date, standard (webpack 5's own default) | Yes | 0 | Pass |
| `stream-browserify` | `stream` | 3.0.0 | MIT | 18M | 2020-04-16 | Stale by date, standard | Yes | 2 (`inherits`, `readable-stream`) | Pass |
| `crypto-browserify` | `crypto` | 3.12.1 | MIT | 7.9M | 2024-10-22 | Actively maintained | Yes | 11 (the `browserify-*`/`create-*` family; each individually small and mature) | Pass |
| `os-browserify` | `os` | 0.3.0 | MIT | 7.1M | 2017-04-20 | Stale, smallest ecosystem footprint of the set | Yes | 0 | Pass |
| `browserify-zlib` + `pako` | `zlib` (deflate/gzip only) | 0.2.0 / 3.0.1 | MIT / (MIT AND Zlib) | 19M / n/a | 2017-06-03 / 2026-07-06 | `browserify-zlib` stale; its `pako` dependency pin (`~1.0.5`) predates the actively-maintained `pako` on the registry today | Yes | 1 (`pako`) | Pass |
| `util` | `util` | 0.12.5 | MIT | 37M | 2022-10-16 | Maintained | Yes | 5 (`inherits`, `is-arguments`, `is-generator-function`, `is-typed-array`, `which-typed-array`) | Pass |

All eight are pure JavaScript (no `binding.gyp`, no `prebuilds/`, no native build tooling in any
install script) and pass a local `check:natives`-shaped check on a scratch install. None is
rejected on Rule 8 grounds -- every rejection below is a Rule 6 or evidence argument instead.

## Per-package verdict

**`buffer`, `events`, `path-browserify` -- recommend approve.** Each has a confirmed, direct,
live caller: `bencode` (used by every BitTorrent wire-format package in the tree) reads
`Buffer` via `safe-buffer`; `k-bucket` and `k-rpc-socket` both `require('events')`, and
webtorrent's own `index.js` opens with `import EventEmitter from 'events'`; that same file also
has `import path from 'path'`. No cheaper alternative exists -- these are exactly what the
Node module shape requires, and the packages are the packages every other browser-targeting
bundler already ships as the answer.

**`crypto-browserify` + `stream-browserify` -- recommend approve, as a pair.** `bittorrent-
protocol`'s `mse.js` (protocol encryption, still shipped in the current `5.0.9`) opens with
`import crypto from 'crypto'` and uses it for Diffie-Hellman key exchange and SHA-1 -- confirmed
directly in its source. `stream-browserify` is needed transitively, not directly:
`crypto-browserify`'s `Hash` extends `cipher-base`, which extends `stream.Transform`. This
matches [`orivon-electron`](../../.claude/skills/orivon-electron/SKILL.md)'s own spike findings
from 2026-08-25 exactly, on a materially newer webtorrent release -- the same requirement
survived the 3.x rewrite.

**`util` -- recommend defer the package; build it by hand instead.** The only confirmed live
caller in the whole tree is `k-rpc-socket`'s `util.inherits(RPC, events.EventEmitter)` -- one
function. Taking the npm package to answer one function pulls four more packages
(`is-arguments`, `is-generator-function`, `is-typed-array`, `which-typed-array`) that nothing in
this tree calls. `util.inherits` is a frozen API (Node itself deprecated it in favour of ES6
classes years ago, so its shape will not change under this shim), which makes hand-writing it
safe rather than merely cheap -- see `src/shim/node-util.ts`, built as part of this lane, with
its correctness verified in `src/shim/tests/node-util.test.ts` against real Node's own
`util.inherits`, not against this review's idea of what it should do. **This is a Rule 6
judgment call, not a rejection of the package on any technical ground** -- if a real caller needs
more of `util` later, the honest fix is extending this file, or revisiting this row, not
silently growing a hand-rolled `util` into a second implementation of the npm package.

**`os-browserify` -- recommend defer.** Unlike the other five, no direct or transitive live
caller turned up while tracing webtorrent's real tree in this pass. It stays on the floor
because [`compatibility-matrix.md`](compatibility-matrix.md) Table 3 names it and this review is
not the authority to remove a row that document owns -- but approving a dependency against zero
confirmed callers is the exact anticipated-surface mistake
[`src/shim/README.md`](../../src/shim/README.md) requirement 1 warns about (the `net.isIP`
incident). Recommend revisiting when Phase 3.2/3.3 or Phase 5.1's real run surfaces an actual
caller, at which point the package is also the cheapest answer (0 transitive deps, trivial
surface) -- this is a sequencing recommendation, not a rejection.

**`browserify-zlib` + `pako` -- recommend defer, and flag a real gap underneath it.** No
confirmed live caller in the Node lane (`webtorrent`'s tree, traced directly). The
`freetube-port-recon.md` finding that flagged `zlib` is FreeTube's **main process**
(`brotliDecompress`, for Invidious API responses) -- and FreeTube's renderer, the half that
would actually run inside an Orivon app tab, imports zero Node builtins at all (recon's own
headline finding). Whether that main-process handler ever needs a renderer-side equivalent is a
porting question `unattended-build-queue.md` decision 10 puts out of scope for this round
("the run builds the platform, not porting FreeTube"). Separately, and worth recording regardless
of the caller question: **`browserify-zlib` predates Node's brotli support entirely** (published
2017; Node added `zlib.brotliDecompress` in 2018) and wraps a pinned, old `pako` range that
supplies gzip/deflate only. Approving it today would not close the brotli gap the recon flagged
in the first place -- a real brotli need would mean evaluating a WASM codec (for example
`brotli-wasm`, a `wasm-bindgen` build of the reference Rust implementation) as a separate
decision, not extending this package.

## Rejected alternatives

- **A bundler-provided polyfill plugin** (e.g. `vite-plugin-node-polyfills`), instead of naming
  each builtin's replacement individually. Rejected: it pulls its own opaque dependency set for
  all of Node's builtins at once rather than the eight actually needed, is harder to audit
  package-by-package under Rule 6, and diverges from the precedent already proven in this repo --
  [`orivon-electron`](../../.claude/skills/orivon-electron/SKILL.md)'s week-0 spike verified the
  individual-polyfill approach end to end (a full encrypted BitTorrent handshake, DHT resolution)
  and this review's live registry check confirms the same packages still answer the same real
  calls today.
- **`brotli-wasm` for `zlib`, approved now.** Considered and not recommended yet -- see the
  `browserify-zlib` verdict above. Recording it here because it is the concrete answer if the
  owner wants brotli support decided now rather than deferred.

## What this review does not decide

**`dns` -- a new, unfiled gap, not a package question.** `k-rpc-socket` (underneath
`bittorrent-dht`, underneath `webtorrent`) calls `dns.lookup(peer.host, ...)` for any DHT peer
whose address arrives as a hostname rather than an IP literal. This is not answerable by a
pure-JS polyfill -- real DNS resolution needs either the runtime's own resolver or a broker
capability, and today's `orivon.net` capability (`src/contracts/`) has no such entry. Flagging
this for the owner alongside the parked question below, and for whichever lane builds
`net`/`dgram` (queue item 3.2) or reviews the broker's capability surface -- this lane is not
proposing a fix, only recording where the real call graph actually leads.

## Status

**Resolved 2026-09-10.** The owner approved all eight packages in the table above -- the wider
set, not this review's own five-package recommendation. The reason is continuity of an
unattended overnight run, not a disagreement with the evidence above: a lane discovering at 3am
that it needs `os` or `zlib` would otherwise stop and wait for an owner who is asleep. Paying for
two dependencies with no confirmed caller (`os-browserify`, `browserify-zlib` + `pako`) is judged
cheaper than losing a night. This review's tracing of the real `webtorrent@3.0.21` dependency
tree stands unchanged -- the owner weighed the same evidence and chose differently on Rule 6,
not different evidence.

Landed in `stream/shim-03-approved-deps`: all eight added to `package.json`'s `dependencies`
(previously `null`) at the versions in the table above, `src/shim/module-map.ts`'s rows flipped
from `pending-dependency` to `ready`. Two riders survive the approval and are recorded where a
future reader will actually hit them, not just here:

- **The `zlib` row's approval does not close the brotli gap.** `browserify-zlib` predates Node's
  own brotli support and supplies gzip/deflate only, via its pinned `pako` dependency. A real
  brotli need is still a separate WASM-codec decision (`brotli-wasm` is the concrete answer this
  review recorded above) -- see `module-map.ts`'s `zlib` row for the same note in the place a
  contributor is more likely to read it.
- **The `util` package is approved but deliberately not wired in.** `src/shim/node-util.ts`'s
  hand-written `inherits`-only implementation stays -- it is already tested against real Node's
  `util.inherits`, this review's own Rule 6 reasoning for writing it by hand did not change just
  because the package cleared the dependency gate, and running both would be a second
  implementation of the same idea (`code-guidelines.md` Rule 3). The `util` package sits in
  `package.json` unused for now; extend `node-util.ts`, not the package, if a real caller needs
  more of `util` later.

`dns` is unchanged by this approval -- still a broker-capability question
(`k-rpc-socket` needs real `dns.lookup`), not a package this review could answer, and not
addressed in this lane.
