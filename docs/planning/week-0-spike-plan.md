# Week-0 spike — execution plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` (inline) or
> `superpowers:subagent-driven-development` to work through this task-by-task. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** Decide, in two days, whether `webtorrent` can run inside a sandboxed Electron
renderer over a shimmed `net`/`dgram` — fetching *ordinary* (non-WebRTC) torrents, with no
native modules in the shell tree and a working video path.

**Architecture:** A throwaway Electron app. The renderer runs `webtorrent` with per-module
resolution overrides that beat its `browser` field; `net` and `dgram` resolve to a shim that
forwards to a broker in the main process over one `MessageChannelMain` port per socket. The
preload holds the raw port in the isolated world and exposes only `contextBridge` closures.

**Tech stack:** Electron + `electron-vite` + TypeScript, Vitest (`environment: 'node'`),
Playwright `_electron` for driving the app, `webtorrent@3.0.21`, `streamx` for the shim's
stream shapes.

**Spec:** [`build-plan.md`](build-plan.md) §Week 0 · [`audit-2026-08-25.md`](audit-2026-08-25.md) ·
[`capability-api.md`](../architecture/capability-api.md) §Throughput

**Location note:** the `writing-plans` skill defaults to `docs/superpowers/plans/`. This repo
keeps planning documents in `docs/planning/`, so it lives here instead.

---

## What this plan is not

Tasks 2–7 build **throwaway code**. It is deleted when the spike resolves, and it is not held to
the standards the real broker will be. Test-driven development applies to exactly two things
here, and both survive the spike: the **native-module guard** (Task 1) and the **scaffold's test
wiring**. Everything else is measurement code, and its "test" is the gate criterion — a recorded
number or a byte-comparison, written to `spike/results/*.json` so the verdict is reproducible
rather than remembered.

Say so plainly in review: a spike that gets gold-plated has stopped being a spike.

---

## Global constraints

Copied verbatim from the specs. Every task inherits these.

- **TypeScript only.** No Rust, no C++ (`ADR-0002`).
- **Pure-JS dependencies only.** Zero `binding.gyp` and zero `prebuilds/` anywhere under
  `node_modules` (Rule 8, `build-plan.md` §Platform policy).
- **`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.** The raw
  `MessagePort` **never** crosses into the main world — the preload holds it in the isolated
  world and exposes only closures (`capability-api.md` §Throughput; `security-model.md` T17).
- **All storage through `app.getPath('userData')`.** Never a hardcoded XDG path (`ADR-0003`).
- **Video is MP4/H.264 only.** MKV has no path in v0 (owner decision, 2026-08-25).
- **Toolchain:** Node 24.11.1, npm 11.6.2 (verified present 2026-08-25).
- **Timebox: 2 days.** Gates run in order. **Stop at the first gate that fails** and write the
  verdict — do not proceed to later gates to "see if they would have passed".
- **Fallback if a gate fails:** run `webtorrent` in an Electron **`utilityProcess`**, never in
  the main process (`build-plan.md`).

---

## Verified facts this plan rests on

Checked against live sources on 2026-08-25, because `build-plan.md` warns that training data is
stale here. **Three of these correct the spec.**

| Fact | Status |
|---|---|
| webtorrent is at **3.0.21** | **Corrects the spec** — `build-plan.md` and `CLAUDE.md` both say "webtorrent 2.x" |
| webtorrent's `browser` field maps to `false`: `net`, `bittorrent-dht`, `ut_pex`, `./lib/conn-pool.js`, `./lib/utp.cjs`, `@silentbot1/nat-api`, `load-ip-set`, `crypto`, `fs`, `http`, `os` — and maps `fs-chunk-store` → `fsa-chunk-store` | Confirmed, and **wider than the spec listed**. `dgram` is *not* in the map; it is reached only through `bittorrent-dht`, which is |
| `webtorrent → @thaunknown/simple-peer@10.1.2 → webrtc-polyfill@1.2.2 → node-datachannel@^0.32.3`, built with `cmake-js` | Confirmed — a **hard, non-optional** chain, exactly as the audit found |
| `bittorrent-dht@11.0.12` has **no native dependencies** | Confirmed — pure JS, so DHT over a shimmed `dgram` is plausible |
| `client.createServer(opts, force)` accepts `force: 'browser' \| 'node'`, documented as being *"for environments which run both Node and Browser like NW.js or Electron"* | **New — not in any project doc.** Directly relevant to Gate 3 |
| `electron#34905` is **still open** | Confirmed. See below — this is the finding that reorders the plan |

