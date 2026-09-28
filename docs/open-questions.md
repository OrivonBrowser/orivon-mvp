# Open questions

Questions, contradictions and unknowns still open, in ID order. A resolved entry leaves this file
and becomes one row in [`decisions/resolved-questions.md`](decisions/resolved-questions.md). An
A-number is never used twice across the two files, and no entry here runs past 12 lines
(`npm run check:questions`). Take a new entry's number from `main`'s highest across both files.

Every entry has this shape:

```
### A123: <title> **[OWNER]**

- **Question:** ...
- **Why it matters:** ...
- **Options:** ..., with the AI recommendation marked (rec.)
- **Who decides:** owner | AI, the recommendation stands unless the owner objects | research first
- **Blocks:** nothing | a build step, feature, port or entry ID
```

**[OWNER]**: product, philosophy or anything irreversible; never decided by an AI.
**[AI-REC]**: technical; an AI proposes. A question with no consequence for a person using
Orivon is an engineering call, tagged AI-REC and not brought to the owner.
**[RESEARCH]**: needs investigation before anyone can decide.

---

### A15: Remaining bundle caps and fetch timeouts are uncalibrated **[AI-REC]**

- **Question:** Do `MAX_PATH_BYTES` 1024, `MAX_BUNDLE_ENTRIES` 4096, `MAX_DDOC_BYTES` 656,384 and
  the fetch bounds (`FETCH_IDLE_TIMEOUT_MS` 20 s, `BUNDLE_TIMEOUT_MS` 30 min) stand as set?
- **Why it matters:** a cap decides which bundles are refusable. The byte caps are calibrated.
- **Options:** keep them until a real bundle or slow host hits one (rec.); calibrate now.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A19: Non-ASCII (IDN) hosts are rejected in connect patterns **[AI-REC]**

- **Question:** Should connect patterns accept IDN hosts by normalising both sides to A-labels?
- **Why it matters:** a Unicode host, its case variants and its punycode A-label are three strings
  to the matcher, so today a non-ASCII host or pattern is rejected with `bad-host`.
- **Options:** keep rejecting until an app needs it (rec.); add UTS-46 normalisation, a dependency
  or about 100 hand-written lines in `src/broker/policy/`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** the first app served from a non-ASCII origin

### A24: Should repo-wide sweeps be exempt from the one-stream branch rule **[AI-REC]**

- **Question:** May a repository-wide guideline or lint sweep run on one `backlog-NN` branch that
  touches every stream's paths?
- **Why it matters:** `parallel-work.md` §`backlog-NN` branches says two streams' paths means two
  branches; a sweep touches all of them on purpose, and splitting it only adds git overhead.
- **Options:** write an explicit sweep carve-out into `parallel-work.md` (rec.); allow each sweep
  as a named one-off exception; keep the rule and split sweeps by stream. See A31.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** the next repo-wide sweep

### A25: The spec's example of an unorderable version parses fine **[AI-REC]**

- **Question:** `capability-api.md` and `src/broker/policy/update.ts` give `"2026-08-26"` as an
  unorderable version, but semver reads it as `2026` with prerelease `08-26`.
- **Why it matters:** a test written from the example fails and makes correct code look broken.
- **Options:** use `"v1.0"`, `"latest"` or `"1.0.0.0"` in both places (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A34: The tab strip's native-controls inset is an unmeasured guess **[RESEARCH]**

- **Question:** Do the fixed insets (138px right on Windows/Linux, 78px left on macOS) match the
  real native window controls on every platform?
- **Why it matters:** `env(titlebar-area-*)` and `windowControlsOverlay` report nothing for a
  `BaseWindow` + `WebContentsView` shell; verified only on Linux/X11. A miss is cosmetic.
- **Options:** keep the generous fixed insets (rec.); check on real Windows and macOS hardware;
  measure instead if Electron wires Window Controls Overlay through `BaseWindow`.
- **Who decides:** research first
- **Blocks:** nothing

### A35: `ResponseEnvelope` drops the `handleId` an `OrivonError` carries **[AI-REC]**

- **Question:** Should the failure branch of `ResponseEnvelope` (`src/contracts/ipc.ts`) carry
  `handleId?: string`, mirroring `OrivonError`?
- **Why it matters:** a `'closed'` error naming its handle loses the id silently over IPC. Moot
  only while no wired control method can throw `'closed'`; confirm that still holds.
- **Options:** add the optional field in its own contracts PR (rec.); wait for a need.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** any control method that can throw `'closed'`

### A41: An app tab's WebRTC reaches the network without a grant **[RESEARCH]**

- **Question:** How should an app tab's WebRTC (ICE/STUN/TURN, data channels) be bounded by grants?
- **Why it matters:** WebRTC bypasses CSP and `orivon.net`, so "no network access" is false for
  an app using it (`security-model.md` T22); a blanket block breaks webtorrent-style apps.
- **Options:** apply `web-context-host.ts`'s two belts (`disable_non_proxied_udp`, a discard
  proxy) to app partitions holding no network grant (rec.); a WebRTC grant; document the gap.
- **Who decides:** research first
- **Blocks:** any trust-indicator or `security-model.md` claim that an app has no network access

### A42: Navigation and DNS rebinding escape the injected CSP **[RESEARCH]**

- **Question:** How are top-level navigation and the name-versus-address gap bounded, given that
  no CSP header can close either?
- **Why it matters:** an app can exfiltrate via `<a href>`/`location.href`, and a granted hostname
  can rebind to a private address `fetch` reaches though `orivon.net` would not.
- **Options:** state both as known limits in `security-model.md` T22 (rec.); gate off-origin
  navigation (compare ADR-0027); rely on Local Network Access (see A252). See A211.
- **Who decides:** research first
- **Blocks:** any claim that the manifest bounds all of an app's network reach

### A47: `publishX` setters in `registry.ts` are an unnamed append point **[AI-REC]**

- **Question:** `src/main/README.md` says other streams never edit `registry.ts`, yet four
  `publishX` setters live there. Should `parallel-work.md` §4 name them an append point?
- **Why it matters:** without a rule, each stream guesses what an "additive" edit to
  `SubsystemContext` may be.
- **Options:** name "an optional `SubsystemContext` field plus its guarded `publishX` setter"
  as a third append point (rec.); fold into A31's borrow carve-out, extended to code.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A50: Nothing keeps the docs' file, line and symbol claims true **[AI-REC]**

- **Question:** `handle-contracts.md` and `capability-api.md` cite files, lines and function
  names that go stale silently when code moves. What keeps them true?
- **Why it matters:** a stale claim reads as fact; a disclaimer only says to distrust the page.
- **Options:** cite files and symbols, never line numbers, plus a guard that fails when a cited
  path stops resolving (rec.); more frequent review passes; accept the drift.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A51: Is fail-fast right when a critical subsystem fails at startup **[AI-REC]**

- **Question:** A `critical` subsystem (`brokerIpcSubsystem`, the permission gate) that fails at
  startup shows `dialog.showErrorBox` and exits, instead of opening a shell where every
  `orivon.*` call fails silently. Is that the long-term shape?
- **Why it matters:** a real user meets this dialog once the browser is packaged.
- **Options:** fail fast with a native dialog, since shell chrome cannot vouch that the broker
  is down (rec.); a degraded shell with a banner; a retry or diagnostics flow.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** packaging (build step 10); related to A47

### A52: Can `net.request` hand the loader one oversized body chunk **[RESEARCH]**

- **Question:** `src/loader/fetch/budget.ts` checks the byte cap only after a chunk arrives.
  Does `netFetch` (`src/loader/electron/fetch.ts`) ever yield one far above `MAX_ASSET_BYTES`?
- **Why it matters:** a decompression bomb delivered as one chunk is allocated before the cap
  fires. (The abort half of this entry is done: `netFetch` aborts on the signal.)
- **Options:** measure the largest chunk under a bomb; close if Chromium bounds it (rec.); a
  BYOB reader with a bounded view.
- **Who decides:** research first
- **Blocks:** nothing

### A53: Every `BookmarkStore` stays in a static set until exit **[AI-REC]**

- **Question:** `BookmarkStore` registers itself in a static set so the quit path can
  `flushAll()`, and a closed window's store is never removed. Replace the registry?
- **Why it matters:** a long session that opens and closes many windows retains every store.
- **Options:** hand each window's store to the quit path and drop the registry (rec.); a
  `dispose()` on window close; a `WeakRef` registry.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A60: A "remove this app" action must own `forgetOrigin`'s cascade **[AI-REC]**

- **Question:** `GrantLedger.forgetOrigin` clears an origin's floor, manifest, grants and byte
  count, but nothing calls it. What must "remove this app" do around it?
- **Why it matters:** alone it leaves live handles unrevoked and frees no disk, so re-registering
  would slip past the `fs` quota.
- **Options:** call it from `createBroker` with the handle revocation `revoke` does, and delete
  the origin's fs root (rec.); wire `forgetOrigin` alone.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** a "remove this app" action (not built)

### A63: A transient read error fails a version floor closed all session **[AI-REC]**

- **Question:** `readVersionFloor` (`node-ledger-storage.ts`) returns the corrupt sentinel for
  any non-ENOENT error, EACCES included, and hydrates once, so the app refuses every update.
- **Why it matters:** live: `app-install.ts` reads the floor on every install. Returning
  `undefined` instead would reopen the T19 rollback A57 closed.
