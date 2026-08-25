# Week-0 spike — verdict

**Date:** 2026-08-25 · **Branch:** `spike/week-0` · **Executed by:** Opus (design, gates 0/1a/1b) then Sonnet (gates 2–4, this write-up), per an owner-directed model split.

**Recommendation: PROCEED. The architecture is sound.** The question the spike existed to
answer — can `webtorrent` run inside a sandboxed Electron renderer over a shimmed
`net`/`dgram`, fetching ordinary non-WebRTC torrents, with no native modules in the shell tree
— is answered **yes**, with hard evidence at every step. One gate (video playback) is blocked
on a tooling issue, not a product one, and is handed back for a fresh diagnostic pass rather
than guessed at further. One gate (throughput) technically fails its literal pass criterion
while beating the actual product requirement by an order of magnitude — read past the verdict
field on that one.

## Results

| Gate | Question | Verdict | Evidence |
|---|---|---|---|
| 0 | Does `MessagePortMain` carry bytes intact, and how fast? | **PASS** | 1134.8 MB/s renderer→main, 313.4 MB/s main→renderer, byte-exact both directions |
| 1a | Does a renderer bundle fetch an *ordinary* (non-WebRTC) torrent? | **PASS** | Wire type `tcpOutgoing`, piece verified in 505 ms (480 ms with encryption on, see below) |
| 1b | Does a DHT lookup complete over shimmed `dgram`? | **PASS** | Peer found in 11 ms; 2 sends / 2 receives of real bencoded KRPC traffic |
| 2 | Is the shell tree free of native modules? | **PASS** | 0 offenders on both plain and `--omit=optional` installs; new finding below |
| 3 | Does MP4/H.264 play with seeking? | **BLOCKED** | App confirmed working; Playwright can't attach to its window. See below |
| 4 | Is throughput adequate against a native control? | **FAIL** (literal) / effectively **PASS** (product requirement) | 52 MB/s shimmed vs 1–5 MB/s actual need — 10.5x headroom. See below |

Full data for every gate: [`spike-results/gate-0.json`](spike-results/gate-0.json) ·
[`gate-1a.json`](spike-results/gate-1a.json) · [`gate-1b.json`](spike-results/gate-1b.json) ·
[`gate-2.json`](spike-results/gate-2.json) · [`gate-3.json`](spike-results/gate-3.json)
(+ [`gate-3-sw-probe.json`](spike-results/gate-3-sw-probe.json)) ·
[`gate-4.json`](spike-results/gate-4.json).

## The headline finding

**A naive renderer bundle is WebRTC-only — Brave parity, and exactly what `ADR-0001` reason 3
exists to beat. This is not that.** Gate 1a's wire connected as `tcpOutgoing` to a seeder
configured with `dht:false, tracker:false, lsd:false, utp:false` — no signalling channel of
any kind existed, so a WebRTC peer was structurally impossible. Gate 1b proved the same for
message-oriented DHT traffic over `dgram`. Together they prove the shim carries genuine
BitTorrent protocol traffic, both stream-oriented and datagram-oriented, not just bytes on a
pipe.

**Protocol encryption works, and should ship on.** The original plan assumed MSE (BitTorrent
protocol encryption) couldn't run in a renderer — WebCrypto doesn't usefully provide
Diffie-Hellman or a synchronous SHA-1. That assumption was wrong, and the owner was right to
challenge it: `mse.js` already ships a complete pure-JS RC4 fallback, and `crypto-browserify`
supplies the rest. A full encrypted handshake was verified at `secure: 2` (RC4 required, no
plaintext fallback) — a piece verified in 480 ms against a Node seeder using native crypto.
**Recommendation: ship `secure: 1`** (encrypt when possible, fall back to plaintext) for
maximum swarm reach. One honesty note for the UI: MSE is obfuscation against traffic shaping,
not privacy against eavesdroppers — it must never be presented as making torrenting private.