### The finding that reorders the plan

`electron#34905` is not merely "transfers may lose data". The reporter's diagnosis is that
**`MessagePortMain.postMessage` only accepts `MessagePortMain` objects in its transfer list** —
so transferring an `ArrayBuffer` renderer → main may not be *possible*, not just unreliable.

`build-plan.md` §Week 0 structures Gate 4 as "day 1 naive → day 2 with transferable
`ArrayBuffer`s and 64–256 KB batching", and calls "passes, but only with transferables" the
likeliest outcome. **If transferables are unavailable on this path, that mitigation does not
exist** and a Gate-4 failure would have no day-2 rescue.

This is cheap to settle and everything else depends on it, so it becomes **Gate 0**, run before
any webtorrent work. The likely result is fine: structured clone *copies* the buffer, and the
audit already measured ~310 MB/s against the 1–5 MB/s that 1080p needs. But it must be measured,
not assumed — and if copying is the only path, that belongs in `capability-api.md` before the
real shim is written.

---

## File structure

**Kept** — survives the spike whatever the verdict, because it is engine-agnostic:

| File | Responsibility |
|---|---|
| `package.json` | Deps, scripts, the `postinstall` guard hook |
| `tsconfig.json`, `tsconfig.node.json` | Strict TypeScript for main / preload / renderer |
| `electron.vite.config.ts` | Three build targets; the renderer's resolution overrides |
| `vitest.config.ts` | `environment: 'node'`, unit tests only |
| `scripts/check-no-native-modules.mjs` | Fails the build on any `binding.gyp` / `prebuilds/` |
| `scripts/check-no-native-modules.test.ts` | Its tests — this one is TDD |
| `.github/workflows/ci.yml` | Typecheck + unit tests + the guard, on push |
| `src/main/index.ts` | Window creation, secure `webPreferences` |
| `src/preload/index.ts` | `contextBridge` surface |
| `src/renderer/` | Placeholder page |

**Throwaway** — deleted when the spike resolves, all under one directory so removal is one
`git rm -r`:

| File | Responsibility |
|---|---|
| `spike/main/broker.ts` | Real Node `net`/`dgram` behind a per-socket `MessagePortMain` |
| `spike/preload/net-bridge.ts` | Holds ports in the isolated world; exposes closures only |
| `spike/shim/net.ts` | Node `net`-shaped surface over the bridge |
| `spike/shim/dgram.ts` | Node `dgram`-shaped surface over the bridge |
| `spike/renderer/gate-*.ts` | One driver per gate |
| `spike/fixtures/seeder.mjs` | Local TCP-only seeder — removes swarm health as an input |
| `spike/results/gate-*.json` | Recorded measurements; the verdict's evidence |
| `docs/planning/spike-verdict.md` | Written at the end, whatever the outcome |

---

## Task 1: Scaffold, and the native-module guard

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`
- Create: `scripts/check-no-native-modules.mjs`
- Test: `scripts/check-no-native-modules.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `checkNoNativeModules(root: string) => { ok: boolean; offenders: string[] }` —
  used by the `postinstall` hook and by Gate 2 in Task 5.

- [ ] **Step 1: Write the failing test for the guard**

```ts
// scripts/check-no-native-modules.test.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNoNativeModules } from './check-no-native-modules.mjs'

const fixture = () => mkdtempSync(join(tmpdir(), 'orivon-guard-'))

describe('checkNoNativeModules', () => {
  it('passes on a tree with no native artefacts', () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules/pure-js'), { recursive: true })
    writeFileSync(join(root, 'node_modules/pure-js/index.js'), 'export default 1')
    expect(checkNoNativeModules(root)).toEqual({ ok: true, offenders: [] })
  })

  it('fails on a binding.gyp', () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules/node-datachannel'), { recursive: true })
    writeFileSync(join(root, 'node_modules/node-datachannel/binding.gyp'), '{}')
    const result = checkNoNativeModules(root)
    expect(result.ok).toBe(false)
    expect(result.offenders[0]).toContain('node-datachannel')
  })

  it('fails on a prebuilds directory', () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules/bufferutil/prebuilds/linux-x64'), { recursive: true })
    const result = checkNoNativeModules(root)
    expect(result.ok).toBe(false)
    expect(result.offenders[0]).toContain('bufferutil')
  })

  it('finds artefacts nested in transitive dependencies', () => {
    const root = fixture()
    const nested = 'node_modules/webrtc-polyfill/node_modules/node-datachannel'
    mkdirSync(join(root, nested), { recursive: true })
    writeFileSync(join(root, nested, 'binding.gyp'), '{}')
    expect(checkNoNativeModules(root).ok).toBe(false)
  })

  it('ignores a binding.gyp outside node_modules', () => {
    const root = fixture()
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/binding.gyp'), 'an example in documentation')
    expect(checkNoNativeModules(root)).toEqual({ ok: true, offenders: [] })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run scripts/check-no-native-modules.test.ts`