- **Options:** a four-state read whose `unavailable` leaves the record un-hydrated for a retry
  on next touch (rec.); leave it failing closed.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A66: The install fetch cannot pin its connection to the checked address **[OWNER]**

- **Question:** Is the residual DNS-rebind window in the loader's `net.fetch` acceptable, or does
  the install fetch move to a socket layer this code controls?
- **Why it matters:** The guard re-checks Chromium's resolver before each request, but a rebind
  between check and fetch is still possible: `net.fetch` cannot dial a pinned address.
- **Options:** keep today's narrowing (`src/loader/electron/fetch.ts`); Node `fetch` with a pinned
  `lookup`, losing session, proxy and cookie integration.
- **Who decides:** owner
- **Blocks:** nothing until a threat model assumes full DNS-rebind closure

### A67: An update that drops a capability can lift its scalar limit **[AI-REC]**

- **Question:** How should `widensAuthority` (`src/broker/policy/update.ts`) see a dropped block,
  such as `fs` with `quotaBytes`, whose absence means unlimited?
- **Why it matters:** The person reconsents to what looks like a content update while a quota goes
  unlimited; `net.concurrentSockets` has the same shape.
- **Options:** give `PatternSet` a shape for non-pattern fields, with an ADR (rec.); a narrower
  per-field check with its own justification.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A68: A rollback acknowledgement covers one exact version, not the origin **[AI-REC]**

- **Question:** Does accepting a below-floor version trust only that version, or every later
  rollback from the same origin?
- **Why it matters:** A per-origin flag would let one accepted rollback wave through any other old
  version, `0.0.1` included, with no further consent.
- **Options:** remember the exact version (rec., built in `src/broker/grants/update-safety.ts`);
  a per-origin flag.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; `d-0017`'s log row says "per origin" and should agree

### A69: A peer FIN ends our writable early; the obvious fix breaks EOF **[RESEARCH]**

- **Question:** How can a TCP socket stay half-open after a peer FIN, as the close table in
  `handle-contracts.md` requires, without losing read-side EOF?
- **Why it matters:** `dialOne` omits `allowHalfOpen`, so a peer FIN ends our writable; set it and
  `Duplex.toWeb`'s readable never reports done, hanging `port-pump.ts`.
- **Options:** a `ReadableStream` that takes EOF from the socket's `'end'` event; other Node
  releases; an upstream report against `Duplex.toWeb`.
- **Who decides:** research first
- **Blocks:** nothing; `port-sink.ts` already fails only the write direction after a peer FIN

### A81: Is a message posted just before `MessagePortMain.close()` delivered? **[RESEARCH]**

- **Question:** Does a real `MessagePortMain` deliver a message posted in the tick of `close()`?
- **Why it matters:** Clean socket teardown in `transport/relay/socket.ts` posts `end` then closes;
  if that is lost, closes report `'timeout'` after a 15 s silence. A84's fix made this path common.
- **Options:** a same-tick post-then-close test against a real `MessagePortMain` pair, not the fake
  `PortLike` (rec.).
- **Who decides:** research first
- **Blocks:** nothing

### A85: Directory import boundaries are stated in READMEs, enforced by nothing **[OWNER]**

- **Question:** Build a `check:layers` guard now, or keep waiting to see which boundary drifts?
- **Why it matters:** `policy/` must do no I/O, `handles/` import no `node:*`, `adapters/` no
  `electron`, and `src/broker/` none of shim, loader, preload or renderer. The repository-wide
  `tests/` placement rule is unguarded too.
- **Options:** `scripts/check-layers.mjs` generalising `check-contracts-pure.mjs`, with a named
  exemption for `grants/node-ledger-storage.ts` (rec.); keep deferring.
- **Who decides:** owner
- **Blocks:** nothing

### A86: The UDP inbound window is bounded by count and by bytes **[AI-REC]**

- **Question:** Is the UDP inbound window only a datagram count, as `handle-contracts.md`
  §UdpSocket says, or also a byte bound?
- **Why it matters:** A count alone lets 64 sockets pin about 1 GiB per origin; bytes alone leave
  the per-message count unbounded.
- **Options:** both, whichever runs out first drops, dropped in the broker (rec., built:
  `LIMITS.inboundDatagramWindow` 256, `inboundDatagramWindowBytes` 1 MiB); count only.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; cheap to overrule while `orivonApiVersion` is 0

### A88: Binding port 0 picks a port inside the granted ranges **[AI-REC]**

- **Question:** When an app binds port 0, may the OS pick any port, or only one the grant names?
- **Why it matters:** DHT clients bind 0 routinely; an OS-picked port outside "ports 6881-6889"
  makes the approved prompt untrue.
- **Options:** pick at random inside the granted ranges, failing `'limit'` when all are taken (rec.,
  built: `src/broker/adapters/port-pick.ts`); deny port 0; let the OS pick anywhere.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; the grant prompt's wording must agree with it

### A89: UDP sockets are IPv4-only **[AI-REC]**

- **Question:** Should UDP sockets stay `udp4` on `0.0.0.0`, or go dual-stack?
- **Why it matters:** Dual-stack reports IPv4 peers as `::ffff:` mapped addresses that must be
  normalised before any policy check; IPv4-only means no DHT on an IPv6-only network.
- **Options:** stay IPv4 and list it as a known limitation (rec.; `docs/planning/torrent-app.md`
  does); dual-stack, un-mapping addresses before `policy/address.ts`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A91: `§` in docs against the ASCII-only prose rule **[OWNER]**

- **Question:** Allow `§` in docs, relaxing `CLAUDE.md`'s ASCII-only rule, or sweep it out of
  `docs/`?
- **Why it matters:** `§` is used widely across `docs/`, headings included, while the rule as
  written says ASCII. Source comments already spell out "section".
- **Options:** allow `§` in docs, the de facto convention (rec.); sweep it out.
- **Who decides:** owner
- **Blocks:** nothing

### A92: Telemetry credits all time to the placeholder `SHELL_APP_ID` **[AI-REC]**

- **Question:** Should telemetry attribute session time to the app in a tab, not to
  `SHELL_APP_ID = 'shell'` (`src/telemetry/runner.ts`)?
- **Why it matters:** Per-app engagement cannot be judged while everything is one id; the success
  metric uses whole-browser `activeSec`, which this already measures.
- **Options:** attribute to the tab's real app id, now that the loader knows it (rec.); keep the
  placeholder.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** per-app engagement numbers

### A93: The telemetry ingest endpoint does not exist **[OWNER]**

- **Question:** Where is the self-hosted ingest endpoint `ADR-0004` requires, and who provisions it?
- **Why it matters:** `TELEMETRY_INGEST_URL` (`src/telemetry/runner.ts`) is an unresolvable
  `.example` address, so no event reaches a server and active use cannot be counted.
- **Options:** provision a self-hosted endpoint and set the URL; keep telemetry off until then.
- **Who decides:** owner
- **Blocks:** enabling telemetry for real users

### A106: `net.listen` accept backpressure is a broker queue, not the OS backlog **[AI-REC]**

- **Question:** Amend `handle-contracts.md` §TcpServer and §Conformance item 7, which promise
  OS-level accept backpressure, to match what is built?
- **Why it matters:** Node cannot defer `accept()`, so `listenTcp` queues up to 64 unclaimed
  connections (`LISTEN_ACCEPT_QUEUE_LIMIT`) and resets later arrivals. The spec overstates.
- **Options:** amend the spec to "a bounded broker-side queue" (rec.); find an OS-level primitive.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A109: Entering or leaving an app swaps the view and loses history **[AI-REC]**

- **Question:** Should a view swap into or out of an app keep back/forward history, and should a
  cross-origin navigation be caught before it commits?
- **Why it matters:** The swapped-in view starts with empty history. `did-navigate` swaps after
  commit, so the new origin's first render can read the old partition.
- **Options:** carry history over with `NavigationHistory.restore()` (rec., flicker unmeasured);
  intercept with `will-navigate`/`will-redirect`, a fresh view per cross-origin click; accept
  both, as `src/main/shell/README.md` discloses.
- **Who decides:** owner, before the restore path is built
- **Blocks:** nothing

### A111: `window.nostr` cannot reach a page until `id.requestIdentity` exists **[AI-REC]**

- **Question:** When is `window.nostr` (`src/nostr/nip07.ts`) injected into pages?
- **Why it matters:** It signs through `orivon.id.requestIdentity`, the named-identity path that
  keeps one npub across sites, and that is unbuilt. A method that always throws is worse than none.
- **Options:** inject it together with a working `requestIdentity` and its connect prompt (rec.);
  stub it earlier.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** Nostr identity (`docs/scope.md` §LATER)

### A112: Synchronous `fs` reads skip the per-origin in-flight budget **[OWNER]**

- **Question:** Does `fs.readFileSync` (`src/broker/transport/sync-fs.ts`) need its own per-origin
  admission control, beside the shared rate limiter it already checks?
- **Why it matters:** One origin can monopolise synchronous file I/O from many frames or a tight
  loop. Grant check and confinement are shared; this is fairness, not confinement.
- **Options:** a synchronous admission counter beside `HandleTable`'s async budget (it cannot
  await a slot without stalling main); or rule the rate limiter enough, since a blocked renderer
  limits itself per frame.
- **Who decides:** owner
- **Blocks:** any app relying on `readFileSync` under load

