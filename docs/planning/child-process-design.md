# `child_process` for ported apps: what it can safely mean, and how to build it

**Status: design exploration, 2026-09-28. Not a decision.** Written for the owner, who decides,
and for the agent that implements the chosen shape.

> **Outcome, 2026-09-28 (`ADR-0040`, `d-0159`).** The owner's goal turned out wider than this
> document's question: native modules loaded on the fly, and `child_process.spawn` and `fork`,
> each at the same broker allowance as any app, with no added risk. That rules out shape B for
> good in this build and settles A1 as the shape of `spawn`. It also changes one row below:
> `fork` is built as a Web Worker running the app's module over the Node shim and an `orivon.*`
> proxy, not refused. The WASI host this document leans on is built in `src/shim/wasi/`
> (`wasm-compatibility.md` step 1), and `child_process` in `src/shim/child-process/`, every child in a Web Worker (`d-0162`). Where this document
> says JSPI in a Worker is unmeasured, `wasm-compatibility.md` section 2 has since measured it
> working with no isolation. It reads the compatibility matrix's rows on
`subprocess`, `child_process` and WASI, says what each could become, and recommends one path. The
matrix ([`compatibility-matrix.md`](compatibility-matrix.md)) stays the source of truth for what
works; this file records the reasoning that page must not carry (CLAUDE.md Rule 2 exempts
`docs/planning/`).

**Read [`wasm-compatibility.md`](wasm-compatibility.md) with this.** Written the same day, it is
the brief for the WASI host over `orivon.*` (`src/shim/wasi/`, JSPI on the main thread, the
`node:wasi` shape, cross-origin isolation as a manifest field, sockets through WASI 0.2 later),
with every claim measured or cited. This document does not repeat that design. It answers the
narrower question the owner asked: what should a ported Node app's `require('child_process')`
do, and which of the four things people mean by "subprocess" can be built without loosening one
broker guard. The answer leans on that host: a child process is a WASI program the host runs.

**In one paragraph.** "Subprocess" is four different things wearing one word, and they differ in
the only two properties that matter here: whether the broker can bound what the spawned code
reaches, and whether the shape works on every platform. A program the app ships **compiled to
WebAssembly (WASI)** can run inside the app's own tab with every read, write and, later, socket
going through `orivon.*`, so every existing broker guard applies without one new line of policy
code, and it runs wherever Chromium runs, Android included. A **native binary** the app ships
cannot be bounded by the broker at all; it can be contained only by an OS sandbox, which exists as
a free-standing tool on Linux and macOS but not on Windows, so "safe" and "every platform" pull in
opposite directions and it should stay excluded. The recommendation is to build the first as the
meaning of `child_process` in `orivon-node-shim`, over the WASI host, keep the second as the
matrix's `subprocess` row (still excluded, with a sharper reason), and treat the two remaining
shapes (a program the person picks, and a container image) as separate, smaller questions.

---

## 1. What the matrix and the decisions already say

| Where | What it says today |
|---|---|
| Table 1, `subprocess` | Excluded across all four columns: "Cut from v0 as largest attack surface" |
| Table 3, "Unmapped Node builtins: `child_process`, `vm`" | Missing. Absent from [`module-map.ts`](../../src/shim/module-map.ts), so importing it **fails the renderer build** on the specifier, not with a named refusal. "`child_process` is the one that is a refusal rather than a gap" |
| Table 4 row 3 | Cheapest lever: a `module-map.ts` row each that refuses by name; `child_process` stays a refusal |
| Table 4 row 11 | The container path "reopens `subprocess` in a narrow shape" |
| Table 4 row 12 | "A standalone WASI program: the shim maps no `node:wasi` and nothing implements WASI over `orivon.*`". `wasm-compatibility.md` is the plan that closes it |
| Table 5 | "The missing thing is a place to run non-renderer code... Preinstalled natives only pay off once something can load them on an app's behalf: `subprocess`, or the container path. Neither is built" |
| [`security-model.md`](../architecture/security-model.md) | "`subprocess` and `hid` are absent from the v0 API entirely, for signed apps too... **Adding either requires an ADR**" |
| [`capability-api.md`](../architecture/capability-api.md) | "Deliberately not in v0: `subprocess`. No tier-3 app is in this version, so it buys nothing and costs the largest attack surface" |
| [`ADR-0002`](../decisions/ADR-0002-capability-api-is-the-durable-asset.md) | "Not grantable to unsigned apps, because a Node broker cannot contain them: `subprocess` (helper-process spawn)". Its month-1 diagram named "Node sockets / fs / supervised helper process" as the first implementation |
| [`ADR-0036`](../decisions/ADR-0036-an-app-qualifies-by-running-in-the-node-environment.md) | An app qualifies by running in the Node environment; WebAssembly called from JavaScript already runs |
| [`scope.md`](../scope.md) OUT | "No app here needs them yet, and they are the largest attack surface" |
| [`container-apps-opportunity.md`](container-apps-opportunity.md) | Parked. `subprocess` as "start the container image this manifest declares", Linux first, a VM on Windows and macOS |
| `open-questions.md` A94 | Route B, app code in a Worker blocking on `Atomics.wait` over a `SharedArrayBuffer`, was weighed for synchronous `fs` and **not rejected**. `wasm-compatibility.md` section 2 measures both halves of it: isolation headers work through `protocol.handle`, and JSPI makes the worker unnecessary for a WASI host |

