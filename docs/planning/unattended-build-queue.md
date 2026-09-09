# Unattended build queue

**What this is.** An ordered work queue for an unattended (fleet/loop) run, with an exit
criterion per item, the owner checkpoints, and the conditions under which the run must stop.
Written 2026-09-09, from one decision session plus one reconnaissance task.

**Read these two first.** [`compatibility-matrix.md`](compatibility-matrix.md) -- this document
plans the closing of rows in its Tables 1 and 3 and uses its vocabulary throughout.
[`freetube-port-recon.md`](freetube-port-recon.md) -- queue item 0.1, already done, and it
changed two items below.

**How the run behaves is separate from what it builds:**
[`../development/unattended-run-protocol.md`](../development/unattended-run-protocol.md) carries
decisions 12 and 13 -- questions never halt the run, and a usage limit pauses it rather than
ending it.

---

## The thirteen owner decisions this rests on

All taken 2026-09-09, all **owner decisions**, not AI recommendations. Items 1-4 change the
permanent interface and therefore merge as one PR before any implementation.

| # | Decision | Consequence |
|---|---|---|
| 1 | **`orivon.fs` stays byte-oriented** -- no encoding option at the capability layer | Confirms the provisional reading already in the tree. Text decoding belongs to the shim. Closes **A12** |
| 2 | **Synchronous file reads are supported**, via the runtime's synchronous renderer-to-main channel | The page blocks for the read -- correct for startup config. Amends `capability-api.md` design rule 2, so it is a contracts change. The background-thread mechanism stays available later **with no app-visible difference**. Closes **A94** |
| 3 | **The `electron` module gets its own compatibility package** | Buildable in parallel; the shim's declared scope stays as written. Closes **A95** |
| 4 | **Orivon terminates TLS on the app's behalf** -- handshake and certificate/hostname verification in the trusted side, using the encryption stack already in the shipped runtime | One new capability. No new dependency, so Rule 8 is unaffected. The trusted side knows the real host, so a grant can name it |
| 5 | **`net.listen` is built in this round** | Already fully specified including the unsigned-app rules. Largest single item here. Lets the flagship seed, not only download |
| 6 | **The page's own `fetch()` is routed through the capability** for granted hosts | Recon proved this is not an optimisation: FreeTube's entire network layer is `fetch`, so without routing it does not function at all |
| 7 | **An app may set any request header on a granted host**, including ones a page is normally forbidden to set | Required by real apps -- FreeTube's main process sets `Origin: https://www.youtube.com` today. Safe because these connections carry no cookies or sessions of their own: nothing can ride the user's existing logins, the app must supply everything itself |
| 8 | **Network permission is declared in the manifest and granted once at install. No just-in-time prompting.** A manifest may declare unlimited HTTPS | An app that does not know Orivon exists cannot wait for a decision mid-request -- it fires parallel requests with its own timeouts and retries. A host outside the declaration is denied, as today, with no prompt. **The prompt must make breadth visible**: a narrow declaration must not look like an unlimited one, or every manifest will declare unlimited |
| 9 | **A grant lasts until the user revokes it**, and is visible in a list they can revoke from | Keeps prompts rare enough to still be read |
| 10 | **The run builds the platform only.** FreeTube and `webtorrent` are test subjects proving the broker and shim are built right, not porting projects | Porting is per-app work that shifts upstream continuously, and it is what quietly consumes an unattended run |
| 11 | **The permission prompt is in scope**, with the owner giving feedback during its development rather than reviewing it at the end | This is what lets the run reach something a person can actually use. It is why Phase 4 exists |
| 12 | **A parked question never halts the run.** An agent needing an owner decision registers it and moves immediately to work that does not depend on the answer; parked questions are asked in one batch when the owner returns | The failure being prevented: the owner sleeps and the run idles for ten hours on an unanswered question. Full mechanism, and the map of what stays workable when each known question is parked, in [`../development/unattended-run-protocol.md`](../development/unattended-run-protocol.md) |
| 13 | **A usage limit pauses the run, it never ends it.** Burn rate is throttled by capping concurrency; when a limit does arrive, the run writes its resume point and schedules its own resumption, chaining timers until work is possible again | No tool reports a live percentage of the account limit, so the rule is delivered by throttling and automatic recovery rather than by polling a gauge. A real 90% ceiling applies the moment the owner supplies a number (`/orivon-tell conductor budget: N`) |

Decisions 2, 4, 6 and 7 are architectural. **They need ADRs authored through the sanctioned path
with owner attribution** -- an agent may not author one (`CLAUDE.md` Rule 1). Proposed as two:
one for synchronous file reads, one for "Orivon owns the app's HTTP(S) path", the second covering
routing, TLS termination and app-chosen headers together.

---

## Why the order is what it is

