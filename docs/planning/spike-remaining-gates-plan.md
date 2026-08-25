# Week-0 spike — plan for the remaining gates

> **Execution plan.** Gates 0, 1a and 1b are done and passed. This covers gate 2, gate 3,
> gate 4 and the write-up. Steps use checkbox (`- [ ]`) syntax.
>
> **Companion documents:** [`week-0-spike-plan.md`](week-0-spike-plan.md) (original plan and
> the known-good renderer recipe) · [`build-plan.md`](build-plan.md) §Week 0 (gate criteria).

**Goal:** finish the week-0 spike and produce a verdict the owner can act on.

**Branch:** `spike/week-0`. Everything below is throwaway code except where marked KEEP.

---

## Where things stand

| Gate | Verdict | Evidence |
|---|---|---|
| 0 — `MessagePortMain` fidelity | **PASS** | 1134.8 MB/s up, 313.4 MB/s down, byte-exact both ways |
| 1a — ordinary TCP peer | **PASS** | wire type `tcpOutgoing`, piece verified in 505 ms |
| 1b — DHT over shimmed `dgram` | **PASS** | peer found in 11 ms, 2 sends / 2 receives of real KRPC |
| 2 — no native modules | **Mostly pre-answered**, see Task A |
| 3 — video plays with seeking | Not started |
| 4 — throughput | Not started |

**The spike's headline question is already answered: yes.** A renderer bundle fetches ordinary
non-WebRTC torrents over a shimmed `net`/`dgram`, with protocol encryption available. Gates 2–4
now determine *how well*, not *whether*, so a failure from here is a tuning problem or a
scoped limitation — not the `utilityProcess` fallback.

---

## Global rules — every task inherits these

1. **Launch Electron ONLY through `spike/launch.mjs`.** This machine has
   `ELECTRON_RUN_AS_NODE=1` in the ambient environment, which turns the Electron binary into
   plain Node — no windows, no `require('electron')`, no `MessagePortMain`. The helper strips
   it and asserts `MessageChannelMain` exists before any result is recorded.
2. **Never pipe a gate run to `head`/`tail`.** Output gets lost and the run looks silent.
   Redirect to a log file, then read the file.
   ```bash
   LOG=/tmp/claude-1000/.../scratchpad/gateN.log
   timeout 240 env SPIKE_TIMESTAMP="$(date -Is)" xvfb-run -a node spike/gateN/run.mjs > "$LOG" 2>&1
   ```
3. **`xvfb-run -a`** so windows do not appear on the owner's desktop.
4. **Every gate writes `spike/results/gate-N.json`** and copies it to
   `docs/planning/spike-results/` — `spike/results/` is gitignored, the docs copy is the
   durable evidence.
5. **Pure-JS dependencies only** (Rule 8). After any `npm install`, run
   `npm run check:natives` for the shell tree, and for the app tree:
   ```bash
   node -e 'import("./scripts/check-no-native-modules.mjs").then(m=>console.log(m.checkNoNativeModules("./spike/app").offenders.length))'
   ```
   The shell tree must stay at **0**. The app tree sits at **8** and that is expected and fine —
   webtorrent is an app asset, never a shell dependency.
6. **New polyfills go in `spike/app/`**, never in the root `package.json`.
7. **Assertions must be able to fail.** A check that only exercises the working path proves
   nothing. This error was made twice already — once on a security control, once on gate 1a's
   encryption test, where only `secure: 2` (no plaintext fallback) actually proved anything.

### The known-good renderer recipe

Copy `spike/gate1a/vite.config.js`. Full alias list, all load-bearing:

| Alias | Reason |
|---|---|
| `net` → `shim/net.js` | `torrent.js:2104` refuses all TCP unless `typeof net.connect === 'function'` |
| `dgram` → `shim/dgram.js` | gate 1b only |
| `crypto` → `crypto-browserify` | MSE and DHT node IDs |
| `stream`, `string_decoder` | `crypto-browserify`'s Hash extends `stream.Transform` |
| `path` → `path-browserify` | genuinely called at runtime |
| `events`, `buffer`, `process`, `util` | named imports from Vite's empty stub are build errors |
| `./mse.js` | stub, or the real file when `ORIVON_MSE=1` |
| `bittorrent-dht` | stub for 1a, real package for 1b |
| `webtorrent`, `streamx` → `spike/app/node_modules/...` | app tree, not shell tree |