### A113: The `exposeFallback` path drops `OrivonError.code` **[RESEARCH]**

- **Question:** How do `orivon.*` errors keep their `code` when `executeInMainWorld` is absent and
  `exposeFallback()` (`src/preload/surface/orivon.ts`) installs the API instead?
- **Why it matters:** `contextBridge` flattens an isolated-world error to a plain `Error`, so an
  app cannot branch on the `src/contracts/errors.ts` enum there. The main-world path is fixed.
- **Options:** a minimal main-world constructor for the fallback; a result envelope callers
  unwrap; or accept and document the divergence as a property of the fallback.
- **Who decides:** research first
- **Blocks:** nothing (the fallback is the degraded path, ADR-0014)

### A118: Routed requests may carry conflicting framing headers **[AI-REC]**

- **Question:** Should `requestHead` (`src/preload/routed/wire.ts`) refuse an app's header list
  with both `Content-Length` and `Transfer-Encoding`, or a duplicate `Content-Length`?
- **Why it matters:** The classic request-smuggling shape if anything downstream disagrees on
  framing. Bounded: granted hosts only, no ambient credentials; CRLF is already guarded.
- **Options:** refuse conflicting framing with a `TypeError` (rec.); accept it as bounded.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A119: `decideGrantRequest` has no internal bound on `patterns` **[AI-REC]**

- **Question:** Should `decideGrantRequest` (`src/broker/policy/request-grant.ts`) bound its
  `patterns` itself, not only through the control channel's `isAppRequestGrantParams`?
- **Why it matters:** The IPC validator caps it at `MAX_PATTERNS`; a future direct caller that
  bypasses the control channel would run an unbounded subset check.
- **Options:** apply `MAX_PATTERNS` inside the policy function too (rec.); keep the IPC bound as
  the only one.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A120: Persisted ledger files are parsed with no size bound **[AI-REC]**

- **Question:** Should `src/broker/grants/node-ledger-storage.ts` cap each per-origin file
  (grants, floor, rollback ack, declined set) before `readFileSync` and `JSON.parse`?
- **Why it matters:** They are parsed on the main thread, so an oversized or planted file stalls
  the whole browser. `MAX_MANIFEST_BYTES` (d-0060) is the precedent.
- **Options:** a byte cap per file, treating an oversized file as corrupt for that origin only
  (rec.); accept it, since the files live under `userData`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A124: The favicon address check does not pin the resolved address **[AI-REC]**

- **Question:** Should the favicon fetch (`src/main/browsing/favicon.ts`) pin the address its T12
  check approved, as `src/loader/electron/fetch.ts` does?
- **Why it matters:** The guard resolves, then the request resolves again: a DNS-rebinding window
  up to a cache expiry. The weaker path is deliberate, not an error.
- **Options:** pin through the loader's pinned-address mechanism (rec.); accept the narrowed
  window and keep it documented.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A127: Does macOS drop the consent dialog's title? **[RESEARCH]**

- **Question:** Does a real macOS build show the consent message box's `title`? Electron's types
  say some platforms drop it.
- **Why it matters:** Only the measurement is open: the origin is already `detail`'s first line
  (`src/main/consent/grant-prompt-render.ts`), so the dialog never relies on the title.
- **Options:** run the prompt once on a real macOS build and record it; until then, treat the
  title as unreliable.
- **Who decides:** research first
- **Blocks:** nothing

### A128: `pako` is an unused direct dependency; a nested copy does the work **[AI-REC]**

- **Question:** Remove the direct `pako@3` that nothing imports? Does `browserify-zlib`'s nested
  `pako@1.0.x`, the copy that runs, need its own review?
- **Why it matters:** The dependency review approved a version that is not the one executing;
  drift that is cheap to fix now and confusing later.
- **Options:** drop the direct dependency and record the nested version in
  `docs/planning/shim-dependency-review.md` (rec.); keep both as they are.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A129: `check:natives` cannot see an install script that downloads a binary **[AI-REC]**

- **Question:** Should `scripts/check-no-native-modules.mjs` also catch an install hook that
  downloads a prebuilt binary, not only one naming a compiler?
- **Why it matters:** A downloaded native artefact breaks run-from-source as a compiled one does
  (Rule 8). No runtime dependency had an install script when last checked.
- **Options:** fail on any install hook not on a reviewed allowlist (rec.); fail on `.node` files;
  leave it to dependency review.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A131: The compatibility matrix cannot show whether anyone can use Orivon **[AI-REC]**

- **Question:** Should `docs/planning/compatibility-matrix.md` Table 1 open with a row that is
  not a capability, "a person can open an app and grant it something", scored honestly?
- **Why it matters:** A capability scoreboard can go all-green while nobody can use the product,
  and it rewards building mechanisms nothing calls.
- **Options:** add the journey row above the capability rows (rec.); leave usage to the success
  metric alone.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A132: Apps cannot tell the shim's polyfill `crypto` from Orivon's own **[AI-REC]**

- **Question:** Where do app authors learn that `require('crypto')` is `crypto-browserify`, not
  the WebCrypto-backed `orivon.id.*`? `security-model.md` T26 records the gap.
- **Why it matters:** An app signing with `crypto.createSign()` may assume `orivon.id.sign()`'s
  footing; the polyfill carries a third-party advisory.
- **Options:** point to T26 from `src/shim/README.md`, and repeat it in app-author documentation
  when that is written (rec.); no new API.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A139: First-visit consent may bring back prompt fatigue **[OWNER]**

- **Question:** Does the once-per-origin consent dialog on a first visit read as reasonable, or
  as an interruption the person did not ask for?
- **Why it matters:** ADR-0012 rejected asking before fetch because unprompted dialogs train
  dismissal; asking on first visit brings a version of that back.
- **Options:** keep as built, bounded: nothing asked for a manifest declaring nothing, once per
  origin, one dialog for the whole set (rec.); revisit `d-0025`'s ask-before-run rule.
- **Who decides:** owner
- **Blocks:** nothing

### A140: `app.requestGrant`'s 120-second IPC timeout is a guess **[AI-REC]**

- **Question:** Is 120 s right for a call that waits on a person (`TIMEOUT_MS.grant`,
  `src/preload/surface/control-call.ts`), given a `'timeout'` can race a late real answer?
- **Why it matters:** The prompt is not cancelled on timeout, so a slow click still grants, but
  the page sees `'timeout'` and must poll `app.grants()` to notice.
- **Options:** keep 120 s (rec.); a longer budget; a grants-change event in `src/contracts/` so a
  late answer is observable.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A144: Three e2e tests import `esbuild`, which `package.json` does not declare **[AI-REC]**

- **Question:** Declare `esbuild`, resolved today only through `vite`, as a devDependency? The
  `test/e2e-loader-adapter`, `e2e-page-buffer` and `e2e-app-loader-journey` tests import it.
- **Why it matters:** If `vite` drops or swaps its bundler these tests fail with an unexplained
  resolution error. Declaring it adds nothing to the installed tree.
- **Options:** declare it at the locked version in a PR touching nothing else (rec.); rewrite the
  tests onto the `electron-vite` build.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A147: Cached-delivery wording on the Web3 Score shield **[OWNER]**

- **Question:** Is a hover-only "Running from local cache, pinned" enough for ADR-0007's "the UI
  must say so"? Is "pinned" the right word? Should cached and secure ever show together?
- **Why it matters:** A hover-only signal is easy to miss, "pinned" is jargon, and `.cached`
  replaces secure/insecure outright. The site-info Web3 Score page shows it in text, one click in.
- **Options:** keep hover-only plus the site-info text (rec.); visible text on the shield itself;
  plainer "Running offline from a saved copy"; show both facts at once.
- **Who decides:** owner
- **Blocks:** nothing

### A148: `'unsafe-inline'` lets injected markup run script in app pages **[AI-REC]**

- **Question:** Should the served bundle's `script-src` swap `'unsafe-inline'` for per-script
  `sha256-` hashes computed from the pinned HTML at serve time (`src/loader/serve/csp.ts`)?
- **Why it matters:** An app rendering fetched data as raw markup can run an injected `<script>`;
  third-party reach is live (A143, ADR-0017), and no trust score can show this risk.
- **Options:** add per-script hashes as low-priority security work (rec.); keep `'unsafe-inline'`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A150: Wording of the reconsent, widening and rollback update dialogs **[AI-REC]**

- **Question:** Is the text in `src/main/consent/grant-prompt-render.ts` right, including "Keep the
  current version" in place of "Deny", and a widening prompt that lists the full declared set?
- **Why it matters:** Declining any of these declines the whole update, not one capability. Only
  the author has read the words, and "which one is new?" may be what a person actually asks.
- **Options:** keep as written (rec.); show only the new capabilities, which needs held grants
  that the Electron- and broker-free renderer cannot read.
- **Who decides:** AI, the recommendation stands unless the owner objects on reading the dialogs
- **Blocks:** nothing

### A157: Install consent is inferred from held grants, never recorded **[OWNER]**

- **Question:** Is "every declared capability is held or declined" an acceptable floor for
  skipping install consent, or should an accept be recorded explicitly?
- **Why it matters:** A grant through `app.requestGrant` can fill the set without
  `requestInstallConsent` ever running. The decline side is recorded (A145).
- **Options:** accept the inference, since a persisted grant is itself the record (rec.); extend
  `src/broker/grants/declined-consent.ts`'s record to accepts.
