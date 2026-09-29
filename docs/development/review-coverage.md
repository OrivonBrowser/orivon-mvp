# Review coverage

Which pull requests have been independently reviewed, and by what, used to exist in **no label,
no field and no document**, only in prose inside fleet ledgers kept outside this repository
(`docs/open-questions.md` A126). The owner had to reconstruct the gap by hand and hand the list
over; it could not be derived from the repository at all. This is that record, moved in-repo.

## What belongs here

Not every merged PR gets a row. An ordinary PR merges on its own author's testing, as this
repository has always allowed, and that is not a gap this document exists to close.

An entry belongs here when an **independent** review pass ran over a PR or a range of them,
independent meaning a second reader, human or agent, checking work that was not their own:

- a conductor's hand-review of a diff (the standing carve-out for `src/broker/` and `src/main/`,
  from `.claude/unattended-run-protocol.md`'s "Which model runs what": those two
  directories are hand-reviewed personally, never trusted from a lane's own report alone);
- an `adversarial-reviewer` or `named-persona-adversarial-review` pass (the `orivon-workflow` skill's
  review shape: run at the end of a build step, on the broker and the app loader at minimum);
- a `/claude-security` scan (the `orivon-workflow` skill's tooling table: end of build step 2, and before
  packaging);
- a clean-checkout verification: a fresh clone and install, run to catch what a shared
  `node_modules` symlink across worktrees cannot.

Record the range, what ran, who or what ran it, and the outcome in aggregate, not a
re-narration of each individual finding, which belongs in `open-questions.md` or in the PR
itself.

## Where the record starts

**Nothing before PR #163 is recorded here.** That is not a claim that earlier PRs went
unreviewed: `docs/planning/audit-2026-08-25.md` records five independent audits that predate
this document, and `CLAUDE.md`'s tooling table has required `adversarial-reviewer` and
`/claude-security` at named points since 2026-08-25. It is only that no one brought the record
inside the repository before now, so the honest state of everything earlier is **unrecorded**,
not **unreviewed**. Do not read an absence above this line as a finding.

## Log

### PRs #163-#182: build step 4 landing and hardening pass (19 PRs, 2026-09-13/14)