Plus, all mandatory: `base: './'`; `shim/globals.js` imported **first**; a `package.json` in
each gate directory.

### Traps already paid for — do not rediscover

- **A shim must export the whole surface consumers touch, not the obvious entry points.**
  `net.isIP` was missing and the DHT silently sent nothing.
- **Polyfilling `process.nextTick` with `queueMicrotask` changes error visibility.** Node's
  `nextTick` surfaces an uncaught exception; the polyfill swallowed it, so a `TypeError`
  became "no output at all". If something fails silently, suspect this first.
- **Rollup gives two browser-externalized modules the same generated identifier.** A missing
  `path` polyfill reported itself as `ConnPool.join is not a function`. When an error names a
  module that makes no sense, **read the built bundle**.
- **`MessagePortMain` fails by silence** — a dropped message never arrives and never errors,
  so any reply-carrying protocol needs a timeout.
- **Always run a no-shim control before blaming the shim.** The gate 1b fixture was broken,
  not the shim, and only a plain-Node control revealed it.

---

## Task A — GATE 2: the shell tree requires no compiler

Largely answered already; this closes it and records the evidence.

**Files:** create `spike/results/gate-2.json` · Modify: nothing

- [ ] **Step 1: Record what is already known**

Facts established, to be restated in the result file with their evidence:
- Shell tree: `npm run check:natives` passes. Three packages ship prebuilt binaries
  (`@electron-internal/extract-zip`, `@rollup`, `@swc`); none needs a compiler.
- App tree: 8 offenders, including `node-datachannel`, whose install script is
  `prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)`
  — it **falls back to compiling with CMake**, which is exactly the Rule 8 threat.
- The gate-1a renderer bundle contains **zero** `node-datachannel` references, because
  `webrtc-polyfill` keeps browser resolution and Chromium's native WebRTC is used instead.

- [ ] **Step 2: Run the optional-dependency comparison**

npm installs optional dependencies by default, so a contributor's plain `npm install` may pull
artefacts an `--omit=optional` audit skips. Compare both on the **shell** tree:

```bash
cd /home/jhon/Desktop/Develop/Claude/orivon-mvp
cp package-lock.json /tmp/lock-backup.json
rm -rf node_modules && npm install --omit=optional && npm run check:natives
rm -rf node_modules && npm install && npm run check:natives
cp /tmp/lock-backup.json package-lock.json
```

Record both outputs. If they differ, say so explicitly — the `postinstall` guard is what
protects run-from-source either way.

- [ ] **Step 3: Verify the guard still catches a hostile tree**

```bash
node -e 'import("./scripts/check-no-native-modules.mjs").then(m=>{const r=m.checkNoNativeModules("./spike/app");console.log(r.ok, r.offenders.length)})'
```
Expected: `false 8`. **If this prints `true`, the guard has regressed** and Gate 2's pass is
meaningless — stop and fix it.

- [ ] **Step 4: Write `spike/results/gate-2.json`, copy to `docs/planning/spike-results/`, commit**

**PASS** = shell tree clean on both install modes, guard still catches the app tree, and the
built renderer bundle has no `node-datachannel` reference.

---

## Task B — GATE 3: MP4/H.264 plays, with seeking

**Files:** create `spike/gate3/` (from `spike/gate1a/`), `spike/fixtures/make-video.mjs`

- [ ] **Step 1: Generate a deterministic H.264 fixture**

ffmpeg 6.1.1 is present, so no download and no swarm dependency. A visible frame counter makes
seek correctness checkable rather than a matter of opinion.