- **Who decides:** owner
- **Blocks:** nothing

### A160: `src/shim/` imports `src/shim-electron/` directly **[AI-REC]**

- **Question:** May `src/shim/unimplemented.ts` re-export `refusingProxy` from
  `src/shim-electron/`, reading `src/shared/` as reserved for the broker/shim trust boundary?
- **Why it matters:** It couples two separately owned directories; Rule 1 asks whether that needs
  an ADR.
- **Options:** keep the direct import (rec.); move `refusingProxy` to `src/shared/`, a mechanical
  follow-up.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A161: Origin display hides the tenant behind unlisted private suffixes **[OWNER]**

- **Question:** Adopt a public-suffix-list dependency (`psl`/`tldts`, parked under A142) so origin
  display always keeps the tenant label?
- **Why it matters:** Hosts like `bucket.s3.us-east-1.amazonaws.com` still get the plain three-label
  cut, which can read as the platform's own domain.
- **Options:** keep the three-label rule plus the evidenced allow-list in
  `src/main/consent/grant-prompt-origin.ts` until a real report (rec.); review a PSL dependency
  before onboarding 100 users.
- **Who decides:** owner
- **Blocks:** nothing

### A162: Per-capability consent for update-time widening **[OWNER]**

- **Question:** Are staged native dialogs the right floor for `consentGranularity:
  'per-capability'`, and should an update that widens capabilities get the same choice?
- **Why it matters:** Only install consent honours the field; `capabilityPrompt` in
  `src/main/consent/update-outcomes.ts` stays a yes/no with no declined-consent record.
- **Options:** staged native dialogs (rec.) or a self-rendered privileged window; extend to update
  widening reusing the "outstanding" gate and decline record, or with its own; leave updates as is.
- **Who decides:** owner
- **Blocks:** nothing

### A163: Third-party reach proxies `https:` only; plain `http:` stays denied **[AI-REC]**

- **Question:** Should `fetchThirdParty` (`src/loader/serve/serve.ts`) ever proxy a plain `http:`
  cross-origin request under a `tcp.connect` grant?
- **Why it matters:** Node dials by hostname, so the checked address and the dialled one can
  differ (DNS rebinding, T12). A66 accepted that only for one narrow install fetch.
- **Options:** keep `http:` denied until Electron or Node exposes address pinning (rec.); accept
  the risk for a stated narrower reason, as A66 did.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A166: Should pin coverage change the delivery rung or score? **[OWNER]**

- **Question:** How should pin coverage (requests and bytes from the pin vs third-party hosts)
  affect the delivery ladder or what a person sees as the Web3 Score?
- **Why it matters:** A two-file bundle that fetches thirty remote scripts sits on the same D2
  rung as one that ships everything it runs (see A148). Today coverage is shown, never scored.
- **Options:** keep it evidence-only; lower or cap the rung below a coverage threshold; add a
  separate coverage grade (`src/trust/delivery-ladder.ts`).
- **Who decides:** owner
- **Blocks:** nothing

### A170: Should Deny on the install dialog revoke an already-held capability **[OWNER]**

- **Question:** When the all-or-nothing install dialog lists a capability the app already holds
  (granted earlier through `app.requestGrant`), should Deny also revoke it?
- **Why it matters:** held rows are marked `[Already allowed]` and Deny applies to the rest;
  revoking would take back a grant the person agreed to separately, a surprise of its own.
- **Options:** keep the held grant, as today; revoke every listed capability on Deny.
- **Who decides:** owner
- **Blocks:** nothing

### A180: The app, not the person, decides whether consent is per-capability **[OWNER]**

- **Question:** Should "Choose individually" be offered even when the manifest declares, or
  defaults to, `'all-or-nothing'`, turning `consentGranularity` from a gate into a hint?
- **Why it matters:** an author always gains by declaring all-or-nothing, so the refusal the
  person was given may never be reachable; ADR-0017 argued the same about unlimited declarations.
- **Options:** keep the manifest as the gate (an app with no code path for a partial grant stays
  safe); always offer the choice, with the manifest's declaration shown as a warning.
- **Who decides:** owner
- **Blocks:** nothing

### A182: Which unbuilt shim members read as absent, not as named refusals **[OWNER]**

- **Question:** Which unimplemented shim members should be genuinely `undefined`, so a feature
  check skips them, instead of a function that throws a named refusal when called?
- **Why it matters:** since A169 a feature-detecting library takes the branch and crashes at the
  call. Named refusals (A135) serve the developer; absence serves unmodified third-party code.
- **Options:** decide by reason: `'not-applicable'` (never to be built) absent, planned-but-unbuilt
  named (rec.); every member named, as today; every member absent.
- **Who decides:** owner
- **Blocks:** nothing

### A184: When `FileHandle.readable()`/`writable()` reach the page **[AI-REC]**

- **Question:** When should `orivon.fs.open`'s `readable()`/`writable()`, built and tested in the
  broker, be relayed to the page over a per-handle port (`port-pump.ts`/`port-sink.ts`)?
- **Why it matters:** until then the page's handle has no streams and no live `closed`, and the
  shim's `FileHandle#createReadStream`/`createWriteStream` refuse by name.
- **Options:** wire it now; wait until a port needs instance streams and decide it with A189,
  whose option (a) needs the same port (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** A189 option (a); `FileHandle` instance streams in `src/shim/fs/`

### A185: `net.listen`'s accept demand reuses `CreditMessage` instead of its own member **[AI-REC]**

- **Question:** Keep signalling accept demand as a `CreditMessage` whose `bytesConsumed` counts
  connections (always 1), or add a dedicated `{kind:'accept', handleId}` to `src/contracts/ipc.ts`?
- **Why it matters:** one field means bytes on a socket's port and connections on a server's;
  `src/preload/ports/server.ts` and `src/broker/transport/relay/accept-pump.ts` rely on the reuse.
- **Options:** keep the reuse, no wire change (rec.); a dedicated member, at the cost of a
  contracts change.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A187: The unreviewed judgment calls inside `fs.userSelected` **[AI-REC]**

- **Question:** Do the built choices stand: a `DirectoryHandle` shares the `'file'` handle budget;
  closing it leaves files opened inside it open (revoking the pick closes them); each picked file
  gets its own `pickId`; picked bytes count against `fs.quotaBytes`?
- **Why it matters:** they set revocation granularity and resource limits for user-picked paths.
  A remembered pick (D-0007) is listed and revocable after a restart but never skips the OS dialog.
- **Options:** keep them as built (rec.); change one, such as cascading a folder's `close()`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A189: A page that never closes an `fs.open` handle leaks its fd **[OWNER]**

- **Question:** How is an abandoned `orivon.fs.open` handle reclaimed, and must that land before
  `fs.open` carries a real page-facing grant?
- **Why it matters:** a handle dropped without `close()` keeps its OS fd and registry slot for the
  broker's life; unlike sockets and servers it has no per-handle port whose closing signals it.
- **Options:** (a) a dedicated port per handle, reopening A184's boundary; (b) call
  `HandleTable.dropOrigin`, which has no production caller, on navigation or session teardown,
  closing the whole class at once (rec.).
- **Who decides:** owner
- **Blocks:** nothing named; safe production use of `fs.open`

### A193: `OrivonNet.lookup`'s contract comment still names `https.connect` **[AI-REC]**

- **Question:** `src/contracts/capability-api.ts` says `net.lookup` rides `https.connect` patterns
  too; d-0031 removed that. Fix the two-line comment?
- **Why it matters:** The contracts are the product surface; a reader learns the wrong bound.
- **Options:** fold it into the next contracts PR (rec.); a docs-only contracts PR.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A195: `DirectoryHandle`'s method set is wired but never owner-confirmed **[OWNER]**

- **Question:** Confirm or revise `DirectoryHandle`'s methods (A167 item 2: readdir, stat, mkdir,
  rm, rename, readFile, writeFile, open), now reachable from a page through the `fs.dir*` methods?
- **Why it matters:** It mirrors `OrivonFs`, not the web's `FileSystemDirectoryHandle`, and lives in
  `src/contracts/handles.ts`: a later change costs every app.
- **Options:** confirm as built (rec.); reshape it, and the dispatch and preload layer follow.
- **Who decides:** owner
- **Blocks:** nothing

### A201: Two different apps are both called `freetube` **[OWNER]**

- **Question:** `test/apps/freetube/` (a from-scratch test app) and `orivon-ports`'s
  `apps/freetube/` (upstream FreeTube, ported) share a name. Rename one, or name the repository
  at every mention?
- **Why it matters:** "The FreeTube test" is ambiguous: `e2e-freetube-app` and `-live-origin` drive
  the demo, `e2e-freetube-real` drives the port.
- **Options:** rename this repository's test app, since the port carries upstream's name (rec.); a
  prose convention naming the repository.
- **Who decides:** owner, since the name spans both repositories
- **Blocks:** nothing

### A203: `src/broker/transport/` imports `src/main/`, against a stated rule **[AI-REC]**

- **Question:** `transport/ipc.ts` imports `channels`, `registry`, `web-context-host` and
  `electron-keychain` from `src/main/`; comments in `policy/update.ts` and
  `grant-changed-capabilities.ts` say `src/broker/` never does. Which is wrong?