Everything privileged answers `'denied'` until a grant exists in production. Phase 4 fixes that
properly, but it lands late, so **item 0.3 -- a developer-only grant path -- is load-bearing for
every phase before it.** Without it, Phases 2 and 3 verify against stubs and an unattended run
reports "tested" for work no real socket has touched. It must be impossible in a packaged build,
and that is a review gate rather than a comment.

## Phase 0 -- groundwork

| # | Item | Exit criterion |
|---|---|---|
| 0.1 | ~~FreeTube network reconnaissance~~ | **Done** -- [`freetube-port-recon.md`](freetube-port-recon.md). Findings folded into 3.1, 3.4 and Phase 5 |
| 0.2 | Record decisions 1-11 in `docs/open-questions.md` (resolutions for A12/A94/A95, new entries for the rest) and amend `build-plan.md` for decisions 5 and 11 | Each entry dated, owner-attributed, stating what it closes |
| 0.3 | **Developer-only grant path**, gated so it cannot exist in a packaged build, with a CI check proving its absence | The e2e suite grants without the broker's test-only API. CI fails if the path is reachable once packaged |
| 0.4 | Per-app `session` partitions wired -- build step 2's last unbuilt deliverable | Tabs open in the app's own partition; a test proves two origins share no storage |
| 0.5 | ADR-0007 probe: does `onHeadersReceived` fire for the `protocol.handle`-served cached bundle | A recorded answer, checked live rather than reasoned |

## Phase 1 -- the contracts PR (one PR, merges first, no implementation)

| Item | Exit criterion |
|---|---|
| Full byte-oriented signatures for the six provisional `fs` entry points | No PROVISIONAL markers left |
| The synchronous read entry point, plus the design-rule-2 amendment | The rule states where sync is permitted, and why `net` stays async |
| The secure-connection capability | Expressible in a grant pattern; the raw path unchanged |
| Whatever surface `fetch` routing and app-chosen headers need | May be no contract change at all -- confirm, do not assume |

**Phase exit:** `check:contracts` and `typecheck` green, and no implementation in the diff.
`net.listen` needs no contracts change; it is already specified.

## Phase 2 -- broker capabilities (parallel branches, one PR each)

| # | Item | Exit criterion |
|---|---|---|
| 2.1 | Extended `fs`: `open`/`mkdir`/`readdir`/`stat`/`rm`/`rename`, broker and page surface | Unit tests plus a real-filesystem e2e; app-directory confinement proven per call |
| 2.2 | The synchronous read path (preload sync channel, main handler) | A real page reads a file synchronously under a grant, and is refused without one |
| 2.3 | Secure connect, TLS terminated in the trusted side | A real handshake against a local server with a real certificate; a wrong hostname is refused |
| 2.4 | **`net.listen`**, accepted-socket handles, teardown and revocation cascade | A real inbound connection is accepted under a grant, refused without one, and revocation tears down the server and every accepted socket |
| 2.5 | `orivon.id.*` entry point, wiring the existing derivation to broker and page | Signing works under a grant; `window.nostr` reachable from a page |

2.4 is the largest item in the queue and should start first.

## Phase 3 -- compatibility layers (parallel branches)

| # | Item | Exit criterion |
|---|---|---|
| 3.1 | Core polyfills. **The matrix's six are a floor, not a set** -- recon found `zlib` and `util` needed as well, so this item is driven by the real dependency trees of the Phase 5 targets | A real third-party module importing them initialises. Mature pure-JS packages preferred (Rule 6); every addition passes `check:natives` (Rule 8) |
| 3.2 | Node `net` (client **and** server), `dgram`, `fs` (async and sync) | `bittorrent-dht` or equivalent runs unmodified against them |
| 3.3 | HTTP and HTTPS client over the secure capability | A real request to a real HTTPS host completes under a grant |
| 3.4 | `fetch` routing for granted hosts, **carrying app-chosen headers** (decisions 6 and 7) | An ordinary page's `fetch` reaches a granted host with an app-set `Origin`; an ungranted host is refused; no ambient credentials are ever attached |
| 3.5 | The `electron` package: app version and paths, the app's internal message bus, explicit named refusals for `BrowserWindow`/`Menu`/`Tray` | `import { app, ipcRenderer } from 'electron'` resolves and works; an unsupported API throws an error naming why |

**3.5's message bus needs no capability and no grant** -- both halves of the app are inside the
sandbox. Do not build broker plumbing for it.

## Phase 4 -- the consent surface (owner in the loop)

The phase that turns everything above into something a person can use. Each item has an owner
checkpoint: the run builds the mechanism and a deliberately plain, unstyled surface, then asks.