The vision corpus (`<vision-corpus>`, swept 2026-09-28) never mentions spawning a host process. Its
answer to "apps need OS power" is a WASM module running in `orivon-runtime` under WASI and
WIT-defined interfaces, with per-module OS Grants, and mobile is promised on the strength of WASM
portability alone. A native-process capability would be the one part of this repository the vision
could not carry to mobile.

## 2. What `child_process` does in the apps this platform actually ports

Rule 4 asks for a named need before a build. The ported apps in `orivon-ports` were read for it.

| App | What upstream spawns | Which shape below | Blocked today? |
|---|---|---|---|
| FreeTube | `spawn(externalPlayer, [args, url])`: VLC or mpv, chosen in settings, given a YouTube URL | **C**, a program the person chose | No. The bridge marks `openInExternalPlayer` `excluded`; nobody has asked |
| The Lounge | `spawn(process.execPath, ['yarn', ...])` to install themes server-side | Node running Node; no Orivon shape | No. Server-side plugin management, not the frontend |
| AirGap Vault | `require('child_process')` in its Electron main; use not inspected | -- | No |
| Element | Build scripts only; Seshat (event index) is a native Rust addon, refused `excluded` | Table 5, a native addon | No |
| ASGARDEX | none; its hardware-wallet path is `node-hid`/`usb` | `hid`, not this | No |
| IPFS Desktop (Table 2's tier-2 example, not yet ported) | `ipfsd-ctl` spawning the bundled `kubo` daemon binary | **B**, a native binary the app ships | Would be, from line one |

So the honest need today is: no ported app is blocked on `child_process`, one refuses a
convenience (FreeTube's external player), and the first daemon-shaped app anyone ports (IPFS
Desktop, a Monero or Lightning wallet spawning `monerod`/`lnd`, anything bundling Tor) hits
shape B at once. The daemon case is the one worth designing for, and it is exactly the one the
broker cannot bound if the daemon is native. `wasm-compatibility.md` section 3.5 closes the other
door for the Go daemons specifically: kubo, lnd and geth cannot open sockets from any WebAssembly
target, so no WASM work here turns them into tabs either.

## 3. Four shapes, and the two properties that separate them

| | **A. WASI program the app ships** | **B. Native binary the app ships** | **C. Program the person picks** | **D. Container image (parked doc)** |
|---|---|---|---|---|
| What runs | WebAssembly from the hash-pinned bundle | Machine code from the bundle | A program already installed by the person (VLC, mpv) | A Linux image the manifest names |
| Where its authority comes from | The app's own grants, through the WASI host's imports | **Ambient: the user's full authority** | The person's pick, plus one URL or one picked file as argument | Podman's mounts and network flags |
| Can the broker bound its reach? | **Yes, exactly**: every syscall is an `orivon.*` call | **No.** fs bypasses T1, network bypasses T12/T22, quota bypasses T11 | Only argv; the program itself is trusted by the person | Coarsely: whole-network on or off, named mounts |
| Containment | Chromium's renderer sandbox plus the WASM sandbox, both existing | Only an OS sandbox: `bwrap`/user namespaces (Linux), `sandbox-exec` (macOS, deprecated), **nothing on Windows without native code, which Rule 8 forbids** | The program's own | Podman |
| Linux / Windows / macOS | all three | Linux and macOS with containment; Windows uncontained | all three | Linux; a resident VM on Windows and macOS |
| Android (not enforced, "better if possible") | **Yes**: WebAssembly and JSPI are Chromium's; Workers and isolation too, when they are wanted | **No.** No Electron, and since Android 10 an app may execute only from its own packaged native-library dir | Yes, as an `ACTION_VIEW` intent: the platform's chooser is the consent | No |
| Fits the vision | Exactly (`orivon-runtime.mdx`) | Not mentioned; contradicts its mobile promise | A shell feature, not a capability | Not mentioned |
| New `src/contracts/` surface | **None** for `child_process` itself; the isolation field of `wasm-compatibility.md` section 5.7 is a separate, optional step | A capability kind that no other kind's guards can defend | None if built as an `ADR-0027` extension | A capability kind |
| Covers the daemon case | Only a daemon that compiles to WASI 0.2 with sockets (Rust `std::net` on `wasm32-wasip2` does; Go does not), and only once `wasm-compatibility.md` step 3 lands | Yes, at the cost above | No | Yes, Linux |

Two facts decide the ranking. First, **B is unbrokerable by construction**: a native process holds
the user's authority the instant it starts, so a grant prompt for it can only honestly say "this
app can do anything on this computer that you can". That is the security model's "honest headline"
failure made into a feature. Second, **A needs no new authority at all**: an app may already run
any WebAssembly it likes in its own tab (the served CSP carries `'wasm-unsafe-eval'`, Table 3).
What A adds is a *shape*: a `child_process` module whose "program" is a WASI module, over the host
`wasm-compatibility.md` designs, whose imports are the app's own `orivon.*` calls.

## 4. Recommendation

1. **Now, at no risk (Table 4 row 3):** give `child_process` and `vm` a `module-map.ts` row that
   refuses by name, so a ported bundle builds and the call fails loudly instead of the build
   failing on the specifier. Half a day, one file, no decision needed. This is independent of
   everything below and should not wait for it.
2. **Build A as what `child_process` means in `orivon-node-shim`** (section 5, "A1"): a
   `child_process` module over `src/shim/wasi/`'s preview1 host, which is
   `wasm-compatibility.md`'s step 1. A program is a WASI module the app ships; `spawn` runs it
   with JSPI on the page's main thread; stdin, stdout, stderr, exit code and `kill` work as Node's
   do; its file system is the app's own `fs` root through `orivon.fs`, so confinement, quota,
   in-flight limits and revocation are the broker's existing ones. **No contracts change.** It
   needs an ADR because it fixes the meaning of a Node module for every app that will ever call
   it, and because `security-model.md` asks for one before anything called a subprocess exists.
3. **Keep `subprocess` (B) excluded**, and sharpen the matrix row's reason from "largest attack
   surface" to the structural one: the broker cannot bound a native process, and containment
   cannot be uniform across the three desktop platforms under Rule 8. Section 8 lists the
   conditions under which it could be reopened, so the next person to propose it starts there.
4. **C is a shell feature, not a capability.** If FreeTube's external player is ever asked for, the
   cheapest honest shape is an "Open with a program you choose" option on the dialog
   [`ADR-0027`](../decisions/ADR-0027-an-external-link-opens-only-when-the-person-allows-it.md)
   already shows, remembered per site. Section 9. Not recommended until an app asks.
5. **D stays parked** where its own document left it. It is B with containment bought from Podman.
6. **A2, an out-of-renderer WASI host (`orivon.process`), is the later swap**, not the first build.
   Section 7 sketches it so the in-tab shape is built in a way that can be replaced underneath
   with no app-visible change, the same move `ADR-0016` recorded for synchronous `fs`.

## 5. Design A1: `child_process` over the WASI host

What follows is the delta over `wasm-compatibility.md` section 5. That document owns the host:
where it lives (`src/shim/wasi/`), JSPI (`instantiate.ts`), the preview1 import object and its
`orivon.fs` mapping, the errno table (`errno.ts`), the `node:wasi` module shape, isolation, sockets
and workers. This section owns only what a *child process* adds on top: how a program is named,
how its stdio behaves when a Node stream is on the other end, how it exits and dies, and which
members of Node's module refuse.

### 5.1 Shape

```
  app page (main thread), one event loop
  --------------------------------------------------------------------------
  require('child_process').spawn('bin/tool.wasm', args, { cwd, env })
      |  fetch the module from the app's own origin (served from the pin, verified)
      |  src/shim/wasi: instantiate with the preview1 host; _start wrapped in WebAssembly.promising
      |
      |   fd_read(0)   <- awaits the next chunk the page wrote to child.stdin, or EOF
      |   fd_write(1)  -> awaits child.stdout's consumer when it is over its high-water mark
      |   path_open / fd_read / fd_write / fd_readdir / ...
      |       -> orivon.fs.open / read / write / readdir / stat / mkdir / rm / rename   (the broker's own guards)
      |   proc_exit(code)  -> the entry promise settles
      v
  child.emit('exit', code) ; child.emit('close')
```

Every import is an `async` function installed as `WebAssembly.Suspending`; the WebAssembly stack
suspends on each `orivon.*` call and resumes on the page's own event loop. No Worker, no
`SharedArrayBuffer`, no isolation header, no new IPC. The one real cost is stated in 5.5.

### 5.2 Programs, and where their bytes come from

A program is a `.wasm` file **in the app's own bundle**, resolved as a URL relative to the app's
origin and fetched with the page's own `fetch`. The loader serves it from the pinned, hash-verified
cache like any other asset, so a program's integrity is the bundle hash (`ADR-0009`), and a host
that swaps the binary breaks the pin and re-prompts (T6). `spawn('ipfs')`, a bare program name, is
the ported app's own convention; its bridge file maps names to bundle paths, one file per app
(`ADR-0020`). No manifest field lists programs: a program runs with the app's own grants and
nothing more, so there is nothing new for a person to consent to (design rule 5 is satisfied, not
bypassed: no capability is implied, because none is added).

Running WebAssembly the app *downloaded into its data directory* is not offered in this version.
It would add no authority (the app can already `eval` fetched code), but it makes "what runs" a
runtime choice rather than a pinned one, and nothing asks for it.

### 5.3 What a child needs from the host, beyond what the host already plans

`wasm-compatibility.md` section 5.3 gives the host fd 0 answering EOF and fd 1/2 as sinks the
embedder passes. A child process needs three small extensions, all in the embedder-facing options
of `instantiate`, none in the WASI surface:

- **An async stdin source.** `fd_read(0)` awaits the next chunk from a queue `child.stdin`
  (a Node `Writable`) fills, and returns 0 bytes once `stdin.end()` has marked EOF and the queue
  is drained. A `Writable` whose `write` callback fires when the program has consumed the chunk
  gives the page real backpressure on input.
- **Async sinks with backpressure.** `fd_write(1)` and `fd_write(2)` push into `child.stdout` and
  `child.stderr` (Node `Readable`s) and await when `push()` returns false, until the consumer
  reads again. A program that writes faster than the page reads is paused exactly as a socket
  peer is by the credit window.
- **A kill hook.** `child.kill()` marks the instance killed; the next suspending import rejects
  with a named `WasiKilled` instead of performing the call, and the instance's exports are never
  entered again. There is no other way to stop WebAssembly running on the main thread, and there
  is no need for one: between imports the program holds the main thread, so no `kill()` can run
  meanwhile (5.5 is the consequence). In Worker mode (`wasm-compatibility.md` section 5.6)
  `kill()` is `worker.terminate()`, which is the real thing.

The file system a program sees, the errno table and the environment calls are the host's, unchanged.
`options.cwd` is a guest path under the single preopen; `options.env` becomes `environ_get`'s
answer; `args` become `args_get`'s, with `argv[0]` the program's own name.

### 5.4 Exit, close, signals, pid

- **Exit.** `proc_exit(code)`, or `_start` returning, settles the entry promise; the host reports
  the code through its `WasiExit`. The child emits `exit` with that code, then `close` once
  `stdout` and `stderr` have ended, in Node's order. A trap (`unreachable`, a bounds fault) is
  `exit` with `code: null` and `signalCode: 'SIGABRT'`, which is how Node reports a crashed child.
- **`kill(signal)`.** WASI has no signals. Every signal terminates (5.3); `signalCode` reports the
  name the caller passed, `killed` is true, and `exit` fires with `code: null`. Say so in the
  module's own doc comment.
- **Revocation.** If the `fs` grant is withdrawn mid-run, the next `orivon.fs` call rejects
  `revoked`; the shim treats it as a kill (`signalCode: 'SIGKILL'`) rather than surfacing an
  errno a program would retry against a root that no longer exists.
- **`pid`.** A synthetic positive integer, because libraries test `if (child.pid)`. It is a lie of
  the same kind `process.pid = 1` already tells (A223), and documented beside it.

### 5.5 Main thread first, Worker when a program earns it

With JSPI the program yields to the page only when it makes an import call. A program that
computes for a second between two syscalls freezes the page for that second, the same way any
long-running WebAssembly the app calls from its own JavaScript does today. For the programs
`child_process` is likely to meet first (a tool that reads a file, transforms it and writes a
result) that is acceptable and it is what `wasm-compatibility.md` recommends as step 1.

A program that must leave the main thread (a transcoder, a long-running indexer) needs the Worker
proxy for `orivon.*` that document's section 5.6 describes, and gets `worker.terminate()` as a
real kill in exchange. Whether it also needs cross-origin isolation depends on the host's route
inside the worker: JSPI in a worker needs no `SharedArrayBuffer` (measured working with no
isolation, that document's section 2); the `Atomics.wait` route (A94's Route B) does. `child_process` should
expose neither choice to the app: `spawn` runs on the main thread in this version, and a later
`options` hint, or a per-app default, moves a program to a Worker with no change to the module's
API. This is the A94 argument again: a mechanism swap, invisible to the caller.

### 5.6 The Node shape, and what refuses

| Member | This version |
|---|---|
| `spawn(file, args?, options?)` | Built. `file` is a bundle-relative `.wasm` path; `options.cwd` is a guest path; `options.env` is the program's environment; `options.stdio` accepts `'pipe'` (default), `'ignore'`, `'inherit'` (the page console, as the shim's `process.stdout` already does); `options.shell` truthy refuses `not-applicable` (there is no shell) |
| `execFile(file, args?, options?, callback)` | Built over `spawn`, buffering stdout/stderr up to `maxBuffer`, Node's default 1 MiB |
| `exec(command, options?, callback)` | Built over `execFile` with a whitespace-and-quotes tokenizer. A command containing shell metacharacters (`| & ; < > $ \``) refuses `not-applicable`: Node's `exec` runs `/bin/sh -c`, and there is no shell to run |
| `fork` | Built as a Web Worker running the app's module with the Node shim and an `orivon.*` proxy; `send`/`'message'` over `postMessage`, `kill()` is `worker.terminate()` (`ADR-0040`). Node's IPC channel between two Node processes has no other meaning here |
| `spawnSync`, `execSync`, `execFileSync` | Refuse `not-built` (their own A-number). JSPI suspends WebAssembly, never the JavaScript frame that called it, so a synchronous wait on the main thread cannot be given a value the program has not yet produced. A Worker plus `Atomics.wait` on the *caller's* side is the mechanism, and the caller is the app's own main thread, which may not block |
| `ChildProcess` | `stdin`, `stdout`, `stderr`, `stdio`, `pid`, `exitCode`, `signalCode`, `killed`, `connected: false`, `kill()`, `ref()`/`unref()` as no-ops, events `spawn`, `exit`, `close`, `error` |
| `spawn(process.execPath, ...)` | Refuses `not-applicable`: `process.execPath` is empty in an app tab, and there is no Node to run |
| A missing program (fetch 404, not `.wasm`) | An asynchronous `error` event whose `code` is `ENOENT`, Node's own shape for a program that is not there, so a library's "is the tool installed" check takes its ordinary branch |