- **Why it matters:** A boundary stated as absolute but false invites the next violation.
- **Options:** narrow the rule to `src/broker/policy/`, keeping `registry`/`channels` as the seam
  (rec.); also pass the two factories in through `CreateBrokerOptions`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A204: `updateCheckSubsystem` is built but never wired **[OWNER]**

- **Question:** Add `updateCheckSubsystem` to `src/main/subsystems.ts`, or confirm the self-update
  check stays unwired, and why?
- **Why it matters:** The GitHub-release check is built and unit-tested but never runs in a build.
- **Options:** wire it after `brokerIpcSubsystem` (no ordering constraint); leave it unwired until
  a real release exists to check against.
- **Who decides:** owner
- **Blocks:** nothing

### A205: File System Access: prompts for write-back, stored handles and folders **[AI-REC]**

- **Question:** Electron decides File System Access in the synchronous check handler, which cannot
  ask. Should write-back, a reused IndexedDB handle, or a folder ever get a prompt, as in Chrome?
- **Why it matters:** The first two are silently allowed here; folders are refused outright.
- **Options:** leave all three this build (rec.: bounded to a file the person handed over; folder
  apps have `fs.userSelected`); prompts once Electron routes it through the request handler.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; reopen for a port needing a folder or a misused stored handle

### A206: The site-data page cannot delete an app's private files **[OWNER]**