Expected: FAIL — `Failed to resolve import "./check-no-native-modules.mjs"`.

- [ ] **Step 3: Write the guard**

```js
// scripts/check-no-native-modules.mjs
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ARTEFACTS = new Set(['binding.gyp', 'prebuilds'])

export function checkNoNativeModules (root) {
  const offenders = []
  const modulesRoot = join(root, 'node_modules')
  try {
    statSync(modulesRoot)
  } catch {
    return { ok: true, offenders: [] }
  }
  walk(modulesRoot)
  return { ok: offenders.length === 0, offenders }

  function walk (dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (ARTEFACTS.has(entry.name)) {
        offenders.push(relative(root, full))
        continue
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, offenders } = checkNoNativeModules(process.cwd())
  if (!ok) {
    console.error('Native build artefacts found. Rule 8 forbids these:\n')
    for (const o of offenders) console.error(`  ${o}`)
    console.error('\nThey break run-from-source on Windows and macOS (build-plan.md).')
    process.exit(1)
  }
  console.log('No native build artefacts. Rule 8 satisfied.')
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run scripts/check-no-native-modules.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire up the project**

`package.json` — note `webtorrent` is a **devDependency** here. It is a pre-built app asset, not
a shell dependency (`build-plan.md` §Platform policy), and the spike only needs it locally.

```json
{
  "name": "orivon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "check:natives": "node scripts/check-no-native-modules.mjs",
    "postinstall": "node scripts/check-no-native-modules.mjs"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "electron": "^33.0.0",
    "electron-vite": "^2.3.0",
    "typescript": "^5.7.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`electron.vite.config.ts` — the renderer aliases are what Gate 1 turns on. They are written here
but only *populated* in Task 3, so this file starts with the shim entries commented out and a
pointer to the task that fills them in.

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    resolve: {
      // Task 3 populates this. These aliases must beat webtorrent's `browser`
      // field, which maps `net`, `bittorrent-dht`, `ut_pex` and `conn-pool` to
      // `false` — leaving a WebRTC-only client, which is Brave parity and the
      // thing ADR-0001 reason 3 exists to beat.
      alias: {}
    }
  }
})
```

`src/main/index.ts` — the `webPreferences` here are load-bearing, and there is a hookify rule
that will reject the file if they are weakened.

```ts
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

function createWindow (): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

- [ ] **Step 6: Verify the whole scaffold runs**

Run: `npm install && npm run typecheck && npm test && npm run check:natives && npm run dev`
Expected: install completes with the guard passing, typecheck clean, 5 tests pass, a window opens.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json electron.vite.config.ts vitest.config.ts src scripts .github
git commit -m "Scaffold: electron-vite + TypeScript + Vitest, with the native-module guard"
```

---

## Task 2 — GATE 0: does `MessagePortMain` carry bytes renderer → main at all?

**Why first:** `electron#34905` is open, and the reporter's diagnosis is that
`MessagePortMain.postMessage` accepts *only* `MessagePortMain` in its transfer list. Every later
gate, and the entire `capability-api.md` §Throughput design, sits on this path. If structured
clone renderer → main is also broken, nothing else in the plan matters.

**Files:**
- Create: `spike/main/gate0.ts`, `spike/preload/gate0.ts`, `spike/renderer/gate-0.ts`
- Create: `spike/results/gate-0.json` (output)

**Interfaces:**
- Produces: `spike/results/gate-0.json` with shape
  `{ clone: { sizeBytes, ok, mbPerSec }[], transfer: { sizeBytes, ok, error }[], verdict }` —
  Task 7 reads `mbPerSec` from here as its baseline.

- [ ] **Step 1: Build the echo harness**

Main process opens a `MessageChannelMain`, sends one port to the renderer, and echoes back
whatever arrives, unmodified.