| # | Item | Exit criterion | Owner checkpoint |
|---|---|---|---|
| 4.1 | `app.requestGrant` and the first production caller of `broker.grant()` | An accepted decision becomes a real, persisted grant | none -- plumbing |
| 4.2 | The install prompt, rendering a real manifest, **with breadth visible** (decision 8) | A narrow declaration and an unlimited one are unmistakably different to look at | **yes** -- what it says, and how breadth reads |
| 4.3 | The folder picker behind `fs.userSelected` | A real chosen folder is reachable and nothing outside it is | **yes** -- when it appears, and what it says |
| 4.4 | The grant list, with revocation (decision 9) | Revoking from the list tears down live handles, proven by test | **yes** -- where it lives in the UI |
| 4.5 | `id.requestIdentity`'s prompt | An app receives an identity only after a person agreed | **yes** -- it is a different question from a capability |

## Phase 5 -- verification that means something

**Two lanes, because they exercise disjoint halves.** Verifying one leaves the other unproven.

| # | Item | Exit criterion |
|---|---|---|
| 5.1 | **Node lane -- `webtorrent`**: the flagship, over `net`/`dgram`/`fs` and `net.listen` | A real torrent fetches from a non-WebRTC TCP peer and a DHT lookup completes |
| 5.2 | **Web lane -- FreeTube**: its renderer unmodified, over routed `fetch` with app-set headers, its storage over `fs` or IndexedDB | A real video plays. Its external-player and proxy features are **documented losses**, not blockers |
| 5.3 | Full suite, comment budget, contracts purity, natives, size, from a clean checkout | All green |
| 5.4 | Matrix refresh: re-derive every cell of Tables 1-4 from the tree | Header date updated, and the note says which cells changed |
| 5.5 | Adversarial review over the whole landing, plus `/claude-security` | Findings fixed, or filed with numbers. Never silently dropped |

---

## Stop conditions -- wake the owner, do not proceed

1. **Any `src/contracts/` change beyond Phase 1's four agreed items.**
2. **Any new architectural decision.** If an item cannot be built without one, stop: an agent may
   not author an ADR.
3. **Any security tradeoff**, and explicitly: the dev grant path's gating, certificate handling and
   trust roots, and anything that would relax an existing boundary.
4. **Any new dependency** -- license, provenance and pure-JS status reviewed first (Rules 6 and 8).
5. **Three consecutive failed attempts at one item**, or a test that can only pass by weakening its
   assertion. Write the reasoning into the test; never bend it to the guess.
6. **An e2e that needs a real Electron window and cannot attach.** Known, unresolved risk with the
   `_electron` driver. It is a stop, not a workaround.
7. **Anything touching an excluded row** -- ambient filesystem, `subprocess`, `hid`/USB. Hard stop:
   these are refusals, not gaps.
8. **Phase 4's checkpoints.** Build the mechanism, then ask. Do not choose the wording alone.

**"Stop" here means stop that item, not stop the run** (decision 12). Every entry above is parked
with its question registered, and the lane moves to unblocked work in the same checkpoint. Only an
excluded row (7) is dropped rather than parked.

## Guardrails -- the known stalls, pre-empted

Each has already cost a session here. An unattended run hits them at 3am.

- Symlink `.codearbiter` into every worktree **before the first commit**, or the crypto gate
  refuses to run and the branch cannot land.
- Use `git -C <literal path>` with explicit file staging, or the commit hook reports a false
  "commit to main".
- Strip `ELECTRON_RUN_AS_NODE` for every launch; it is set in this machine's ambient shell and
  fails silently as a windowless Node run.
- Use `gh api` for PR labels and body edits; `gh pr edit` fails here on a Projects GraphQL error
  unrelated to content.
- Expect a fresh `main` merge before every sequential PR merge -- branch protection is `strict`.
- Symlink `node_modules` into each new worktree manually.
- Never hand-merge `package-lock.json`: take one side whole, `npm install`, commit the result.
- Do not let two e2e suites share fixture ports or the Electron binary; vitest runs files in
  parallel and a benign interleaving is luck, not a pass.

---

## What "done" looks like, honestly

**Table 1 completes.** All eleven live rows reachable from a real page, under a real grant a real
person gave, with the two excluded rows staying excluded. That is only true because decision 11
brought the prompt into scope; without it, three rows would stay open no matter how much code
landed.

**Table 3 reaches 8 of 12 green, plus one settled by refusal.** Three rows remain, and **none of
them is a coding task**:

| Row | Why the run cannot close it |
|---|---|
| `worker_threads` | Web Workers exist, but the shape does not match and a shim cannot fully fake it. A fidelity problem, not a substrate one |
| Background lifetime | Nothing in Node, `electron` or the web platform means "keep running once the tab is gone". Needs a decision, contracts, shell and UI. It touches the success metric directly and is still unfiled |
| Desktop shell -- tray, autostart, protocol handlers, hotkeys | Shell-side, and marked out of scope rather than covered |

Native addons in a dependency tree stay per-library, and ambient filesystem access stays excluded
by design.

**So the answer to the question that started this:** Table 1 yes, completely. Table 3 no -- and the
three rows left over are a decision, a boundary and a fidelity limit, which is why no amount of
unattended effort reaches them.
