# Build step 4, the app loader: what is left, and in what order

> **All seven items below shipped the same day this plan was written** (thirteen merged PRs,
> #163-#175). Kept here as the work log this pass actually followed, not as a live queue;
> `docs/planning/compatibility-matrix.md` and `src/loader/README.md` carry current status.

**What this is.** The work queue for build step 4, written 2026-09-13 against `main` at
`76c61e0`. It exists because step 4 is not a green field: most of the loader was built during
the 2026-09-10 unattended run, and what remains is the wiring that makes it reachable. Starting
from `build-plan.md`'s step-4 paragraph alone would rebuild things that already work.

**Read first.** [`unattended-build-queue.md`](../../.claude/unattended-build-queue.md). This plan finishes
its Phase 4 and adds the three items that Phase 4 assumed someone else had done.
[`unattended-run-protocol.md`](../../.claude/unattended-run-protocol.md) covers
how the run behaves, which is separate from what it builds.

---

## The one-sentence shape

A page says *"I am also an app"*; Orivon fetches the files that page declares, hashes them into
one bundle hash, pins it, caches the bytes, asks the person once what the app may do, and from
then on serves that origin from disk with exactly the authority they granted.

## What already works, so nobody rebuilds it

| Piece | Where | State |
|---|---|---|
| Manifest discovery, validation, asset fetch, bundle hash, pinning, cache write | [`src/loader/`](../../src/loader/) | Built, unit-tested |
| The update decision (silent / re-consent / capability-prompt / rollback / reject) | [`src/broker/policy/update.ts`](../../src/broker/policy/update.ts) | Built, table-tested |
| Loader-to-broker glue, serialised per origin | [`src/main/install/app-install.ts`](../../src/main/install/app-install.ts) | Built, no caller |
| The consent mechanism: narrow to manifest, prompt, grant | [`src/main/consent/request-grant.ts`](../../src/main/consent/request-grant.ts) | Built, no caller |
| The dialog's words, breadth visible | [`src/main/consent/grant-prompt-render.ts`](../../src/main/consent/grant-prompt-render.ts) | Built, tested |
| The permissions list, with revocation | [`src/main/permissions/permissions.ts`](../../src/main/permissions/permissions.ts) | Built, shipped |
| Per-app session partitions, `fetch()` routing flag | [`src/main/shell/tab-view.ts`](../../src/main/shell/tab-view.ts) | Built, shipped |
| Grant persistence across restart, version floor, rollback acknowledgement | [`src/broker/grants/`](../../src/broker/grants/) | Built, shipped |

`ADR-0007`'s mechanism was probed live on 2026-09-10 and passes on all three counts it rests on:
per-partition interception, a range-capable streaming response, and a secure context for service
workers. The fourth question probed that day came back negative and constrains item S4-6 below
(`A110`).

## The seven items

Ordered by dependency, not by size. Each names its exit criterion: the thing that must be
demonstrably true, not "the code is written".

### S4-1: `app.requestGrant` reachable from a page

**Why first:** it is small, and it is the single row that has gated the whole project
(`compatibility-matrix.md` Table 4 row 1). The mechanism, the policy and the dialog all exist;
no page-facing entry point does, so a real app still cannot ask for anything.

A control-channel case in [`src/broker/transport/ipc.ts`](../../src/broker/transport/ipc.ts)
turning a page's call into `ctx.requestGrant(origin, request)`, with the origin taken from
`event.senderFrame` and never from the payload (T3), plus the preload surface method.

**Exit:** a real page calls `orivon.app.requestGrant(...)`, a dialog appears, accepting it
produces a persisted grant, and a request naming something the manifest does not declare is
refused with no dialog shown.

**Also in this item, and not optional:** `README.md`'s status banner says no app can ask for a
permission yet. That sentence becomes false here and is corrected in the same PR (`D-0013`).

### S4-2: the discovery trigger

**Why second:** nothing installs anything today. `ctx.loader` is published and read by nobody;
`installFromHint` has no caller. This is the top of the funnel.

A `<link rel="orivon-manifest">` hint in a page's own delivered HTML is the only trigger that
exists: there is no "Open as app" action, because a Web3site is the URL, not a thing a user
converts a website into. The hint is read page-side and reported over IPC; **main derives the
origin from `event.senderFrame`, never from the message**, and refuses a hint whose URL does not
resolve to exactly that origin (`app-install.ts` already enforces this; the listener must not
work around it).

**Exit:** a real page carrying a hint causes a real install, and a hint naming a different
origin than the page's own installs nothing.

### S4-3: serving the cached bundle at its own origin

**Why third and why it is the largest:** the loader writes bytes to disk that nothing ever reads
back. Until this exists, "installed" means "downloaded and forgotten".

`session.fromPartition(...).protocol.handle('https', ...)` scoped to the app's own partition
(`ADR-0007`), serving pinned assets from disk with a range-capable streaming response. Three
properties are the security boundary, not features:

- **Fail closed.** A same-origin request whose path is not in the pinned set is denied, not
  fetched from the network.
- **Re-verified at every load**, not only at fetch. A file changed on disk between runs must not
  be served.
- **Partition-scoped, never global.** The same URL in an ordinary tab reaches the real network.
  A global interception would mean Orivon silently serving stale local bytes for a real website.

Needs a read half on [`src/loader/storage.ts`](../../src/loader/storage.ts), which today can
only write: `readAsset(origin, path)`, plus the node-backed implementation.

**Exit:** an installed app loads from disk with the network unplugged; a planted extra file at
the app's origin is refused; the same URL in a non-app tab still reaches the network.

### S4-4: consent asked once, before the app runs

Per `d-0025` (`ADR-0012`'s 2026-09-13 amendment). After install and before the app's
own scripts execute, the person is asked once, in one dialog, for the whole set the manifest
declares, with breadth visible. All-or-nothing while `A138` is parked.

**A hard requirement `A137` records and nothing else does:** every capability call gates purely
on the grant ledger. `registerApp` must be called with a **freshly fetched** manifest before any
capability call is allowed, and `isRegisteredSync` returning true must never be read as evidence
that a live check happened.

**Exit:** a first visit to an app declaring capabilities asks once and grants what was accepted;
a second visit is silent; an app declaring nothing is never asked about; a declined dialog leaves
the app installed and every capability denied.

### S4-5: the three outcomes nothing drives

`load()` returns `needs-reconsent`, `needs-capability-prompt` and `needs-rollback-choice` with
the fetched bytes in hand, specifically so a caller can persist after approval without
re-fetching. No caller exists, so an app that widens what it asks for currently just stops.

Needs a loader entry point that installs an already-fetched, already-validated bundle, so
approval does not mean a second trip to the network (and a second chance for the server to serve
something else).

**Exit:** an app whose update widens its patterns raises the re-consent dialog; accepting it
installs the bytes already fetched; declining leaves the previously pinned bundle in place and
running.

### S4-6: CSP on the served bundle, and honest delivery provenance

[`connect-src.ts`](../../src/broker/policy/connect-src.ts) computes the header value; nothing
applies it. **`onHeadersReceived` never fires for a `protocol.handle` response in Electron 44
(`A110`)**, so the header is set on the handler's own `Response`, which the handler already fully
controls. Do not wire `webRequest` and assume it works; that is the exact trap `A110` records.

`ADR-0007` also calls the padlock a false claim once bytes come from disk, and says correcting it
is not optional polish. The delivery ladder exists in [`src/trust/`](../../src/trust/) and is
wired to nothing.

**Exit:** a served bundle carries a `connect-src` matching what the app was actually granted,
proven by a page whose fetch to a non-granted host is blocked by the browser rather than by the
broker; and the address bar says the bytes came from local cache.

### S4-7: the end-to-end test that would catch all of it regressing

`build-plan.md` has specified this since the beginning and it has never existed in full: a
fixture app served over localhost HTTP with a real `/.well-known/orivon.json`, loaded through
the discovery trigger, granted through the real dialog path, reaching a local echo server
through the shim, **and then attempting a connection outside its manifest patterns and being
refused.**

That last clause is the highest-value assertion in the plan: without it, nothing fails if
capability enforcement degrades to allow-all.

**Exit:** the suite passes under `xvfb-run npm run test:e2e`, one Electron launch at a time, and
leaves no surviving process and no temp profile behind.

## What is deliberately not here

- **A per-row consent choice.** Parked as `A138`; all-or-nothing is built.
- **The folder picker (`fs.userSelected`)** and **`id.requestIdentity`'s prompt**, which are Phase 4
  items 4.3 and 4.5. Both need `fs.open`/`FileHandle` or the identity path first, and neither is
  on the line between "an app installs" and "an app runs with the authority a person gave it".
- **`net.listen`'s page wiring**, blocked on a nested-port IPC shape (`A114`), unrelated to
  this step.
- **Anything in `mvp-scope.md`'s excluded rows.** Ambient filesystem, `subprocess`, `hid`/USB are
  refusals, not gaps.

## Order and what may run at once

    S4-1 ──┬─────────────────────────► S4-4 ──┐
           │                                   ├──► S4-7
    S4-2 ──┴──► S4-3 ──┬──► S4-6 ───────────── ┘
                       └──► S4-5

`src/loader/storage.ts` and `src/loader/index.ts` are touched by both S4-3 and S4-5: those two
are serialised, never in flight together. `src/broker/transport/ipc.ts` is S4-1's alone.
`src/main/shell/tabs.ts` is S4-2's alone. This is the run's main merge-conflict risk and it is the
reason for the shape above.