Every refusal goes through [`refusingProxy`](../../src/shim/unimplemented.ts) and
`ShimRefusalReason`, so `typeof child_process.fork === 'function'` still holds and only a call
refuses, as the rest of the shim already does.

### 5.7 Limits and lifecycle

- **No new `LIMITS` entry.** A running program is the app's own JavaScript as far as the broker
  can see: `concurrentFileHandles`, `inFlightOperations`, the control-channel rate limiter and the
  quota all apply to its calls exactly as to the page's, because they are the page's. A `'limit'`
  from the in-flight cap or the rate limiter is retried by the host with bounded backoff rather
  than surfaced, since a program reading a blocking descriptor has no code path for `EAGAIN`;
  a `'limit'` from the quota is `ENOSPC`, which it does.
- **Lifetime is the tab's.** Navigation or closing the tab ends every program; the session-end
  cascade closes the handles they held. Table 3's "Background lifetime" row is untouched: nothing
  here survives the tab.
- **CPU and memory** are the renderer's own, as for any WebAssembly the app runs; a runaway program
  is a runaway tab, not a frozen browser (T11b is about the broker's UI thread, which the rate
  limiter still protects).

### 5.8 Not in this version, said plainly

- **No network inside a program.** Preview 1 can only be handed an already-listening socket, and
  step 1 of the host refuses even that. Real sockets come with WASI 0.2 through jco
  (`wasm-compatibility.md` section 5.5, gated on a named program), and when they do they are
  `orivon.net.connect`/`listen`/`udpBind`/`lookup` calls the main thread makes, so the app's
  network grants bound them exactly, resolved-address matching and private-range refusal included.
  `child_process` needs nothing new for that day: a `spawn`ed program with sockets is the same
  `spawn`.