```ts
// spike/main/gate0.ts
import { MessageChannelMain, type BrowserWindow } from 'electron'

export function installGate0Echo (win: BrowserWindow): void {
  const { port1, port2 } = new MessageChannelMain()
  port1.on('message', (event) => {
    // Echo the payload straight back. No transfer list: see gate-0 finding.
    port1.postMessage(event.data)
  })
  port1.start()
  win.webContents.postMessage('gate0:port', null, [port2])
}
```

- [ ] **Step 2: Hold the port in the isolated world**

The preload keeps the raw port and exposes closures. This is the rule from
`capability-api.md` §Throughput, and the spike follows it so that Gate 4 measures the path the
product can actually ship.

```ts
// spike/preload/gate0.ts
import { contextBridge, ipcRenderer } from 'electron'

let port: MessagePort | null = null
const waiters: Array<(data: unknown) => void> = []

ipcRenderer.on('gate0:port', (event) => {
  port = event.ports[0]
  port.onmessage = (e) => waiters.shift()?.(e.data)
  port.start()
})

contextBridge.exposeInMainWorld('__gate0', {
  ready: () => port !== null,
  // Structured clone: no transfer list.
  echoClone: (bytes: Uint8Array) => new Promise((resolve) => {
    waiters.push(resolve)
    port!.postMessage(bytes)
  }),
  // Attempt a transfer. Expected to throw or lose data — electron#34905.
  echoTransfer: (bytes: Uint8Array) => new Promise((resolve, reject) => {
    waiters.push(resolve)
    try { port!.postMessage(bytes, [bytes.buffer]) } catch (err) { reject(err) }
  })
})
```

- [ ] **Step 3: Run the measurement**

```ts
// spike/renderer/gate-0.ts
const SIZES = [64 * 1024, 256 * 1024, 1024 * 1024]
const ITERATIONS = 200

function pattern (n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = i % 251   // prime stride: catches truncation and reordering
  return b
}

export async function runGate0 () {
  const clone = []
  for (const size of SIZES) {
    const sent = pattern(size)
    const first = await (window as any).__gate0.echoClone(sent) as Uint8Array
    const ok = first instanceof Uint8Array &&
               first.length === size &&
               first.every((v, i) => v === sent[i])
    const t0 = performance.now()
    for (let i = 0; i < ITERATIONS; i++) await (window as any).__gate0.echoClone(sent)
    const seconds = (performance.now() - t0) / 1000
    // Round trip = 2 crossings, so bytes moved is 2x.
    clone.push({ sizeBytes: size, ok, mbPerSec: (size * ITERATIONS * 2) / seconds / 1e6 })
  }

  const transfer = []
  for (const size of SIZES) {
    const sent = pattern(size)
    try {
      const got = await (window as any).__gate0.echoTransfer(sent) as Uint8Array
      transfer.push({ sizeBytes: size, ok: got?.length === size, error: null })
    } catch (err) {
      transfer.push({ sizeBytes: size, ok: false, error: String(err) })
    }
  }

  return { clone, transfer, verdict: clone.every(c => c.ok) ? 'PASS' : 'FAIL' }
}
```

- [ ] **Step 4: Record the result and decide**

Run: `npm run dev`, trigger `runGate0()`, write the returned object to
`spike/results/gate-0.json`.

**PASS** = every `clone` entry has `ok: true` **and** `mbPerSec >= 50` at 256 KB. Fifty is
twenty-five times the 1–5 MB/s that 1080p needs, so it leaves ample room for the shim's overhead.

**Whatever `transfer` shows, it is a finding, not a gate.** If transfers fail, record that
`capability-api.md` §Throughput must drop its transferable-`ArrayBuffer` language and
`build-plan.md`'s "day 2 with transferables" rescue does not exist. Copying at ≥50 MB/s is
sufficient on its own.

**FAIL** = stop. The capability API's data path needs redesigning before any other work, and
that is a far bigger finding than the spike was scoped to produce. Write it up and escalate.

- [ ] **Step 5: Commit**

```bash
git add spike/ && git commit -m "Gate 0: measure MessagePortMain byte fidelity renderer to main"
```

---

## Task 3 — GATE 1a: does a renderer bundle reach an ordinary TCP peer?

**This is the real risk.** A naive renderer bundle is WebRTC-only, which is Brave parity.

**Files:**
- Create: `spike/main/broker.ts`, `spike/preload/net-bridge.ts`, `spike/shim/net.ts`
- Create: `spike/fixtures/seeder.mjs`, `spike/renderer/gate-1a.ts`
- Modify: `electron.vite.config.ts` (populate `renderer.resolve.alias`)