```bash
ffmpeg -y -f lavfi -i testsrc=size=640x480:rate=25:duration=60 \
  -f lavfi -i sine=frequency=440:duration=60 \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 25 \
  -c:a aac -movflags +faststart \
  /tmp/orivon-fixture.mp4
ffprobe -v error -show_entries stream=codec_name,width,height -of default=nk=1:nw=1 /tmp/orivon-fixture.mp4
```

`+faststart` matters: it moves the `moov` atom to the front so playback can begin before the
whole file arrives. Without it, progressive playback of a torrent will not start.

- [ ] **Step 2: Seed it**

Extend `spike/fixtures/seeder.mjs` to accept a file path instead of generating random bytes
(keep the random-bytes mode for gate 4). Same config: `dht:false, tracker:false, lsd:false,
utp:false`.

- [ ] **Step 3: Try the service-worker path first**

Use the `force` parameter — newly confirmed and in no other project document. Without it
webtorrent may select the Node implementation and try to open a real listening socket:

```js
const controller = await navigator.serviceWorker.register('./sw.min.js', { scope: './' })
await navigator.serviceWorker.ready
client.createServer({ controller }, 'browser')
const file = torrent.files.find(f => f.name.endsWith('.mp4'))
file.streamTo(document.querySelector('video'))
```

`sw.min.js` ships in `spike/app/node_modules/webtorrent/sw.min.js` — copy it next to the
built page. Service workers need a secure context; `file://` is **not** one, so if
registration fails, go to step 4 rather than fighting it.

- [ ] **Step 4: Fall back to `protocol.handle` if service workers do not register**

Register the scheme **before** `app.whenReady()`:

```js
protocol.registerSchemesAsPrivileged([{
  scheme: 'orivon-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}])
```
The handler **must** honour `Range` and return `206` with a correct `Content-Range`, or
Chromium will not seek. This path is also what `build-plan.md` §5 chooses for the product, so
a working implementation here is directly reusable.

- [ ] **Step 5: Measure and record**

**PASS** = the file plays end to end **and** seeking to 75% starts playback there within 5 s
without restarting the download from zero.

Record: time-to-first-frame (the clip depends on it — a 40-second wait is a different product
from a 4-second one), whether seeking triggered a fresh piece request near the seek target,
and which path was used (service worker or custom scheme).

Assert seek correctness from the **rendered frame counter**, not merely from
`video.currentTime` — `currentTime` can be set without any decoding happening.

- [ ] **Step 6: Copy the result to `docs/planning/spike-results/` and commit**

---

## Task C — GATE 4: throughput against a native control

**Files:** create `spike/gate4/`, `spike/fixtures/control.mjs`

- [ ] **Step 1: Measure the control**

Same webtorrent version, same fixture, same local seeder, running **natively in Node** with no
shim. Without this number, "25 Mbps" measures the disk and the machine, not the shim.

```bash
node spike/fixtures/seeder.mjs 512 /tmp/seed.json &
node spike/fixtures/control.mjs /tmp/seed.json   # -> { mbps, peakRssMb, durationSec }
```

- [ ] **Step 2: Measure the shimmed path**

Identical fixture, through the renderer, **through the `contextBridge` closures** — not a raw
port. `capability-api.md` is explicit that measuring the raw port measures a path the product
cannot ship.

- [ ] **Step 3: Record every sub-criterion separately**

CPU-bound, latency-bound and architecturally-impossible have different fallbacks, so a single
pass/fail is not enough.

| Sub-criterion | Pass |
|---|---|
| Relative throughput | shimmed ≥ 60% of control |
| Absolute throughput | ≥ 25 Mbps |
| Concurrent sockets | ≥ 100 |
| Main-process CPU | headroom intact, no renderer frame drops |
| Memory | RSS stable across 10 minutes |

- [ ] **Step 4: If it underperforms, batch — do NOT reach for transferables**

64–256 KB batching is the only day-2 lever. **Transferable `ArrayBuffer`s are unavailable**
(gate 0: silently dropped renderer → main). If a run seems to improve with transferables,
that is a measurement error — they do not arrive.