**Transferable `ArrayBuffer`s are unavailable, and it doesn't matter.**
[electron#34905](https://github.com/electron/electron/issues/34905) reproduces, and is worse
than reported: a transferable sent renderer→main doesn't throw or corrupt, it **never
arrives**, silently. The build plan's "day 2 with transferables" throughput rescue does not
exist. It's moot — structured clone alone measured 313–1134 MB/s, 60–200x past the 1–5 MB/s
1080p requirement.

## Gate 2 — a new, real finding

`npm install --omit=optional` **breaks the build entirely** — Rollup's platform-specific
native binary is an optional dependency the build actually requires, and skipping it crashes
with `MODULE_NOT_FOUND`. `check:natives` passes either way, since a missing prebuilt binary
isn't a Rule 8 violation — so the guard alone wouldn't have caught a broken build.
**Contributors and CI must use a plain `npm install`.**

The app tree's expected 8 offenders (`node-datachannel` chief among them) are confirmed
non-optional — its install script falls back to compiling with CMake when no prebuild matches
— which is exactly why webtorrent ships as a pre-built app asset rather than a shell
dependency. The built bundle contains zero `node-datachannel` references, confirming that
isolation holds where it matters.

## Gate 3 — blocked, not failed

**The app works.** A direct, non-Playwright launch of gate 3's exact build loads completely
normally: `dom-ready` and `did-finish-load` both fire immediately, and Electron's renderer
console warning appears exactly as it does for every other gate. **Playwright cannot attach to
its window** — `firstWindow()` times out after 30s even though Playwright's own CDP session to
the main process is fully healthy (confirmed via `DEBUG=pw:electron,pw:browser`: the
browser-level DevTools connection succeeds cleanly, but no target-created event for the window
is ever logged).

Six isolation tests ruled out: the new `protocol.registerSchemesAsPrivileged()` call, real
`mse.js`/`crypto-browserify` vs. the stub, a stray Electron process holding a single-instance
lock, system resource starvation, and a silent preload crash. What's *not* yet tested: the
`<video>` element itself (the one thing genuinely unique to this gate), and whether a raw CDP
client can see the window that Playwright's own target auto-attach is missing — which would
isolate Electron/Chromium's CDP reporting from Playwright's client library specifically.

Full evidence and the six-test trail: [`gate-3.json`](spike-results/gate-3.json). Two things
were confirmed and are worth keeping regardless of how this resolves: Electron treats a
`file://` origin loaded via `loadFile()` as a secure context (service workers register without
any fallback needed), and the seeder now supports throttled upload rates
(`ORIVON_UPLOAD_LIMIT`), verified accurate to within 20ms of prediction — both needed for
gate 3's eventual seek-latency assertion once it can run at all.

**This does not call the architecture into question.** Gates 0, 1a, 1b and 4 all launch
through the identical `spike/launch.mjs` → Playwright path and attach fine; a standalone probe
confirmed gate 4 attaches correctly before its full run was built. Whatever is different about
gate 3 is narrow and tooling-specific, not architectural.

## Gate 4 — read past the verdict field

The literal result is FAIL: shimmed throughput (52 MB/s) is 28% of the native control
(190 MB/s), below the 60% relative threshold. **This is not concerning, for a specific,
evidenced reason.** The control is same-process, zero-IPC, effectively RAM-speed — an
extremely high bar. Gate 0 already measured the raw `MessagePortMain` path at
313–1134 MB/s, which rules out the IPC boundary as this gate's bottleneck; the gap is most
likely webtorrent's own per-piece SHA-1 verification competing with data traffic on the
renderer's single JS thread, not proven further here since that would be scope creep for a
spike gate.

**Against the number that actually matters** — 1–5 MB/s for 1080p streaming, the figure gate 0
and `capability-api.md` cite — 52 MB/s is **10.5x the top of that range**. Absolute throughput
(418 Mbps vs. a 25 Mbps threshold) and concurrent-socket handling (100/100 succeeded in 32 ms)
both pass cleanly.

## What should happen next

1. **Proceed to build step 1** (the shell) — the architecture question is answered.
2. **Gate 3 needs a fresh diagnostic pass**, starting from CDP target auto-attach rather than
   the application layer — a raw CDP client against the same `--remote-debugging-port` is the
   next concrete step, per the trail in `gate-3.json`. Not urgent for the architecture
   verdict, but real video playback needs proving before the clip is shot.
3. **A10 (handle contracts)** can now be written without qualification — gate 0 resolved the
   transferable-`ArrayBuffer` question A10 was blocked on. Reserved for a dedicated pass, not
   done in this session by design.
4. **Fold the corrections below into the specs** if not already done (tracked in
   `week-0-spike-plan.md` and this document as the source of truth for what changed).