**Interfaces:**
- Consumes: the port pattern proven in Task 2.
- Produces: `spike/shim/net.ts` exporting `connect(options, listener?) => Socket` and
  `createServer(...)`, where `Socket` is a `streamx` `Duplex` carrying `remoteAddress`,
  `remotePort`, `setNoDelay()`, `setTimeout()` and `destroy()`. Task 4 reuses the same bridge
  pattern for `dgram`.

- [ ] **Step 1: Confirm which modules the outgoing-TCP path actually touches**

Before writing aliases, read the installed source rather than guessing. `conn-pool` is
webtorrent's *incoming* listener; the outgoing path is separate, and Gate 1a only needs outgoing.

Run:
```bash
npm install --no-save webtorrent@3.0.21
grep -rn "require('net')\|from 'net'\|require('dgram')\|from 'dgram'" \
  node_modules/webtorrent/lib node_modules/bittorrent-dht node_modules/k-rpc \
  node_modules/torrent-discovery 2>/dev/null
```
Record which files need which alias in `spike/results/module-map.md`. **If this contradicts the
alias list below, the grep wins** — it is reading the installed version.

- [ ] **Step 2: Write the seeder fixture**

A local TCP-only seeder removes swarm health from the measurement. `build-plan.md` requires
this for Gate 4; using it from Gate 1a onward means one fixture, not two.

```js
// spike/fixtures/seeder.mjs
import { createWriteStream } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import WebTorrent from 'webtorrent'

const SIZE_MB = Number(process.argv[2] ?? 64)
const dir = mkdtempSync(join(tmpdir(), 'orivon-seed-'))
const file = join(dir, 'fixture.bin')

const out = createWriteStream(file)
for (let i = 0; i < SIZE_MB; i++) out.write(randomBytes(1024 * 1024))
out.end()

out.on('close', () => {
  // tracker: false and no DHT — peers reach this seeder only by explicit address,
  // so Gate 1a proves a genuine TCP connection rather than a lucky WebRTC path.
  const client = new WebTorrent({ dht: false, tracker: false, lsd: false })
  client.seed(file, { announce: [] }, (torrent) => {
    console.log(JSON.stringify({
      infoHash: torrent.infoHash,
      magnetURI: torrent.magnetURI,
      port: client.torrentPort,
      sizeBytes: torrent.length
    }))
  })
})
```

- [ ] **Step 3: Write the broker and the `net` shim**

Broker side, in the main process — real Node sockets, one port per socket:

```ts
// spike/main/broker.ts
import { MessageChannelMain, ipcMain, type BrowserWindow } from 'electron'
import { connect as nodeConnect } from 'node:net'

// NOTE: the spike performs NO capability check. The real broker does — that is
// build step 2. Deliberate scope line, recorded so nobody mistakes this for a design.
export function installNetBroker (win: BrowserWindow): void {
  ipcMain.handle('spike:net:connect', (_e, { host, port }: { host: string, port: number }) => {
    const { port1, port2 } = new MessageChannelMain()
    const socket = nodeConnect({ host, port })

    socket.on('connect', () => port1.postMessage({ t: 'connect' }))
    socket.on('data', (chunk: Buffer) => port1.postMessage({ t: 'data', b: new Uint8Array(chunk) }))
    socket.on('error', (err) => port1.postMessage({ t: 'error', m: String(err) }))
    socket.on('close', () => { port1.postMessage({ t: 'close' }); port1.close() })

    port1.on('message', (ev) => {
      const m = ev.data as { t: string, b?: Uint8Array }
      if (m.t === 'write' && m.b) socket.write(Buffer.from(m.b))
      if (m.t === 'end') socket.end()
      if (m.t === 'destroy') socket.destroy()
    })
    port1.start()

    win.webContents.postMessage('spike:net:port', null, [port2])
    return true
  })
}
```

Renderer side — a `streamx` `Duplex`, because that is the stream library webtorrent already
uses, so no `readable-stream` polyfill enters the bundle:

