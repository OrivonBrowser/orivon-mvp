# `spike/` — historical evidence, not live code

**Do not import from this directory. Do not modernise it. Do not fix its lint.**

**What lives here.** Seven self-contained Electron applications, one per gate of the week-0
spike, plus the fixtures they ran against. They are the evidence behind
[`docs/planning/spike-verdict.md`](../docs/planning/spike-verdict.md), and they must stay
exactly as they were when the measurements were taken on 2026-08-25.

**What it depends on.** Its own vendored trees. `spike/app/node_modules/` is deliberately
isolated and git-ignored: `webtorrent` is an **app asset**, never a shell dependency, and
letting it into the root `package.json` would break Rule 8.

**Why it is kept.** A verdict without its apparatus is an assertion. If a later result
contradicts the spike, someone needs to be able to re-run the exact code that produced the
original number.

| Gate | Question | Result |
|---|---|---|
| 0 | Does `MessagePortMain` carry bytes renderer -> main at all? | **PASS** — 1134.8 MB/s up, 313.4 MB/s down. Found that transferable `ArrayBuffer`s renderer -> main silently never arrive |
| 1a | Does a renderer bundle fetch an *ordinary* (non-WebRTC) torrent? | **PASS** — and protocol encryption works, reversing an earlier claim |
| 1b | Does a DHT lookup complete over shimmed `dgram`? | **PASS** — found the `net.isIP` trap |
| 2 | Is the shell tree free of native modules? | **PASS** |
| 3 | Does video actually play? | **BLOCKED** — the app works; Playwright cannot attach |
| 4 | Throughput | 52 MB/s shimmed. Fails the literal relative-to-control threshold, **beats the product requirement 10x** |

Read the verdict, not the gate code, for current status. Note that
[`week-0-spike-plan.md`](../docs/planning/week-0-spike-plan.md) is superseded.