Given gate 0 measured 313–1134 MB/s against a 1–5 MB/s requirement, expect a comfortable pass.
If it fails anyway, the bottleneck is **not** the IPC boundary — say so explicitly and record
which sub-criterion failed.

- [ ] **Step 5: Copy the result and commit**

---

## Task D — the two legs that need the owner's network

**Cannot be run from the spike environment.** Verified: outbound UDP works (a DNS query to
8.8.8.8 answers) but `router.bittorrent.com:6881` never replies, so the public DHT is
unreachable here.

- [ ] **D1. Public DHT bootstrap.** Re-run gate 1b with the real bootstrap list instead of the
  local node. **PASS = `peer` events for a well-known infohash within 60 s.** A failure may be
  NAT rather than the shim, so re-run from a second network before concluding.
- [ ] **D2. Public swarm re-test of gate 1a.** With D1 working, add a well-seeded public MP4
  torrent and confirm pieces verify from **non-WebRTC** peers — real clients negotiating real
  extensions, which a local seeder cannot fully exercise. Record the wire types.

Both are realism checks. **Neither can overturn gates 1a or 1b**, which are already proven
against controls; they can only reveal additional real-world friction.

---

## Task E — the write-up (KEEP: all of it)

- [ ] **E1. Write `docs/planning/spike-verdict.md`** — PASS/FAIL per gate with the recorded
  numbers and a link to each `docs/planning/spike-results/*.json`. State plainly which gate, if
  any, stopped it, and what the owner should do next.

- [ ] **E2. Fold every correction back into the specs.** These are known now and MUST land:

| Correction | Where |
|---|---|
| webtorrent is **3.0.21**, not 2.x | `build-plan.md`, `CLAUDE.md` (done) |
| Transferable `ArrayBuffer`s are unavailable renderer → main | `capability-api.md` §Throughput (done) |
| MSE **works** via `crypto-browserify`; ship `secure: 1` | `build-plan.md` (done) |
| `createServer(opts, force)` takes `'browser' \| 'node'` | `build-plan.md` §5 |
| **A shim must export the full module surface** (`net.isIP`) | `capability-api.md`, and it belongs in the **A10 handle contract** |
| **`process.nextTick` polyfill changes error visibility** | the project skill, and A10's error taxonomy |
| The renderer needs 9 polyfill aliases | the project skill |

- [ ] **E3. Write the project skill** at `.claude/skills/orivon-electron/SKILL.md`.
  `CLAUDE.md` requires this and the knowledge exists nowhere else: the alias recipe, the
  `ELECTRON_RUN_AS_NODE` trap, `MessagePortMain` transfer behaviour, the custom-scheme media
  path, and the silent-failure patterns above.

- [ ] **E4. Write the A10 handle contracts** into `capability-api.md`. Direction is already
  decided (WHATWG streams underneath, Node shapes presented by the shim). Gate 0 has now
  settled the transferable question that was blocking it. **This is the highest-value
  remaining artefact and it deserves the strongest model available** — it outlives Electron
  and every Orivon app codes against it. Must cover: read/write shape, backpressure,
  half-close and close, a closed error enum, and the rule that revoking a grant closes every
  handle derived from it.

- [ ] **E5. Delete the throwaway code.**
  ```bash
  git rm -r spike/
  ```
  Move `spike/results/` to `docs/planning/spike-results/` first — the numbers are the evidence
  and they outlive the code that produced them.

- [ ] **E6. Append to `devlog/journal.md`** under **Done / results**, and run
  `/revise-claude-md` since the phase changes from "spike" to "build step 1".

---

## Suggested order

`A` (cheap, mostly done) → `B` (the clip depends on it) → `C` (expected pass) →
`E1`–`E3` (write-up) → `E4` (A10 contracts, strongest model) → `E5` → `D` when the owner
is on a normal network.

**A, B and C are mechanical** — established recipe, clear pass criteria, delegate freely.
**E4 is not**, and neither is any gate failure: a failing gate is a diagnosis problem, and
today's three hardest bugs all presented as something other than what they were.