```ts
// spike/shim/net.ts
import { Duplex } from 'streamx'

const bridge = (globalThis as any).__spikeNet

export class Socket extends Duplex {
  remoteAddress?: string
  remotePort?: number
  #handle: any

  constructor (handle: any, host: string, port: number) {
    super()
    this.#handle = handle
    this.remoteAddress = host
    this.remotePort = port
    handle.onData((b: Uint8Array) => this.push(b))
    handle.onClose(() => this.push(null))
    handle.onError((m: string) => this.destroy(new Error(m)))
  }

  _write (data: Uint8Array, cb: (e?: Error) => void) { this.#handle.write(data); cb() }
  _destroy (cb: (e?: Error) => void) { this.#handle.destroy(); cb() }

  // webtorrent and bittorrent-protocol call these; they must exist and be harmless.
  setNoDelay (_on?: boolean) { return this }
  setTimeout (_ms: number, _cb?: () => void) { return this }
  setKeepAlive (_on?: boolean, _ms?: number) { return this }
}

export function connect (options: { host: string, port: number }, listener?: () => void): Socket {
  const socket = new Socket(bridge.pendingHandle(), options.host, options.port)
  bridge.connect(options.host, options.port)
  if (listener) socket.once('connect', listener)
  return socket
}

export default { connect, Socket }
```

> **Known unknown, resolve here rather than guessing:** Node's `net.connect` is *synchronous* in
> shape — callers get a socket object immediately. Across IPC we cannot be. `capability-api.md`
> design rule 2 says the shim reconciles this by buffering, and `bridge.pendingHandle()` above is
> where that happens. If webtorrent writes before `connect` resolves, the handle must queue.
> **Confirm empirically in Step 5 and record the answer** — it is the first real test of design
> rule 2, and it will recur in the production shim.

- [ ] **Step 4: Populate the resolution overrides**

```ts
// electron.vite.config.ts — renderer.resolve.alias
alias: {
  // Beat webtorrent's `browser` field, which maps these to `false`.
  net: resolve(__dirname, 'spike/shim/net.ts'),
  dgram: resolve(__dirname, 'spike/shim/dgram.ts'),
  'bittorrent-dht': resolve(__dirname, 'node_modules/bittorrent-dht/index.js'),
  ut_pex: resolve(__dirname, 'node_modules/ut_pex/index.js')
  // NOT aliased on purpose: `@thaunknown/simple-peer` and `webrtc-polyfill` keep
  // BROWSER resolution, so the renderer uses Chromium's native WebRTC and
  // node-datachannel never enters the bundle. That is what makes Gate 2 passable.
}
```

> `./lib/conn-pool.js` and `./lib/utp.cjs` are **relative** specifiers inside webtorrent, and
> Vite aliases match module specifiers, not a dependency's internal relative paths. They are
> the *incoming* connection path, which Gate 1a does not need. **Do not fight this now** —
> record it as debt for the seeding story and move on.

- [ ] **Step 5: Run the gate**

```bash
node spike/fixtures/seeder.mjs 64    # prints JSON: infoHash, port
npm run dev                          # then run gate-1a.ts against that port
```

`spike/renderer/gate-1a.ts` adds the torrent with `{ dht: false, tracker: false }`, calls
`torrent.addPeer('127.0.0.1:<port>')`, and waits for the first piece.

**PASS** = a `verified` piece event fires from a peer whose `type` is **not** `webrtc`, and
`torrent.downloaded > 0`. Record the peer type explicitly — a WebRTC peer completing a piece
looks identical in every other respect and would be a false pass.

**FAIL** = stop. Fallback is `utilityProcess`. Record which specific resolution the bundler
refused, because that determines whether the fallback is the whole engine or only the socket
layer.

- [ ] **Step 6: Repeat against a real public torrent**

The local seeder proves the shim. A public MP4 torrent with healthy TCP seeds proves the shim
against real peers that negotiate real extensions. Both must pass. Record the magnet URI used —
Gate 3 reuses it.

- [ ] **Step 7: Commit**

```bash
git add spike/ electron.vite.config.ts
git commit -m "Gate 1a: webtorrent reaches an ordinary TCP peer through the shimmed net"
```

---

## Task 4 — GATE 1b: DHT lookup over shimmed `dgram`

**Files:**
- Create: `spike/shim/dgram.ts`, `spike/renderer/gate-1b.ts`
- Modify: `spike/main/broker.ts` (add the UDP handler)

**Interfaces:**
- Consumes: the bridge pattern from Task 3.
- Produces: `spike/shim/dgram.ts` exporting `createSocket(type) => UdpSocket` with `bind()`,
  `send(msg, port, host, cb)`, and `'message'` / `'listening'` / `'error'` events.

- [ ] **Step 1: Add UDP to the broker**

Mirror the TCP handler with `node:dgram`. `bittorrent-dht@11.0.12` is pure JS and reaches the
network only through `dgram`, so this alias is the whole of what DHT needs.