- **No synchronous variants**, no `worker_threads`, no program from the data directory (5.2).

## 6. The guards, one by one

The question the owner asked: does this keep every broker guard exactly, at the least added risk?
For A1 the answer is structural, because nothing new crosses the renderer/broker boundary. The
other two columns say what an out-of-renderer or native shape would have to add back.

| Guard | A1 (`child_process` over the in-tab WASI host) | A2 (utility-process WASI host) | B (native binary) |
|---|---|---|---|
| T1 fs confinement, resolve then verify | Unchanged: every path goes through `orivon.fs`; the host's own preopen check only picks the errno | Re-established by uvwasi's preopen confinement, a second implementation the broker does not own | Only an OS sandbox's bind mounts; Windows: none |
| T2 grants against the pinned manifest | Unchanged; no new kind | New kind, must join `isCapabilityKind`, `patternSetFromCapabilities`, the loader, the prompt | Same, plus a kind whose grant cannot be narrower than "everything" |
| T3 origin from `senderFrame` | Unchanged | Unchanged for control calls | Unchanged for the spawn call; meaningless afterwards |
| T5 renderer never escapes into Node | Unchanged; the program runs in the sandboxed renderer, where the CSP already allows WebAssembly | **Weakened**: app-supplied bytes are compiled by V8 in a utility process, which runs Node with the user's authority and no OS sandbox (verify against Electron 44's docs) | Gone by definition |
| T6/T7 pinned code, read-only cache | Unchanged: programs are pinned assets | Same | Same for the bytes; irrelevant for what they then do |
| T11 quota | Unchanged: enforced on every `write` | **Bypassed**: uvwasi writes to disk directly; needs measurement on exit and a periodic re-measure that kills at a threshold | Bypassed |
| T11b broker UI thread | Unchanged; rate limiter and in-flight cap apply to the program's calls | Unchanged | n/a |
| T11c per-origin handle tables | Unchanged | New handle kind `process`, acquired under `{ by: 'grant' }` for the cascade | Same |
| T12 resolved-address matching, private ranges | Unchanged: no network in this version; later sockets are `orivon.net` calls | Same in v1; host imports later go through `checkConnect` | Bypassed: a native process dials whatever it likes |
| T13c no persisted grants on loopback/http origins | Unchanged | Unchanged (new kind inherits) | Unchanged |
| T17 raw port never reaches the page | Unchanged: no port is involved | stdio over `MessageChannelMain` behind `contextBridge` closures, the socket relay's own shape | Same |
| T19 subset check on update, `widensAuthority` | Unchanged; nothing declared | New kind must be mapped or an added program installs silently (the `https.connect` lesson in `manifest-patterns.ts`) | Same |
| T22 CSP bounds `fetch`/WebSocket | Unchanged; the program fetches nothing | n/a | Bypassed |
| Uniform `'denied'`, no `platformCode` | Unchanged; one errno for every denial | Unchanged | n/a |
| Timeouts on every reply-carrying message | Unchanged (existing `fs` calls) | Every new control method sets `timeoutMs` | Same |
| No transferables renderer to main | Unchanged | Same rule | Same |
| Revocation cascade, RST not FIN | Unchanged; the program dies on its next syscall | `HandleTable.revoke` kills the host process | Kill the process; what it already did stays done |
| `LIMITS` | None added | `concurrentProcesses`, memory and time budgets, all new | Same, plus none that can bound its reach |
| Level 4 hides breadth warnings (`ADR-0037`) | Nothing to hide | A new warning row | **Must never be silenced**: L4 attests the site, not what a native process does with the machine |