- **Question:** How does the site-info data page delete `orivon.fs` private files (ADR-0003's "a
  way to delete data"), and what does it say when a file open on Windows blocks the delete?
- **Why it matters:** The page shows sizes but no delete; `session.clearData` covers only
  browser storage.
- **Options:** a `Broker` method (after splitting `broker-contracts.ts`) that revokes private-file
  handles, deletes the directory, resets `fsBytesWritten` (A29), then lifts the revocation.
- **Who decides:** owner on the failure wording; AI on the mechanism
- **Blocks:** ADR-0003's delete-data requirement

### A207: The routed network path's numbers are guesses **[AI-REC]**

- **Question:** Are the routed path's bounds right: 300 s idle, 120 s queue wait, 500 ms `'limit'`
  retry, 512 KiB body read-ahead (`src/preload/README.md`)?
- **Why it matters:** Chosen, not measured; each errs long, toward a browser.
- **Options:** keep until ASGARDEX and FreeTube traces under load say otherwise (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; reopen when a request fails on one of them

### A208: Every routed request pays its own TCP and TLS handshake **[AI-REC]**

- **Question:** The routed path sends `Connection: close` and keeps no pool. Pool keep-alive
  sockets?
- **Why it matters:** Forty requests to one host open forty connections, each holding an allowance
  slot.
- **Options:** wait for a measured cost (rec.: the installer is serialised and cannot import); a
  keep-alive pool per (origin, host, port), bounded by the socket allowance.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A209: Routed requests do not advertise brotli **[RESEARCH]**

- **Question:** Electron 44's `DecompressionStream` has no `'brotli'`, so routed requests offer only
  `gzip, deflate`; a server sending `br` anyway fails. The shim's `zlib` has the same gap.
- **Why it matters:** A granted host that ignores `Accept-Encoding` breaks.
- **Options:** wait for Chromium; the check is live, so no code change (rec.); an owner-approved
  WASM decoder such as `brotli-wasm`.
- **Who decides:** research first
- **Blocks:** nothing

### A210: A `Request` object's forbidden headers never reach the routed path **[AI-REC]**

- **Question:** `new Request(url, { headers })` drops forbidden headers (`Origin`, `Cookie`, `Host`)
  before the routed `fetch` sees them; `fetch(url, { headers })` keeps them. Accept it?
- **Why it matters:** One app gets different headers depending on which form it used.
- **Options:** accept, documented in `src/preload/README.md` (rec.); the main world cannot recover
  what the guard dropped.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A211: Should a worker's or subframe's WebSocket reach a granted host? **[AI-REC]**

- **Question:** Only a tab's top-level WebSocket is routed over `orivon.net` (d-0090); from a worker
  or subframe, CSP refuses even a granted host. Admit it?
- **Why it matters:** Admitting means `wss:` CSP sources, so CSP becomes the only gate, with no live
  re-check behind it.
- **Options:** leave it refused this build (rec.); emit `wss:` sources.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; a port that runs its socket in a worker

### A212: Reach-path CORS headers are inert in Electron 44 **[RESEARCH]**

- **Question:** Electron 44 enforces no CORS on `protocol.handle` responses, so
  `src/loader/reach/cors.ts` and `web-context-host.ts`'s wrapper change nothing. Keep them?
- **Why it matters:** If a later Electron enforces CORS, worker `fetch` and XHR keep working.
- **Options:** keep; re-run `test/e2e-served-csp.test.ts` on every Electron upgrade, adding tests
  that fail without the headers once enforcement arrives (rec.).
- **Who decides:** research first
- **Blocks:** nothing

### A213: The reach path's queue, idle timeout and redirect cap are guesses **[AI-REC]**

- **Question:** Are the reach bounds right (d-0049): a FIFO of 256 waiters and 30 s
  (`reach/slots.ts`), a 5-minute idle timeout, 20 redirect hops keyed by URL?
- **Why it matters:** Chosen, not measured; a re-serialised redirect URL restarts its count (low
  risk: each hop is authorised).
- **Options:** keep until A207's traces cover subresources (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A214: The in-flight cap now queues briefly, changing T11b's wording **[OWNER]**

- **Question:** Confirm d-0063: past `LIMITS.inFlightOperations` (256) an operation waits in a
  per-origin FIFO (256 waiters, 10 s) instead of being refused at once?
- **Why it matters:** It rewords a stated security rule; ported Node code fires hundreds at once.
- **Options:** confirm (rec.: T11b forbids an unbounded queue; this one is bounded in length and
  time); revert to immediate refusal.
- **Who decides:** owner
- **Blocks:** nothing (`src/contracts/limits.ts` already carries the new text)

### A216: The fs quota miscounts in-place rewrites and files removed while open **[AI-REC]**

- **Question:** A `FileHandle`'s `write` and `writable()` charge every byte, so a rewrite counts
  twice until the next session reconciles; a file removed while open is released early.
- **Why it matters:** An app rewriting a large file near its quota is refused early. The under-count
  is bounded by `LIMITS.concurrentFileHandles`.
- **Options:** charge a handle write as growth of the file's end (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A217: Should `orivon.fs.writeFile` create missing parent directories? **[OWNER]**

- **Question:** The broker's `writeFile` makes missing parents first
  (`src/broker/adapters/node-fs-adapter.ts`); Node fails `ENOENT`. Which does the capability
  promise?
- **Why it matters:** Node code sometimes detects a missing directory by that failure; the shim can
  give Node's behaviour either way.
- **Options:** keep creating parents (tests pin it); fail `ENOENT` as Node does.
- **Who decides:** owner
- **Blocks:** nothing

### A218: UDP sockets and TCP servers are IPv4-only **[AI-REC]**

- **Question:** `udpBind` makes a `udp4` socket and `listen` binds `0.0.0.0`. Go dual-stack?
- **Why it matters:** No UDP to IPv6-only DHT peers; no inbound IPv6 connections.
- **Options:** stay IPv4 until a measurement shows IPv6-only peers matter (rec.); dual-stack, with
  mapped-address normalisation wherever a peer address is compared.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A219: Narrowing a `web.context` grant closes every open context **[AI-REC]**

- **Question:** A replacement grant that is not a superset closes all open web contexts (d-0066),
  even one whose origin the new grant still names. Judge per context?
- **Why it matters:** An app narrowing `web.contexts` loses contexts it is still allowed.
- **Options:** a per-context predicate, built when an app needs it (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A220: After a session ends, its handles answer `'denied'`, not `'revoked'` **[AI-REC]**

- **Question:** `dropOrigin` deletes the origin's handle table, so a later call on one of its ids
  gets the uniform `'denied'` (d-0068). Keep a tombstone?
- **Why it matters:** An app may misread a session end as a refusal; in-flight calls do get
  `'revoked'`.
- **Options:** wait for a confused app (rec.); a short-lived tombstone for dropped handle ids.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A221: Is ADR-0021's "platform descriptor" a shape or a behaviour? **[AI-REC]**

- **Question:** Node defines `Buffer`/`process` as accessor pairs; the page defines data properties
  (`src/preload/page-buffer.ts`, `src/shim/globals.ts`). Which does ADR-0021 require?
- **Why it matters:** Replace, shadow and delete behave alike; only descriptor-reading code differs.
- **Options:** read it as behaviour, keep data properties, checked by `check:page-globals` (rec.);
  match Node's accessors.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A222: The shim cannot list the app's root directory **[AI-REC]**

- **Question:** The broker refuses the root itself (`deny('is-root')`); `src/shim/fs/root.ts`
  answers `stat`, `access`, `mkdir -p` and `fsync` locally; `readdir` fails `EACCES`. Allow a
  listing?
- **Why it matters:** A library that lists its working directory fails.
- **Options:** wait for such a library (rec.); a broker policy allowing a read-only root listing.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A223: `process`'s values are provisional **[AI-REC]**

- **Question:** Keep `versions` `{}`, `version` `''`, `arch` `'javascript'`, `platform` `'browser'`,
  empty `argv`, `pid` 1 (d-0079)?
- **Why it matters:** Each steers a Node or Electron check to its browser branch.
- **Options:** keep until a real dependency breaks on one; each is one line in
  `src/shim/globals.ts` (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A226: STARTTLS cannot work over broker-terminated TLS **[AI-REC]**

- **Question:** `pg`, SMTP and IMAP clients upgrade a plain socket with `tls.connect({ socket })`;
  there is no in-place upgrade, so the shim refuses it (d-0100). Build one?
- **Why it matters:** A port speaking those protocols fails.
- **Options:** keep refused until a port needs it (rec.); `orivon.net.upgradeSecure` (contracts op,
  detachable socket in `dialOne`, a transport quiesce protocol, revocation by either grant).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A228: Is `http.createServer` in this build's scope? **[OWNER]**

- **Question:** `net.createServer` exists but no HTTP parser or `ServerResponse`, so
  `http.createServer` refuses by name. Build an HTTP server for a port that serves HTTP?
- **Why it matters:** Rule 4 builds it only when a need calls; `scope.md` names none yet.
- **Options:** refuse until a port needs it (rec.); an HTTP server over `orivon.net.listen`.
- **Who decides:** owner
- **Blocks:** any port that serves HTTP

### A231: Leave/Stay blocks the main process; closing a tab never asks **[AI-REC]**

- **Question:** `will-prevent-unload` settles synchronously, so its prompt stalls every tab's broker
  traffic (d-0082); `closeTab()` destroys the view without running `beforeunload`.
- **Why it matters:** Chrome asks on tab close; here unsaved work can be lost silently.
- **Options:** wait for a report (rec.); run `beforeunload` from `closeTab()` first; an asynchronous
  `will-prevent-unload` if Electron adds one.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A232: `prompt()` always returns `null` **[AI-REC]**

- **Question:** Electron has no `window.prompt()` dialog or hook, so every call reads as Cancel;
  `alert()` and `confirm()` work. Draw one?
- **Why it matters:** A page that asks for input this way never gets it.
- **Options:** wait for a port that needs it (rec.); a shell-drawn prompt through a preload
  override of `window.prompt` that blocks the page synchronously.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A233: A form `POST` that changes a tab's partition loses its body **[AI-REC]**

- **Question:** The shell swaps partitions after commit (`did-navigate`) and reloads as a `GET`, so
  a `POST` across an app boundary loses its body; a replay would submit twice.
- **Why it matters:** A sign-in or payment flow posting across an app boundary breaks.
- **Options:** A109's pre-commit interception, choosing the partition before the request (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing; depends on A109

### A235: The inlined `buffer` package runs in sloppy mode **[AI-REC]**

- **Question:** The preload bundler drops `buffer`'s nested `'use strict'` in `page-buffer.ts`;
  tests prove it works sloppy. Anything to do?
- **Why it matters:** A later package inlined the same way may rely on strict-mode semantics.
- **Options:** nothing now; whoever inlines another package checks that first (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A236: The update check sees a release only when the manifest changes **[OWNER]**

- **Question:** A 304 ends the conditional check (d-0088), so files shipped under a byte-identical
  manifest are never picked up. Is "bump `version` every release" a publisher requirement?
- **Why it matters:** A publisher who does not change the manifest never ships an update.
- **Options:** state the requirement; a daily unconditional check; compare the published hash-tree
  root (ADR-0029) with the pin, a cheaper backstop.
- **Who decides:** owner
- **Blocks:** nothing

### A237: An all-or-nothing re-prompt re-grants what the person revoked **[OWNER]**

- **Question:** After a widening update, an `all-or-nothing` prompt shows the full set; accepting
  clears every decline (d-0087), so a revoked capability returns. Intended?
- **Why it matters:** A permission deliberately taken away comes back inside a yes to
  something else.
- **Options:** accept (the full set is shown); keep revoked capabilities out, giving the app less
  than `all-or-nothing` promises.
- **Who decides:** owner
- **Blocks:** nothing

### A238: A first visit after restart can skip the install finish **[AI-REC]**

- **Question:** Inside the persisted interval (d-0088), a first visit answers `'up-to-date'` with no
  request, so `registerApp` is not re-run and an unanswered consent is not re-asked.
- **Why it matters:** An app whose consent prompt threw stays without consent until a real check.
- **Options:** re-ask an unanswered consent from the startup path, not the update check (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A239: Chromium's HTTP cache may answer the manifest check itself **[RESEARCH]**

- **Question:** Does `net.request` in Electron 44 serve a manifest still fresh under the host's
  `Cache-Control: max-age` without revalidating?
- **Why it matters:** A long `max-age` would delay noticing an update by that much.
- **Options:** measure; if so, send the check with a cache mode that always revalidates (rec.).
- **Who decides:** research first
- **Blocks:** nothing

### A240: A routed WebSocket holds an allowance slot for its whole life **[AI-REC]**

- **Question:** Routed WebSockets share the origin's socket allowance with `fetch` and XHR (d-0090).
  Give them an allowance of their own?
- **Why it matters:** Many subscription sockets starve `fetch`, which queues up to 120 s (A207).
- **Options:** measure ASGARDEX or a WalletConnect session first (rec.); a separate allowance.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A241: The dev CSP refuses a hot-reload WebSocket on another port **[AI-REC]**

- **Question:** Same-port HMR passes `connect-src 'self'` (d-0091); should the dev path also admit
  `ws://<page host>:*` for a separate HMR port?
- **Why it matters:** Setups using Vite's `server.hmr.port` or Parcel's `--hmr-port` break in dev.
- **Options:** not yet: Vite, webpack-dev-server, Next.js and Parcel default to one port (rec.);
  admit `ws://<page host>:*`.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A242: A CSP-refused native WebSocket never fires `close` **[RESEARCH]**

- **Question:** In Electron 44 it fires `error` and goes `CLOSED` with no `close` event, and the
  routed path passes that on. Anything beyond documenting it?
- **Why it matters:** An app waiting only on `onclose` to reconnect hangs.
- **Options:** document it as a porting trap, "listen for `error` too" (rec.); obsolete if Chromium
  fires `close`.
- **Who decides:** research first
- **Blocks:** nothing

### A243: `Notification.permission` reads `'denied'` for an undecided site **[OWNER]**

- **Question:** The boolean check handler makes an undecided site read `'denied'`, not `'default'`,
  from `Notification.permission` and the Permissions API. Override or accept?
- **Why it matters:** A page that checks first and gives up on `'denied'` never asks;
  `requestPermission()` still reaches the prompt.
- **Options:** a main-world override reporting `'default'`, under ADR-0021; a documented divergence.
- **Who decides:** owner
- **Blocks:** the first port that gates on `'default'`

### A244: E2e tests run on the user's real session bus **[AI-REC]**

- **Question:** `scripts/run-headless.mjs` starts a private D-Bus only with `ORIVON_PRIVATE_BUS=1`,
  which has no keyring. How to stop a test notification reaching the desktop?
- **Why it matters:** Nothing an agent runs may appear on the owner's screen.
- **Options:** a guard failing any e2e file that constructs a notification outside the private-bus
  runner (rec.); a private bus for every launch, with a stand-in keyring for `safeStorage` suites.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A245: Under `*:443`, a public name resolving to the LAN still reaches it **[OWNER]**

- **Question:** Should `*:443` ever reach the LAN through a public name with a trusted certificate
  (`*.plex.direct`)? A196 closed literals only; verified `connectSecure` does not resolve.
- **Why it matters:** A certificate binds a name, not an address.
- **Options:** apply d-0098's resolve-once check to every `connectSecure`, costing one resolution
  per connection and an address grant for such services (rec.); accept the residual.
- **Who decides:** owner
- **Blocks:** nothing

### A246: TLS credentials are parsed on the main thread per connection **[AI-REC]**

- **Question:** The secure context is built synchronously from the app's `ca`/`cert`/`key`/`pfx`,
  uncached; `SECURE_CONNECT_LIMITS` caps the sizes. Cache it per origin?
- **Why it matters:** T11b: one origin's parsing delays every tab's broker work, though bounded.
- **Options:** measure the worst case under the caps first (rec.); cache per origin and option set.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A247: Three gaps in the shim's `tls` **[AI-REC]**

- **Question:** `tls.rootCertificates` is absent; `minVersion`/`maxVersion`/`ciphers` are ignored
  silently; `getPeerCertificate(true)` has no issuer chain. Close any?
- **Why it matters:** `ca: [...tls.rootCertificates, mine]` fails by name.
- **Options:** wait for a port that needs one (rec.); export the root store through the broker;
  carry the chain in `PeerCertificate` (a contracts change).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A248: Confirm the address check on an unbound TLS handshake **[OWNER]**

- **Question:** Confirm d-0098: when a TLS option unbinds the certificate from the name, resolve
  once, apply `tcp.connect`'s address rule, and dial only the checked address?
- **Why it matters:** Without it, `rejectUnauthorized: false` under `*:443` reaches loopback by
  rebinding; the cost is a self-signed LAN node must be granted by address.
- **Options:** confirm, argued in `src/broker/README.md` (rec.); drop the check.
- **Who decides:** owner
- **Blocks:** nothing

### A249: Nothing is named as the daily-use driver or distribution asset **[OWNER]**

- **Question:** With the torrent app an idea (d-0105), what carries daily use and distribution: a
  port, the `.eth` journey, something else -- or is the success metric restated?
- **Why it matters:** `scope.md`'s organic-traction failure criterion cannot fire until one
  is named.
- **Options:** name a port; name the `.eth` journey; restate the metric.
- **Who decides:** owner
- **Blocks:** packaging (build step 10) and any distribution

### A250: Who provides this build's Web3 Score judged levels? **[OWNER]**

- **Question:** Is the judged-level provider (d-0106) an Orivon feed, a third party, or a local
  judge -- and if local, a person or a model, with what attestation keying?
- **Why it matters:** ADR-0006 allows a local, non-trustless provider but names none.
- **Options:** an Orivon-run feed; a third party; a local judge.
- **Who decides:** owner
- **Blocks:** build step 7

### A252: Any web page reaches loopback services with no prompt **[OWNER]**

- **Question:** Electron 44 disables `LocalNetworkAccessChecks`, so any page can fetch
  `http://127.0.0.1:<port>/` unseen by the gate. Accept this build, or block it?
- **Why it matters:** a gap in `security-model.md` T12 (covers only `orivon.*` sockets). `.eth`
  pages are served from loopback; `test/e2e-eth-verified.test.ts` is the canary.
- **Options:** accept and say so in T12; block in the shell (a `webRequest` filter on private
  destinations requested from public documents).
- **Who decides:** owner
- **Blocks:** packaging (build step 10)

### A253: Light client runs from launch on one keyless HTTPS beacon API **[OWNER]**

- **Question:** Start Helios at launch (current) or on the first `.eth` navigation? What backs up
  `ethereum-beacon-api.publicnode.com`, the only keyless HTTPS beacon API found?
- **Why it matters:** from launch it costs ~20 MB/hour and 150-200 MB of memory, `.eth` used or
  not; the consensus side has no failover.
- **Options:** launch or lazy start (a few seconds' sync); a second HTTPS beacon API, or plain-HTTP
  Nimbus, safe since the client verifies what it receives.
- **Who decides:** owner
- **Blocks:** packaging (build step 10)

### A257: Should `src/main/` adopt ADR-0035's file-naming rule? **[OWNER]**

- **Question:** ADR-0035 drops words the folder already says (`serve/csp.ts`); `src/main/`
  (ADR-0023) keeps them (`install/app-install.ts`). Should they match?
- **Why it matters:** the two read two ways and a reader must notice which applies; no behaviour
  changes under any option.
- **Options:** rename `src/main/`'s files (every import, comment and doc link again); leave it as
  ADR-0023 left it; write the rule into ADR-0023 and apply it forward only.
- **Who decides:** owner
- **Blocks:** nothing

### A260: `ipfs://` subresources inside a page do not load **[RESEARCH]**

- **Question:** Navigations to `ipfs://`/`ipns://` load (ADR-0038); an `<img>`, `fetch`, script
  or stylesheet using one gets nothing, since Chromium knows no `ipfs:` scheme.
- **Why it matters:** unknown how often real content needs it; IPFS sites mostly use relative paths.
- **Options:** wait for a real site that breaks (rec.), then register each scheme privileged before
  `ready` with a `protocol.handle` redirecting to the served origin; redirect-following for every
  subresource kind (CORS included) is unmeasured.
- **Who decides:** research first
- **Blocks:** nothing

### A261: `web.embed`'s page ceiling, and what `"*"` reaches **[OWNER]**

- **Question:** ADR-0039 sets two provisional rules: `LIMITS.embeds` is 32 pages per app, and
  `"*"` never reaches an address literal outside public unicast or a `localhost` name.
- **Why it matters:** each shown page is a renderer process; and the app's own script runs
  inside a shown page, so a wider `"*"` is T12 with a page around it.
- **Options:** confirm both (rec.); raise the ceiling when a real app reaches it; let `"*"`
  reach anything a person could type into the address bar.
- **Who decides:** owner
- **Blocks:** nothing until a real app reaches either limit

### A262: The direct gateway route trusts a proxy check made at the verifier host's start **[OWNER]**

- **Question:** Should the direct route check for a proxy when it is taken, not only when the
  verifier host starts?
- **Why it matters:** a proxy turned on mid-run (a VPN, a corporate network, Tor through a proxy)
  is not seen until the host restarts; until then a failing gateway whose system address disagrees
  with DNS-over-HTTPS is reached directly, from the person's real address (T40).
- **Options:** the host asks main (`app.resolveProxy`) at decision time, one round trip on a rare
  path (rec.); main pushes proxy changes into the host; keep the snapshot and say so.
- **Who decides:** owner
- **Blocks:** nothing

### A263: T20 and T40 disagree about going around a proxy **[OWNER]**

- **Question:** Does T20 ("never silently direct-connect around a proxy ... same for DNS
  resolution") bind the verifier host, or only app capabilities?
- **Why it matters:** T40's route resolves over DNS-over-HTTPS and connects outside `net`, and
  neither row cites the other. Split-horizon DNS, whose internal answer differs on purpose, looks
  exactly like ISP forgery and is routed around too.
- **Options:** scope T20 to app capabilities and say in T40 why the verifier differs, with A262's
  live check (rec.); read T40 as a T20 violation and drop the route whenever a proxy could apply.
- **Who decides:** owner
- **Blocks:** nothing

### A264: Taking the direct gateway route is silent **[OWNER]**

- **Question:** Should the person learn that their resolver forges a gateway's address, and that
  Orivon went around it?
- **Why it matters:** today it is one line on the verifier host's stderr. The person learns
  neither fact, though the second changes which route their traffic takes.
- **Options:** a line in Settings' verifier section and a switch to turn the route off (rec.: it
  is a fact about the network, not one site); a `route` field on `SiteProvenance`
  (`src/protocols/verifier-host/protocol.ts`) shown in the site-info popover; leave it silent.
- **Who decides:** owner
- **Blocks:** nothing

### A265: A network observer can tell the direct gateway route apart **[OWNER]**

- **Question:** Is it acceptable that adversary 4 (`security-model.md`) sees Orivon working
  around its DNS?
- **Why it matters:** the retry is a Node TLS handshake (a ClientHello unlike Chromium's, no ALPN)
  naming the gateway, seconds after Chromium's failed attempt. T40 names it.
- **Options:** accept it and keep it named (rec.); make the handshake resemble Chromium's, which
  Node cannot fully do; let the person turn the route off (A264).
- **Who decides:** owner
- **Blocks:** nothing

### A266: "No address in common" is a weak sign of tampering behind a CDN **[OWNER]**

- **Question:** Are disjoint answers from the system resolver and DNS-over-HTTPS enough to take
  the direct route?
- **Why it matters:** a CDN gives different resolvers different honest addresses (GeoDNS, client
  subnet, round robin), so a fast transport failure on an honest line can switch a gateway to the
  direct route for `DIRECT_FOR_MS` (10 minutes). TLS and block hashes still hold.
- **Options:** also require the system address to fail TLS for the name while the DoH one passes
  (rec.); shorten `DIRECT_FOR_MS`; accept it. Both answers are compared canonically already.
- **Who decides:** owner
- **Blocks:** nothing

### A267: A resolver that blackholes a gateway is never detected **[OWNER]**

- **Question:** Should a gateway that times out, rather than failing fast, ever lead to the
  resolver comparison?
- **Why it matters:** the comparison runs only on a transport error before the request's
  deadline, so an address where nothing answers is never checked. A system resolver failing with
  anything but "name not resolved" never leads to the direct route either (`d-0154`).
- **Options:** keep it: a timeout is no evidence of tampering, and traffic stays on `net` (rec.);
  count a second consecutive timeout per gateway as a failure worth checking.
- **Who decides:** owner
- **Blocks:** nothing

### A268: Electron's `net.fetch` throws uncaught on a status outside 200-599 **[AI-REC]**

- **Question:** How should the verifier host survive a 999 or 600 answer through `net.fetch`?
- **Why it matters:** measured on Electron 44 (in main): `net.fetch` builds its `Response` inside
  its own listener, so the `RangeError` is uncaught and the promise never settles. The host has no
  handler for that, so it would exit and every `.eth` page fail until it restarts. A CCIP-Read URL
  is chosen by a name's resolver contract, so a `.eth` name can point it at such a server.
- **Options:** the host's fetch over `net.request`, the status checked before a `Response` is built,
  as `src/loader/electron/fetch.ts` does (rec.); a process-level handler, which leaves the request
  hanging. Report it to Electron either way.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A269: The toolbar popups' commands are checked by sender identity, not URL **[OWNER]**

- **Question:** Should `settings-ipc.ts` and `site-info-ipc.ts` also compare the sender frame's
  URL, as `ipc.ts`'s `isFromChrome` does for the chrome?
- **Why it matters:** the settings channel revokes grants. A popup has two layers today: its view
  is locked to its document, and its preload exposes nothing at another URL. The chrome has a
  third, the URL check in main.
- **Options:** pass the popup's URL to `PopoverSpec.registerIpc` and compare `senderFrame.url`
  there too, so the three privileged views agree (rec.); keep two layers and say why they suffice.
- **Who decides:** owner
- **Blocks:** nothing

### A270: Refuse more of SVG in a favicon than a DOCTYPE internal subset **[OWNER]**

- **Question:** Should the favicon sniffer also refuse `<script`, `<foreignObject`, `<animate`,
  `<set` and `<filter`, the way it refuses a DOCTYPE internal subset?
- **Why it matters:** an SVG favicon reaches Chromium's SVG engine in the privileged chrome
  renderer and the new-tab page, and persists in `bookmarks.json`; `<img>` mode (no script, no
  network) is today the only guarantee (`src/main/browsing/README.md`).
- **Options:** keep `<img>` mode as the boundary (rec.: a substring match is no parse, and the
  4 KiB window is passed by padding); refuse them across the whole body; accept raster icons only.
- **Who decides:** owner
- **Blocks:** nothing

### A271: A cross-origin page declaring the same icon URLs shows the globe **[AI-REC]**

- **Question:** `page-favicon-updated` fires only when a page's icon set differs from the last
  one, across origins too (measured, Electron 44), yet `did-navigate` clears the icon on any
  origin change (`shouldClearFavicon`). How does the tab get its icon back?
- **Why it matters:** subdomains sharing one absolute icon URL lose it for the whole visit.
- **Options:** on a cross-origin `did-navigate`, rerun the capture with the tab's last icon set
  against the new page, which a different set's own event supersedes (rec.); accept the gap.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A273: `orivon.fs.rm` cannot remove an empty directory in one call **[AI-REC]**

- **Question:** Should the broker remove a directory with a non-recursive `rm` when it is empty,
  and fail `ENOTEMPTY` otherwise, as POSIX `rmdir` does?
- **Why it matters:** `rm` removes a directory only recursively, so the WASI host's
  `path_remove_directory` checks emptiness and then deletes; a file created in between is lost.
- **Options:** map a non-recursive `rm` on a directory to `rmdir` in `src/broker/` (rec.), no
  contract type change; add an `rmdir` method, a contracts change; keep the window.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A274: A second profile counts as a second install in usage statistics **[OWNER]**

- **Question:** Should a second profile send its own usage statistics, or share the default's install id?
- **Why it matters:** telemetry's install id is kept in the data directory, so each profile reports its
  own time and a person with two profiles counts as two installs. The success metric counts people.
- **Options:** the default profile's directory keeps the id and other profiles send nothing (rec.);
  other profiles share its id; leave it. Each is a small change to `src/telemetry/`.
- **Who decides:** owner
- **Blocks:** nothing

### A275: The update check is off until the owner decides **[OWNER]**

- **Question:** Should looking for a newer release be on by default, and should Settings link to it?
- **Why it matters:** the check asks GitHub once a day and installs nothing (`update-check.ts`); a
  request to a third party at every start is a decision about what the browser tells one. It only
  notifies, and Settings gives no way to the release page.
- **Options:** keep it off, with "Check now" in Settings (rec.); on by default with a disclosure.
- **Who decides:** owner
- **Blocks:** nothing

### A276: What happens to a download is not settled **[RESEARCH]**

- **Question:** Where does a download go, does it ask, and what may an app tab download?
- **Why it matters:** Settings has no downloads section because none of it was checked against a real
  page; a control would promise behaviour nobody measured. A private window keeps downloaded files.
- **Options:** download from a website tab and an app tab in each kind of window, then decide the
  folder (rec.).
- **Who decides:** research first
- **Blocks:** a downloads section in Settings

### A277: Dragging a tab into another window is best effort on Wayland **[RESEARCH]**

- **Question:** Can a tab dropped over another window find it under Wayland?
- **Why it matters:** where the pointer let go is read from the screen. Wayland tells an application
  neither where its windows are nor lets it move them, so a drop may miss and a torn-off window opens
  where the compositor puts it. The tab's menu and the commands never depend on position.
- **Options:** measure drag and drop on a real Wayland session (rec.); use the compositor's protocol.
- **Who decides:** research first
- **Blocks:** nothing

### A278: A development run and an installed one share a data directory **[OWNER]**

- **Question:** Should a development run and an installed browser use different directories by default?
- **Why it matters:** both use the operating system's directory, and a profile allows one browser at a
  time, so starting one while the other runs hands over to it (`ADR-0042`). Both at once needs
  `--user-data-dir`.
- **Options:** keep sharing and document the switch (rec.); separate them by default.
- **Who decides:** owner
- **Blocks:** nothing

### A279: Sweeping a private session's directory on Windows is unmeasured **[RESEARCH]**

- **Question:** Does the sweep remove a crashed private session's directory on Windows?
- **Why it matters:** the sweep checks this user owns the directory; Windows has no owner id to compare
  and refuses to delete a file another process holds open, so it may survive a start (`ADR-0042`).
- **Options:** run a private session's start, crash and sweep on Windows (rec.).
- **Who decides:** research first
- **Blocks:** nothing

### A280: History's defaults are provisional, and it feeds nothing yet **[AI-REC]**

- **Question:** Is 90 days the right retention, and should the address bar suggest from history?
- **Why it matters:** 90 is a guess at what a person expects, and nothing else reads history. It is one
  SQLite file through Node's experimental `node:sqlite`, behind an interface.
- **Options:** keep the guess until people ask otherwise (rec.); set it from measured use.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A281: Clearing app data reaches the apps that hold permissions **[AI-REC]**

- **Question:** Should "Clear browsing data" also reach an app that is installed but holds none?
- **Why it matters:** it clears the browser storage of every app that holds a permission; an app whose
  code is pinned but which holds none keeps its own session and is not reached.
- **Options:** list apps from what is pinned as well as granted, once a real app is installed without a
  grant (rec.).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### A282: The first-run usage statistics screen is not built **[OWNER]**

- **Question:** Where in the welcome flow does the usage statistics question sit?
- **Why it matters:** `ADR-0004` calls for a first-run screen with the exact text and two buttons,
  neither preselected. Settings has the same choice, undecided until made and nothing sent before it,
  but no screen asks on first run.
- **Options:** build it on the welcome flow once the owner says where (rec.).
- **Who decides:** owner
- **Blocks:** nothing

### B4: UI words for app keys, named identities and wallets **[OWNER]**

- **Question:** What words tell apart silent per-origin app keys, named identities (shared
  across sites by a per-site connect prompt) and a funds-bearing wallet? The model is settled
  in `capability-api.md`.
- **Why it matters:** blurred words invite exposing an identity or funds where a throwaway key
  was meant.
- **Options:** one noun per kind, used for nothing else (rec.); the nouns are the owner's.
- **Who decides:** owner
- **Blocks:** the named-identity connect prompt and any wallet UI (neither is a build step)

### B5: Where FreeTube's storage assertions belong, and what they assert **[AI-REC]**

- **Question:** `test/e2e-freetube-real.test.ts` asserts nedb files at the app's fs root, a claim
  about a bundle built in `orivon-ports` (ADR-0020). Move those checks there? Its IndexedDB
  check also passes on `localforage`, a name the failing build never uses (`NeDB`).
- **Why it matters:** CI never checks out `orivon-ports`, so the coupling fails unseen.
- **Options:** move the storage checks beside the bundle in `orivon-ports` (rec.); keep them
  here and assert no IndexedDB database exists at all.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing

### BB1: `orivon.mdx` states a bitcoind goal in the present tense **[OWNER]**

- **Question:** `orivon.mdx` says bitcoind "would be already runnable as a site on Orivon".
  Fix the tense and keep the ambition?
- **Why it matters:** it is the first claim a technical evaluator will test, and it fails today.
- **Options:** rewrite it as a goal, ambition intact (rec.); leave it.
- **Who decides:** owner (the public docs live in `<vision-corpus>`)
- **Blocks:** nothing

### C1: Does DDOC justify self-signed HTTPS, as `Glossario` claims **[RESEARCH]**

- **Question:** Does a verified tree make self-signed TLS acceptable on a DDOC site? The anchor
  is settled (ADR-0029: ENS contenthash for `.eth`, the site's own host otherwise, no DNS).
- **Why it matters:** the claim needs hard scrutiny before anyone repeats it publicly.
- **Options:** likely no, since a same-host tree arrives over the channel in question; confirm
  before any public statement (rec.).
- **Who decides:** research first
- **Blocks:** nothing

### C4: Do real Nostr clients accept an injected `window.nostr` **[RESEARCH]**

- **Question:** The ~1 day Nostr estimate assumes clients accept an injected NIP-07
  `window.nostr` cleanly. Try two or three real clients, and check each licence (several AGPL).
- **Why it matters:** the estimate is unverified.
- **Options:** a cheap conformance check before relying on the estimate (rec.).
- **Who decides:** research first
- **Blocks:** Nostr identity (an idea, `docs/scope.md` §LATER)

### C5: Which tool writes a publisher's `orivon-ddoc.json` **[AI-REC]**

- **Question:** Rule 6's reuse-or-build call is open only for the DDOC generator.
  `orivon-ports`' `declare` step writes `assets` and the tree, for ports only. What does any
  other publisher run?
- **Why it matters:** a site reaches DDOC (Website Level 2) only by publishing its tree.
- **Options:** extract `declare` as a standalone publisher tool (rec.); document the format and
  let publishers write their own; a second generator here.
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing until a publisher outside `orivon-ports` needs DDOC

### C6: Why `_electron` never attached to the week-0 video window **[AI-REC]**

- **Question:** In spike gate 3, Playwright's `_electron` saw no target for the window though a
  direct launch worked (`planning/spike-results/gate-3.json`). The cause is unknown.
- **Why it matters:** only if it recurs: tests match windows via `app.windows()`, and the
  address-bar click flake has a bounded retry.
- **Options:** close as not worth pursuing (rec.); probe the untried causes (the `<video>`
  element, a raw CDP client).
- **Who decides:** AI, the recommendation stands unless the owner objects
- **Blocks:** nothing