- [ ] **Step 2: Write the shim to `dgram`'s shape**

`dgram.Socket` is an `EventEmitter`, not a stream. `send` takes a completion callback; `bind`
emits `'listening'`. Match those shapes exactly — `k-rpc` depends on them.

- [ ] **Step 3: Run the gate**

Look up a well-known, heavily-seeded infohash over DHT with trackers disabled.

**PASS** = the DHT emits `peer` events for the infohash within 60 seconds, over shimmed
`dgram`, with `tracker: false`. Record the peer count.

**FAIL** = stop. DHT is how `ADR-0001`'s "ordinary torrents" claim is met without trackers.
Record whether the failure is the shim or NAT — a machine behind symmetric NAT can fail DHT for
reasons unrelated to the shim, so **re-run once from a second network before calling it**.

- [ ] **Step 4: Commit**

```bash
git add spike/ && git commit -m "Gate 1b: DHT lookup completes over the shimmed dgram"
```

---

## Task 5 — GATE 2: the shell tree is free of native modules

**Files:**
- Modify: `package.json` (confirm `webtorrent` is not a shell dependency)
- Create: `spike/results/gate-2.json`

- [ ] **Step 1: Audit the shell tree**

```bash
rm -rf node_modules package-lock.json
npm install --omit=optional
npm run check:natives
npm ls node-datachannel bufferutil utf-8-validate fs-native-extensions 2>&1 | tee spike/results/gate-2.txt
```

- [ ] **Step 2: Audit the *app-asset* tree separately**

The renderer bundle is a different tree from the shell. Build it and confirm
`node-datachannel` is absent from the output, not merely absent from `node_modules`:

```bash
npm run build
grep -rl "node-datachannel\|libdatachannel" out/renderer/ || echo "absent — good"
```

- [ ] **Step 3: Record the verdict**

**PASS** = `check:natives` exits 0 on the shell tree **and** the built renderer bundle contains
no `node-datachannel` reference.

**Note the `--omit=optional` asymmetry**: npm installs optional dependencies *by default*, so a
plain `npm install` on a contributor's machine may pull artefacts this audit skipped. Record
both runs. If they differ, the `postinstall` guard is what protects run-from-source, and that is
already in place from Task 1.

- [ ] **Step 4: Commit**

```bash
git add spike/results package.json
git commit -m "Gate 2: shell dependency tree is free of native build artefacts"
```

---

## Task 6 — GATE 3: video plays, with seeking

**Files:**
- Create: `spike/renderer/gate-3.ts`, `spike/renderer/player.html`
- Modify: `spike/main/broker.ts` (register the custom scheme, if that path is chosen)

- [ ] **Step 1: Try the service-worker path first**

Newly confirmed and not in any project document: `client.createServer(opts, force)` takes
`force: 'browser' | 'node'`, documented for *"environments which run both Node and Browser like
NW.js or Electron"* — which is exactly this situation, and without it webtorrent may pick the
Node implementation and try to open a real listening socket.

```ts
const controller = await navigator.serviceWorker.register('./sw.min.js', { scope: './' })
await navigator.serviceWorker.ready
client.createServer({ controller }, 'browser')
const file = torrent.files.find(f => f.name.endsWith('.mp4'))
file.streamTo(document.querySelector('video')!)
```

This is renderer-local and origin-scoped, so no other local process can reach it — strictly
stronger than the token mitigation `security-model.md` T15 describes for a localhost server.

- [ ] **Step 2: If service workers do not register, fall back to `protocol.handle`**

A custom scheme must be registered **before** `app.whenReady()`, with
`{ standard: true, secure: true, supportFetchAPI: true, stream: true }`, and the handler must
honour `Range` and return `206` with `Content-Range` — Chromium will not seek otherwise.

- [ ] **Step 3: Run the gate**

Play a **named, pinned** MP4/H.264 torrent — the same one `build-plan.md` requires for the
release checklist, so the fixture is chosen once.

**PASS** = the file plays end to end, **and** seeking to 75% starts playback there within
5 seconds without restarting the download from zero. Record time-to-first-frame; the clip
depends on it and a 40-second wait is a different product from a 4-second one.

**FAIL** = stop, but note that this gate's failure is the *least* architectural of the four.
Record whether the failure was registration, range handling, or codec.

- [ ] **Step 4: Commit**

```bash
git add spike/ && git commit -m "Gate 3: MP4/H.264 plays with seeking through the renderer path"
```

---