| Mechanism | Scope | Outcome |
|---|---|---|
| Conductor hand-review | Every diff in this range touching `src/broker/` or `src/main/`, applied PR by PR as each one merged | Caught issues before merge within this range: for example three rationale comments ("nothing calls this yet") that had gone stale between being written and tonight, fixed conductor-authored in PR #177 before they could mislead a later reader |
| Three-reviewer adversarial pass | The 93-file, ~7400-insertion step-4 landing (PRs #163-#177) as a whole, once it was complete, split by axis rather than by file count: adv1 (the consent and grant path), adv2 (the loader and pinned-bundle serving), adv3 (the seams between PRs, the axis no single-PR review can see) | 10 issues found. 8 fixed in the same run (PRs #179-#181); 2 filed open and still unresolved: `open-questions.md` A157 (partially) and A158 (fully) |
| Clean-checkout verification | Main after the adversarial fixes (PR #181, 18 PRs): a fresh clone from the GitHub remote (not the local repository, so it also proved `origin/main` reachable), its own `npm install`, the full gate suite, full e2e, `npm run build`, `check:dev-grant-absent` | Passed completely against a genuinely fresh `out/`. Also surfaced an unrelated leak (`scripts/smoke.mjs` never removing its temp profile), fixed as PR #182, the last PR in this range |

Per-finding detail is in `open-questions.md` (A153-A158) and this run's own fleet ledger, kept
outside this repository. This row records that the review happened and what it found in
aggregate, not a re-narration of each finding.

### PRs #183-#198: the post-step-4 range (16 PRs, 2026-09-15)

Reviewed as one range rather than per PR, because the prior entry stops at #182 and nothing
independent had run over anything after it. 100 files, +7572/-587; 40 of those are non-test source
files at +2254/-345.

| Mechanism | Scope | Outcome |
|---|---|---|
| Four adversarial review lanes, split by axis rather than by file count | Consent and grants; loader, pinned-bundle serving, CSP and third-party reach; the Node shim's named refusals, the window/launch path and CI tooling; and the seams between PRs plus alignment against `scope.md`, the ADRs and the build queue's exit criteria | 10 findings. The axis split is what earned them: the seam lane found a defect no single-PR review can see, and the two tooling reviewers independently found different holes in the same CI gate |
| Conductor hand-review | Every diff in the range touching `src/broker/` or `src/main/`, per the standing carve-out in `unattended-run-protocol.md` | 3 findings, one of them the range's most serious. Also caught, in review of a fix, a regression test that never awaited the async call whose behaviour it was asserting: it was passing on scheduling order rather than on the contract |
| `/code-review`, high effort | The whole range diff | 5 findings, plus six areas explicitly checked and cleared, which is the half of a review that usually goes unrecorded |
| `ca:security-reviewer` | The range, against `.codearbiter/security-controls.md` | PASS: no critical or high findings. One medium, pre-existing and already tracked, neither introduced nor worsened here. Independently re-derived the pinned-manifest hydration chain and confirmed it never trusts an unverified disk read |
| Named-persona adversarial review | The range, through three documented engineering and product philosophies | Two findings promoted by concurrence with other mechanisms, and three that no other mechanism produced, all three from lenses the others did not have: compatibility treated as a contract, and the person's own experience of the consent surface |

**The mechanisms disagreed, and that is the argument for running more than one.** The controls-based
security review passed the range clean while the most serious defect in it (a live handle
surviving the revocation that was supposed to tear it down) went unseen there, because a handle
lifecycle bug is outside what a controls review looks at. It was found by an adversarial lane and
confirmed by hand.

Per-finding detail is in `open-questions.md` (A168-A182). This row records that the review happened
and what it found in aggregate, not a re-narration of each finding.


### PRs #21, #22 and #24: the chrome-view lock, favicons, `.eth` gateway reliability (2026-09-28)

Reviewed after #22 and #24 had merged and while #21 was open. The fixes are #29 (the verifier)
and #30 (the shell).

| Mechanism | Scope | Outcome |
|---|---|---|
| Adversarial personas (`adversarial-reviewer`) | All three PRs | Findings pooled with the next three rows: 32 in all, 5 of them HIGH, listed below the table |
| `/code-review`, high effort | #24 and #21 | Pooled, as above |
| Named-persona adversarial review | #21 and #22 | Pooled, as above |
| STRIDE and DREAD model | #24's direct gateway route | Pooled, as above |
| `/security-review` methodology, "exploitable, not denial of service" bar | All three PRs | No HIGH or MEDIUM vulnerability newly introduced. It reproduced the SVG DOCTYPE bypass and the 999-status crash independently and classed both as denial of service, confirmed the direct route cannot be steered at a non-public address, and noted that #22 closed an older gap: favicon redirects had no per-hop address check |

The HIGH findings: an abandoned hedge attempt cooled an honest gateway down; an aborted direct
attempt reset the DNS-tamper route; a gateway answering 999 or 101 crashed or wedged the verifier
host; a failed favicon request was never torn down; and a same-document URL change dropped the
tab's icon. Eleven of the 32 were reached by two passes independently and treated as settled
rather than as one reviewer's opinion. Owner calls went to `open-questions.md`: A262-A267 on the
direct gateway route, A269 on the popups' sender check, A270 on SVG favicons. Fixing found two
more: A258's cause was the certificate serial's DER padding, and Electron's own `net.fetch`
throws uncaught on a status outside 200-599 (A268).

Not run: `ca:review` and `ca:security-reviewer`, which need an initialised `.codearbiter/`, and
`claude-security`, which was not installed.

**The strict bar and the correctness passes disagreed, usefully.** The security methodology,
asked only for exploitable vulnerabilities, passed all three PRs; the defects it set aside as
denial of service are the ones that would have failed `.eth` pages and favicons for real users.

### The browser-grade shell branch: Settings, profiles, history, zoom, tabs, split view, private windows, DevTools (2026-09-28)

Reviewed once the branch was complete and before it merged. The fixes are in the same PR.

| Mechanism | Scope | Outcome |
|---|---|---|
| Correctness review by a subagent, read-only, with throwaway probes for the findings it could reproduce | The tab, split and window code | 10 findings, none a crash in main: a listener leaked per tab per redraw, a split's survivor left half-size, a fullscreen claim that outlived its tab, a close reported twice, a joined pair split by a move. All fixed with a test each |
| Adversarial security review by a subagent, read-only | The new IPC, internal-page, launch and history surface | 9 findings and a dev-only nit, none a way for a page to reach a domain it should not. Availability and privacy: a failed peer start ended the browser, a failed prune ended it at every start, the visit list of IPNS names was copied into private sessions, history could grow without bound and kept cleared addresses in its file, DevTools' question was asked by address and not by session. All fixed with a test each |

## Adding an entry

When an independent review event finishes (a hand-review, an adversarial pass, a security
scan, a clean-checkout run) add one row naming the PR or range it covered, what ran, and the
outcome. This is not filled in per ordinary PR; most PRs here merge on their author's own
verification, and recording that would not tell a later reader anything they could not already
see in the PR itself.

### `stream/wasi-host`: the WASI host (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort, run by a forked reviewer | The branch against `main`: `src/shim/wasi/`, the `wasi` module row, its tests and e2e, and the docs | 10 findings, with no verify pass. Eight were correctness defects: a kill that could not end a pending read or sleep, a handle leaked by a kill, a reactor whose memory was never bound, a reactor's files closed after `_initialize`, a sleep over 24.8 days firing at once, a readdir cookie at or above 2^63 trapping, a path decoded from shared memory, and a window in `path_remove_directory`. The other two were a Rule 2 phrase in `scope.md` and serial stats in `fd_readdir`. Nine fixed in the same PR, with a test where one applies; the window needs a broker change and is filed as A273 |

### `stream/child-process`: `child_process` over Web Workers (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort, run by a forked reviewer | `src/shim/worker/` and `src/shim/child-process/` against the WASI-host branch | 10 findings, all fixed in the same branch with a test each: the stdout sink transferred the buffer the WASI host then measured, so `fd_write` reported 0 bytes and a real libc would rewrite forever (the hand-assembled test programs ignored the count); a forked child never ended on its own; `kill()` emitted `exit` synchronously and `kill(0)` threw; a Worker that could not be created was an unhandled rejection; a load failure after a kill emitted a second `error`; held IPC deadlocked a top-level `await` on the first message; a handle's `closed` lost its `platformCode`; `execFile(file, undefined, options)` dropped its options; and `#` was not refused as a shell comment |

### `stream/native-addons`: native addons through emnapi (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort, run by a forked reviewer | `src/shim/addon/`, the `module` target, and the WASI host's synchronous imports | 10 findings, all fixed in the same branch, with a test where one applies: a concurrent preload could instantiate an addon twice; `createRequire(import.meta.url)` misread an https URL; a command build crashed inside emnapi instead of refusing; addon output bypassed a forked child's stdout and a line without a newline was lost; the synchronous `fd_write` answered NOSYS for a bad descriptor; a preload's errors were not wrapped; the cache key was not normalised; every host built the synchronous imports eagerly; and the polyfills README missed the new module |

### `stream/addon-files`: an addon's files through a Worker's synchronous calls (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort, run by a forked reviewer | The WASI host's effect generators and drivers, `src/shim/worker/sync-channel.ts` with the server and client changes, and the addon loader's synchronous fs | 9 findings, all fixed in the same branch with a test where one applies: a refused synchronous reply left what it opened open on the page; a reply that failed to encode left the Worker waiting forever; `fd_renumber` became a suspending import; one revoked call disabled an addon for good; the reply writer pinned the last reply; an invalid reply channel threw on the page; stdin read end of input silently under the synchronous driver; sub-millisecond `poll_oneoff` waits began yielding; and the limit retry and the driver loop existed twice |

### The whole-repository review: `main`, the WASI stack, the shell, and their fixes in #36 and #38 (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| Conventional review lanes, one per area, triaged by hand | `main`: `src/broker/` (two passes), `src/main/` with `src/preload/` and `src/protocols/`, `src/loader/` with the shims, and telemetry, trust, nostr, contracts, CI and dependencies; the WASI stack #31-#34; the shell branch; `stream/security-hardening` | On `main`, a `web.embed` `"*"` grant reached private and loopback hosts through any host name (fixed in #36, d-0182, residual A286); the fs confinement race (filed as A283, see below); an app tab's flag surviving an in-place navigation (fixed in #38); smaller fixes in #36. `stream/security-hardening` is superseded by `main` and was not merged |
| `security-review` skill | The stack; the shell branch | No finding at its bar on either |
| `adversarial-reviewer` skill | The stack; `main`'s broker and loader | The `"*"` embed finding above; one LOW on the stack, fixed |
| `named-persona-adversarial-review` skill | The shell branch | ADR-0041 and ADR-0042 held; a reused pid after a reboot kept a private directory unswept, fixed |
| Alignment and privacy lane | All pending work | Stack and shell aligned; their colliding ids resolved by renumbering the shell |
| `/code-review`, high effort, run by the verify lanes | #36's diff; #38's whole branch | #36: the first fs fix refused in-root symlinks, so it was reverted and A283 records the fix it needs. #38: a DevTools teardown crash, a split at the tab limit, and a private window that lost the sandbox switch in CI; all fixed |
| Gate, smoke and e2e, headless | #36 and #38 | Typecheck, unit, the 12 guards, smoke and e2e pass; the two FreeTube e2e files fail on `main` as well (the network) |

### `stream/wasi-p2`: a WASI 0.2 host for spawned components (2026-09-28)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort, run by a forked reviewer | `src/shim/wasi-p2/`, component resolution in `child_process`, the Worker's component path | 12 findings, all fixed in the same branch with a test where one applies: the glue check failed open, so a fallback page made a missing program ENOEXEC; a late connect, listen or bind after drop leaked its handle; a listener leaked queued connections and could hang; an empty write while busy trapped; a shared address sent the wrong resolved name; error codes crossed interfaces; lookup failures had the wrong code; a revoked grant did not stop the component; a mapped address was accepted; clocks, randomness and the path checks existed twice; two docs lines were false; and several finish, send and shutdown edges departed from the spec |
| Real programs built outside the repository, run against the hosts (opt-in tests) | A Rust `std` program and a tokio program for `wasm32-wasip2`; a napi-rs 3 addon | Four gaps no fixture showed, each fixed or recorded: UDP's stream resource classes were missing, so no such program instantiated; a napi-rs build's imported memory and registration exports were unsupported, so none loaded; `finish-listen` and UDP `finish-bind` answered `would-block`, which fails every tokio listener and UDP bind; tokio's own name resolution traps for want of a thread, which the WASI 0.2 README now states with the workaround |

### `stream/napi-rs-packages`: published napi-rs packages, `worker_threads` and `vm` (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| Self-review, with a bundling probe | The two new module targets, as an ESM default import and as a CommonJS `require()` bundled by esbuild | Found that `require()` gets a shim module's namespace, where an unbuilt member is `undefined` rather than refused by name, in every shim module: A287, and the shim README corrected |
| Negative run of the opt-in e2e | `test/e2e-napi-rs-package.test.ts` with `crossOriginIsolated: false` | Fails, so the check depends on the isolation Orivon serves |
| Review before merge, inline | The branch against `main` | No defect in the branch's own code. CI's one failure was a flake in `setImmediate`'s tests, which waited a fixed 10 ms for a MessageChannel task; they now wait on a sentinel immediate |

### `stream/extensions`: Chrome extensions (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort | The branch against `main`, `vendor/` limited to Orivon's patches | Ten findings, all fixed: a URL-policy check that never refused, a `.crx` able to take another extension's id, library channels trusting the named extension id, a refused store install reported as success, same-version reinstall, a corrupt registry being overwritten, and comments telling history |
| `security-review` skill, each finding verified separately | The same diff | Three HIGH, all fixed: a manifest `version` that walked the install directory out of the extensions folder, `chrome.cookies` with no permission or host check, tab URLs and titles reaching extensions without `tabs` or host access |
| Gate, smoke and e2e, headless | The branch | Typecheck, unit, the 12 guards and smoke pass; e2e passes except the three files whose fixture ports the unrelated local server holds, which fail identically on `main` |
| Five review agents in parallel, each finding verified before a fix | This branch in three slices (install path, runtime boundary, docs and licences) | Install path, three major: a PEM-armoured manifest `key` loaded one extension under another's id, a folder install followed symlinks out of its tree, registry writes raced. Runtime, five major: `chrome.windows.*` leaked every tab's URL, an id-less `crx-msg` reached the toolbar-only handlers, a listener error exited the browser, `insertCSS` needed no host access, `tabs.create` handed out a granted app's tab. Eight minor, the docs' measured claims and the vendored licence notices. All fixed, each with a test |
| Opt-in real-extension e2e, after the fixes | uBOL, Dark Reader, Bitwarden, MetaMask | Caught one of the fixes gating the worker preload on `location`, which a worker's preload realm lacks: every extension worker lost `chrome.*` and Dark Reader stopped styling pages, with CI green. Fixed; the toolbar e2e now fails if an extension preload cannot load. All pass |

### `stream/rf-security`: served-content framing, `web.embed` attach pairing, the sync-reply fallback (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| Conductor hand-review of each diff under `src/main/`, `src/shim/` and `src/protocols/` | The branch against `main` | `hardenGuest` forces a guest's partition and drops any `session`, so looking an attaching guest up by its session cannot credit it to another app; no defect |
| `/code-review`, high effort | The same diff | Nine findings, all acted on: a refused successful reply kept its handles; the fallback error said retryable; a 304 let a copy cached before the change stay frameable; a redirect carried a directive browsers ignore there; a decision id in the security model and history in test comments (Rule 2); two tests left ports open; no end-to-end check that Chromium enforces the header, now `test/e2e-eth-framing.test.ts`; plain-text replies stay without it, and the decision says which responses carry it |
| Security review (the `security-review` method, applied to the branch diff by an agent) | The same diff | No exploitable finding. Fixed a leak of the same class (a successful reply that fails to encode kept its handles); scoped "only its own origin" to what the verifier serves, a `web.embed` grant still showing the site; filed A295 (whether a `<webview>`'s own `webpreferences` attribute reaches the guest) |
| Gate, smoke and e2e, headless | The branch | Typecheck, unit, the 12 guards and smoke pass; e2e passes, 64 of 65 files with 4 opt-in skipped, the files on ports the unrelated local server holds run as port-swapped copies; the one failure is FreeTube's live playback, which reaches the real network |

### `stream/rf-shell`: shell follow-ups from the whole-repository review (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| Conductor hand-review of each lane's diff under `src/main/` and `src/broker/`, with a measurement | The branch against `main` | Found a relaunch with no address opening a window with no tab (fixed); measured the first FTS5 search join 15-40 ms slower than the old scan for common terms, which led to searching the index only when few pages match |
| `/code-review`, high effort | The same diff | Ten findings, eight fixed: a forgotten page's words left readable in the search index (FTS5 secure-delete); a three-character rule that counted UTF-16 units; two search paths folding case differently; two windows from a second start during startup; DevTools on the shell's own views gated only at one call site; an extra open and a stray temp file in the atomic writer. Not changed, with reasons in the PR: the search probe's second lookup (under 2.5 ms) and the atomic writer's home (the broker may import nothing outside contracts) |
| `/code-review`, high effort, second pass over the fixes | The same diff | Nine findings, all fixed: clearing a full history taking ~40 s through per-row secure deletes (now one bulk path, ~0.3 s); the automatic trim rebuilding the index on the navigation path; a single forgotten page left in the write-ahead log; a count scanning every page; startup never marking itself started after a failed first window; a temp file name two processes could share; a close error hiding a write error; no test through the real writer; a redundant gate |
| Gate, smoke and e2e, headless | The branch | Typecheck, unit, the 12 guards and smoke pass; e2e passes, the files on ports the unrelated local server holds run as port-swapped copies |

### `stream/security-audit-fixes`: fixes for a whole-repository security review (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| Security review in five areas (loader, shell, transport, verifier, policy) by reviewer agents, with unit proofs of concept and runtime probes kept outside the repository | `main` at `82d2d3d` | About forty findings. Two high: a granted origin's live network document was served its grants in whatever session a link had left it in, and a picked folder holding the browser's data let a page read other apps' storage and plant grants. Eight medium, the rest low or informational. All fixed in this branch except what `A299`-`A301` hold and the aggregate cache cap `ADR-0012` decided against |
| Conductor review of each fix branch before merge | The fix branches | Caught a CCIP fix that went around a configured proxy, a verifier budget one page could hold for every site, a magnet grammar that refused BitTorrent v2 links, a loader check that missed apps at version 0.0.0, and finding IDs in comments; all fixed |
| `/code-review`, high effort, forked reviewer | The branch against `main` | 10 findings, all fixed: the session check, applied per call, stranded open pages after a grant or revoke and raced a reload after `app.requestGrant` (now decided when a document commits); a queued grant dialog could show after its caller timed out, and one answer was shared across tabs; the picker's protected folders were a startup snapshot and missed `/proc`, `/sys` and `/dev`; IPNS floors could roll back across a host restart and were not flushed at quit; a missing pin at version 0.0.0 read as a first visit; the data-root migration ran on every call; the proxy cache and a verifier buffer reservation had no bound |
| Gate, smoke and e2e, headless | The branch | Typecheck, 8399 unit tests, the 12 guards and smoke pass; e2e 66 files pass and the four opt-in files skip. `e2e-freetube-real`, run by hand with the ports checkout, fails identically on `main` (the watch page's metadata fetch fails upstream) |

### `stream/ext-sessions`: granted apps in the default session, and the `window.orivon` filter (2026-09-29)

| Mechanism | Scope | Outcome |
|---|---|---|
| `/code-review`, high effort | The branch against `stream/extensions` | Ten findings, all fixed or stated: the filter calling built-ins a page could patch, the routed `fetch`/XHR/WebSocket giving extension code an app's `net` grant, a fallback exposing `window.orivon` unfiltered, a site's popup keeping its opener into a granted app, orphaned app partitions, a listener with no filter on every request, the developer-tools prompt; bound methods planted in page-called slots are stated in ADR-0045 |
| `security-review` skill | The same diff | One MEDIUM, fixed: a same-origin `<object>` document got no granted-app CSP (webRequest reports it as `object`), reopening the inline-script route; `object-src 'none'` added. Service-worker-served documents getting no Orivon CSP is stated in T22, T52 and ADR-0045 |
| Gate, smoke and e2e, headless | The branch | Typecheck, unit, the 12 guards and smoke pass; e2e passes except the three port-collision files and `e2e-freetube-live-origin`, whose live-network playback check also fails on `main` |
| Two review agents in parallel (session change, `window.orivon` filter), each finding verified before a fix | This branch against `stream/extensions` | The filter credited a call to the page by its eval origin, which a `//# sourceURL=` comment forges at any eval depth: extension code run from a timer passed with the app's grants. Attribution now reads a real script's URL only; the reviewer's own one-line fix was shown bypassable first. Also: a cache-served app's network document got no CSP in the default session (A296 files the wider question), the one-time partition cleanup could clear installed apps' data when the pin listing failed, and developer tools and a popup's opener survived a move between two granted apps. All fixed with tests |
| Headless e2e | `test/e2e-extensions-orivon-filter.test.ts`, with both forged-sourceURL shapes and a `CallSite`-patching extension added | Pass. V8 refuses to replace `CallSite` methods from the main world at all |