## 7. Design A2, for later: a WASI host outside the renderer (`orivon.process`)

Sketched so A1 is built in a way A2 can replace underneath. It earns its place only when a program
needs one of three things the in-tab host cannot give: CPU beyond the renderer process, a life
longer than the tab (which is Table 3's unspecified "background lifetime" question, not this one),
or an OS-level `kill` for a program that never yields.

- **Contract.** `Capabilities.process = { programs: Record<name, bundlePath> }` (declared),
  `CapabilityKind` `process.run` with the program names as its patterns (exact match, like
  `web.context`'s origins), `orivon.process.spawn({ program, args, env }) -> ProcessHandle`
  with `stdin: WritableStream`, `stdout`/`stderr: ReadableStream`, `exited: Promise<{ code,
  signal }>`, `kill()`, and the `Handle` base. Prompt: "Run the program `<name>` alongside this
  app, with this app's own files and no network", a warning row.
- **Host.** `src/process-host/`, a utility process per running program, the
  [`src/verifier-host/`](../../src/verifier-host/) precedent (`utilityProcess.fork` in
  `verifier-subsystem.ts`, `HostSupervisor`), running `node:wasi` (loads in Electron 44's
  bundled Node 24.18, measured 2026-09-28, still experimental) with the app's data directory as the
  one preopen. stdio relayed to the page over one `MessageChannelMain` per stream, reusing
  [`port-pump.ts`](../../src/broker/transport/relay/port-pump.ts) and `port-sink.ts` unchanged.
- **Three caveats that decide whether it is worth it.** (1) `utilityProcess.fork` cannot pipe
  stdin (Electron documents stdin as `ignore` only; verify with context7), so stdin must be fed
  through the parent port into a pipe the host creates, or dropped. (2) uvwasi writes bypass the
  broker's quota counter (section 6, T11). (3) A utility process is unsandboxed Node, so
  app-supplied WebAssembly compiled there is a V8 attack surface with the user's authority behind
  it, where the renderer has Chromium's sandbox in front of the same code. That third point is
  the reason A1 comes first, not a detail.
- **Rejected for A2:** `child_process.spawn(process.execPath)` with `ELECTRON_RUN_AS_NODE=1` for
  a plain Node child with real pipes. It works today and is what CLAUDE.md's Local quirks warn
  about, and it dies the day the `runAsNode` fuse is flipped for packaging, which Electron's own
  hardening guide recommends. Node's permission model (`--permission`) is not a substitute for the
  broker either: it does not cover the network.

## 8. Shape B: what it would take to reopen `subprocess`, and why not now

Kept as a checklist so the proposal is not re-derived. Every item is necessary; together they are
still not sufficient to call it safe.

1. **A named app with no WASI route**, per Rule 4. IPFS Desktop would be one.
2. **A separate kind, `process.native`**, never merged with anything, never silenced at Level 4,
   whose prompt says: "Run a program on your computer with everything you can do on it." No
   pattern can narrow that sentence truthfully.
3. **The binary is a pinned bundle asset**, so at least what runs is what was consented to.
4. **Its network reach is declared as the app's own `tcp.connect`/`udp.send`/listen grants**, and
   a native program is offered only to an app already holding the unlimited forms, since that is
   what it will have anyway. The prompt then shows the truth it already shows for `*:*`.
5. **OS containment where it exists, refusal where it does not.** Linux: `bwrap` or `unshare`
   with the data directory bind-mounted and nothing else; macOS: a `sandbox-exec` profile
   (deprecated by Apple, still functional); **Windows: no free-standing sandbox exists, and
   AppContainer needs native code Rule 8 forbids, so the call refuses `'unavailable'` there.**
   That refusal is the point at which "safe" and "every platform" part ways, and it should be
   stated to the owner as such rather than papered over with an uncontained fallback.
6. **A supervisor**: kill on tab close, revoke and quit; no orphaned daemons.
7. **An ADR**, as `security-model.md` already requires, reversing the exclusion with its reasons.

Shape D, the container, satisfies items 5 and 6 by buying them from Podman, at the cost its own
document records (a resident VM on Windows and macOS, a 1 GB first run). If the daemon case ever
becomes the need, D is the better-analysed answer to it than B is.

## 9. Shape C: a program the person picks

FreeTube's external player is the only ask so far, and it is refused today. The safe shape is not
a capability but an extension of the dialog `ADR-0027` already draws for external links: an "Open
with..." choice that lets the person pick a program once (an OS file picker, the person's choice as
the consent, `fs.userSelected`'s own reasoning), remembered per site, with the URL as the program's
only argument. Argument injection is closed by the URL grammar (a URL never starts with `-`) and
by never passing a shell; on Windows, `.bat`/`.cmd`/script targets are refused, not launched.

Two limits keep this small. A URL the program must fetch itself works (VLC plays a YouTube URL
through its own resolver); a stream Orivon serves renderer-locally cannot, by T15, be reached by
any other process, so the torrent-app's VLC hand-off the 2026-08-25 audit mentions stays closed
whatever this does. And on Android the whole shape is an `ACTION_VIEW` intent with the system
chooser, which is the one place this repository's design would map onto the platform for free.

Not recommended until an app asks; when one does, it is a shell change under `ADR-0027`, not a
`src/contracts/` change.

## 10. Platforms, per shape

| | Linux | Windows | macOS | Android (not this repository's target; contract portability only) |
|---|---|---|---|---|
| A1 in-tab WASI | yes | yes | yes | yes: WebAssembly and JSPI are Chromium's |
| A2 utility-process WASI | yes | yes | yes | no Electron; the contract would be honoured by another host |
| B native binary | contained (`bwrap`) | **uncontained** | contained (`sandbox-exec`, deprecated) | impossible (W^X since Android 10) |
| C person-picked program | yes | yes, with script-extension refusals | yes (`open -a`) | yes, as an intent |
| D container | yes | VM | VM | no |

## 11. What the matrix should say once A1 lands

Target states, stated as the matrix states things (current state only, no history). The rows the
WASI host itself changes (Table 2's fifth family, Table 4 row 12) are `wasm-compatibility.md`'s
section 6 to state; these are the `child_process` rows.

- **Table 1, `subprocess`:** stays excluded in all four columns. Note: "A native process holds the
  user's whole authority, so no grant can bound it and no prompt can narrow it; containment is
  not uniform across platforms under Rule 8. A program the app ships compiled to WebAssembly is
  not this row: it runs inside the app's tab through `child_process` (Table 3)."
- **Table 2, Node stdlib family:** add `child_process` to the built list, with its named
  refusals (`fork`, the sync trio, `shell`, `exec` with metacharacters).
- **Table 3, "Unmapped Node builtins":** split. `child_process` becomes its own built row: "A
  program is a `.wasm` asset of the app's own bundle, run by the WASI host on the page's main
  thread over `orivon.fs`; no network, no signals, no sync variants." `vm` keeps a named-refusal
  row.
- **Table 4 row 3:** delete once both refusal rows and the built `child_process` exist.
- **Table 5:** the last paragraph's "a place to run non-renderer code" gains: for WebAssembly, the
  app's own tab is that place; only native code still has none.
- [`app-compatibility.md`](../architecture/app-compatibility.md) "Where WASM fits" gains "as a
  program the app spawns"; [`src/shim/README.md`](../../src/shim/README.md) gains the module and a
  "may import `src/shim/wasi/`" line, the same side of the trust boundary as its existing import
  of `src/shim-electron/unimplemented.ts`.

## 12. Implementation plan, for the agent that builds it

Read CLAUDE.md's tooling table first: `orivon-electron` and `orivon-comments` skills before
touching Electron or writing a comment in `src/`; context7 before trusting any Electron or WASI
signature; every Electron launch through `node scripts/run-headless.mjs`; `superpowers`'
`brainstorming` and `writing-plans` before code, `test-driven-development` for the stdio layer.
Then read `wasm-compatibility.md` sections 5 through 7: this plan starts where its step 1 ends.

### Step 0: the refusal rows (independent, do first)

`module-map.ts` rows for `child_process` and `vm` that refuse by name through `refusingProxy`
with reason `'excluded'` for `child_process` (until Step 2 replaces it) and `'unimplemented'` for
`vm`, tests in `src/shim/tests/`, matrix Table 4 row 3 updated. One PR, or folded into the day's.

### Step 1: the WASI host lands (`wasm-compatibility.md` step 1)

Not this document's work, but its prerequisite: `src/shim/wasi/` with the preview1 host,
`instantiate.ts`, `errno.ts`, the fixture app and its e2e. Two things to ask of it while it is
built, so `child_process` needs no retrofit: the embedder options of section 5.3 (an async stdin
source, async sinks that await backpressure, a kill hook), and `WasiExit`/`WasiKilled` as named,
exported errors. The measurements it rests on are already taken
(`spike-results/wasm-renderer-probe.json`): JSPI works in Electron 44, on the main thread, with no
header. **No spike is left for `child_process` to run first**, and no new dependency is needed:
that document's section 3.4 found no existing preview1 library whose descriptor layer can await,
so the host is written here, with `browser_wasi_shim`'s function list and errno tables as the
reference.

### Step 2: the `child_process` PR (one day PR, pieces separately findable)

- **Shim:** `src/shim/child-process/` (`index.ts` the Node module shape and `ChildProcess`;
  `stdio.ts` the Node `Writable`/`Readable` pair over the host's stdin source and sinks;
  `program.ts` fetching a bundle-relative `.wasm` and mapping a missing one to `ENOENT`;
  `command-line.ts` the tokenizer `exec` uses). `module-map.ts`'s `child_process` row flips from
  refusal to `'ready'`. Every file under 500 lines; header comments within the 25-line budget,
  rationale in the directory README.
- **Tests:** unit tests for the tokenizer, the stdio pair against a fake host (backpressure both
  ways, EOF, kill mid-read), the `ENOENT` path, and exit/close ordering; an e2e test in which the
  fixture app spawns a WASI program that reads a file the page wrote, writes a result the page
  reads back over `stdout`, and then attempts `../escape`, which must fail from the broker's own
  confinement, not from the shim. That last assertion is the one that proves the guards are the
  broker's. The WASI test module: `.wat` text assembled by the `wabt` npm package, as
  `wasm-compatibility.md` section 6 already plans, or bytes hand-assembled the way the served-CSP
  test does; no Rust or C source enters this repository.
- **Docs:** section 11's rows; `src/shim/README.md`; `docs/architecture/app-compatibility.md`;
  the ADR (below); decision-log rows; an `open-questions.md` entry for the sync variants and one
  for Worker execution; `devlog/journal.md` one bullet.
- **ADR (proposed, next free number; two branches can take the same one, the later renumbers):**
  "`child_process` runs a WebAssembly program inside the app's own tab; Orivon never spawns a
  process for an app." Decision, context (this file and `wasm-compatibility.md`), alternatives
  (A2, B, D), consequences (a program computes on the page's thread until Worker execution
  exists; no network in a program until WASI 0.2 sockets), reversibility (cheap until a port
  ships against it).

### Step 3: verification before claiming done

`npm run typecheck`, `npm test`, all eleven `check:*` guards, `npm run smoke` (read the JSON
failure list), `npm run test:e2e`, the new e2e test among them. Then the adversarial review the
tooling table asks for after a step lands, on the stdio layer and the program resolver: the first
is where a program can stall the page, the second is where a URL becomes code.

### Traps already known

- `ELECTRON_RUN_AS_NODE=1` is set in the ambient shell; `test/launch-electron.mjs` strips it.
- Never a transferable on the renderer-to-main path (electron#34905, silent loss).
- A `WebAssembly.Suspending` import reached through a JavaScript frame traps: the host installs
  them directly as the import object, and `child_process` never calls one itself
  (`wasm-compatibility.md` section 3.1).
- The unit suite cannot run JSPI without a Node flag whose name varies by V8 version; keep the
  stdio pair testable with a fake host and leave JSPI to the Electron e2e (that document's
  section 2, item 5).
- A Worker in an app tab has no `orivon.*` and no routed `fetch` (A211); until the Worker proxy
  exists, everything runs on the main thread.
- `'invalid'` is checked before `'denied'` (the `web.openContext` order); a denial never says why.
- Docs state current state only: no "used to", no PR numbers, no dates outside `docs/planning/`
  and the decision log.

## 13. Decisions this needs from the owner

1. Accept that `child_process` in Orivon means "a WebAssembly program the app ships, run by the
   WASI host", and that `subprocess` (native) stays excluded with section 8 as its reopening
   conditions.
2. Take `wasm-compatibility.md`'s decision 1 first: whether the WASI host is a build item now or
   waits for a named program. `child_process` is a consumer of that host and cannot land before
   it.
3. Whether to build Step 0 now regardless of the rest (recommended: yes, it is half a day).
4. Whether shape C is worth an `ADR-0027` extension before any app asks (recommended: no).

## 14. Sources read for this document

`docs/planning/{compatibility-matrix,wasm-compatibility,container-apps-opportunity}.md` and
`spike-results/wasm-renderer-probe.json`; `docs/architecture/{security-model,capability-api,
app-compatibility}.md`; `docs/scope.md`; `ADR-0002`, `-0016`, `-0019`, `-0027`, `-0032`,
`-0034`, `-0036`, `-0037`; `docs/open-questions.md` A94, A202; `src/contracts/*`;
`src/broker/{index,broker-contracts}.ts`, `capabilities/{net,web}.ts`,
`policy/{manifest-patterns,request-grant,update}.ts`, `handles/handle-contracts.ts`,
`transport/{ipc,ipc-validation}.ts`, `transport/relay/*`; `src/main/sessions/web-context-host.ts`;
`src/main/consent/grant-prompt-render.ts`; `src/main/verifier/verifier-subsystem.ts`;
`src/verifier-host/{README.md,entry.ts}`; `src/loader/serve/{csp,serve}.ts`;
`src/loader/manifest/capabilities.ts`; `src/shim/{module-map,unimplemented,globals,errors}.ts`;
`scripts/check-manifest-parity.mjs`; `electron.vite.config.ts`; `orivon-ports/apps/*/README.md`
and the upstream sources under `orivon-ports/out/*/source` for `child_process`; the vision corpus
at `<vision-corpus>` (20 documents, swept for every process-related term: none found). Electron
44.0.0 with bundled Node 24.18.1 measured on this machine: `node:wasi` loads there (experimental
warning), which bears only on A2.