## Task 7 — GATE 4: throughput

**Files:**
- Create: `spike/fixtures/control.mjs`, `spike/renderer/gate-4.ts`, `spike/results/gate-4.json`

- [ ] **Step 1: Measure the control**

The same webtorrent version, same fixture, same local seeder, running **natively in Node** with
no shim. Without this number, "25 Mbps" measures the machine and the disk, not the shim.

```bash
node spike/fixtures/seeder.mjs 512 &
node spike/fixtures/control.mjs      # → { mbps, peakRssMb, durationSec }
```

- [ ] **Step 2: Measure the shimmed path**

Identical fixture, through the renderer, **through the `contextBridge` closures** — not through
a raw port. `capability-api.md` is explicit: measuring the raw port measures something the
product cannot ship.

- [ ] **Step 3: Record every sub-criterion separately**

`build-plan.md` requires this, because CPU-bound, latency-bound and architecturally-impossible
have different fallbacks:

| Sub-criterion | Pass |
|---|---|
| Relative throughput | shimmed ≥ 60% of control |
| Absolute throughput | ≥ 25 Mbps |
| Concurrent sockets | ≥ 100 |
| Main-process CPU | headroom intact; no renderer frame drops |
| Memory | RSS stable across 10 minutes |

- [ ] **Step 4: If it fails, try batching — but not transferables unless Gate 0 allowed them**

64–256 KB batching is available regardless. Transferable `ArrayBuffer`s are available **only if
Task 2 recorded `transfer.ok: true`**. If Gate 0 found transfers unavailable, say so in the
verdict rather than reporting a generic throughput failure — they are different findings with
different fixes.

- [ ] **Step 5: Commit**

```bash
git add spike/ && git commit -m "Gate 4: throughput measured against a native control"
```

---

## Task 8: Write the verdict, and the skill

**Files:**
- Create: `docs/planning/spike-verdict.md`
- Create: `.claude/skills/orivon-electron/SKILL.md`
- Modify: `docs/planning/build-plan.md`, `docs/architecture/capability-api.md`, `CLAUDE.md`

- [ ] **Step 1: Write the verdict**

PASS or FAIL, per gate, with the recorded numbers and a link to each `spike/results/*.json`.
State plainly which gate stopped it, if one did.

- [ ] **Step 2: Fold corrections back into the specs**

At minimum, already known before the spike starts:
- webtorrent is **3.0.21**, not 2.x (`build-plan.md`, `CLAUDE.md`)
- the `browser` field map is wider than documented, and `dgram` is not in it
- whatever Gate 0 concluded about transferable `ArrayBuffer`s
  (`capability-api.md` §Throughput)
- `createServer`'s `force` parameter (`build-plan.md` §5)

- [ ] **Step 3: Write the project skill**

`CLAUDE.md` requires this: webtorrent resolution overrides, `MessagePortMain` transfer
behaviour, the custom-scheme media path. That knowledge exists nowhere else.

- [ ] **Step 4: Delete the throwaway code**

```bash
git rm -r spike/ && git commit -m "Remove the week-0 spike; findings live in spike-verdict.md"
```

Keep `spike/results/` by moving it to `docs/planning/spike-results/` first — the numbers are
the evidence for the verdict and they outlive the code that produced them.

---

## Self-review against the spec

**Spec coverage.** `build-plan.md` §Week 0 lists four ordered checks; they are Tasks 3+4, 5, 6
and 7. The `electron#34905` verification it requires "first" is Task 2. The scaffold, test stack
and CI job it puts in week 0 are Task 1. The `postinstall` native check it asks for is Task 1
Step 3. The day-1-naive → day-2-batched structure is Task 7 Step 4.

**One deliberate deviation.** `build-plan.md` also puts the `createBroker({ dial, resolve, now,
fs, keychain })` structural decision in week 0. It is **not** in this plan: it shapes the real
broker, which is build step 2, and putting it in throwaway spike code would either bloat the
spike or bake a design decision into code that gets deleted. It belongs in the first task of
build step 2.

**Not covered here, by design.** A10's handle contracts and A11's cached-bundle origin are owner
decisions taken on 2026-08-25 and are prerequisites for build step 2, not for the spike. A11 is
recorded in `ADR-0007`; A10's full specification is the next writing task.

**Gate ordering rationale.** Gate 0 is new. Every other gate is in the order
`build-plan.md` fixed, and the reason for each ordering is that a failure changes the
architecture in a way that would waste the work of the gates after it.
