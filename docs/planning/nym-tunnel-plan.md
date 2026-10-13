# Nym as the built-in tunnel: plan

**Need.** The owner decided that Orivon ships a Nym mixnet tunnel. It is the default tunnel for
installed apps, and a person can choose their own SOCKS5 address (Tor, say) instead. The tunnel
for apps (`docs/planning/per-app-route-plan.md`, ADR-0080) already carries everything a routed
app sends through one SOCKS5 server, TCP and UDP, and refuses what that server cannot carry. This
step gives it a server inside Orivon: Nym's mixnet client, run as WebAssembly in a process of its
own, so it works without anything else installed and with no tab kept open.

**The door stays the same.** The Nym tunnel offers SOCKS5 (CONNECT and UDP ASSOCIATE) on a
loopback port, behind a secret, exactly as a person's own SOCKS5 server does. The tunnel for apps
uses it with no change to its routing. Any other tunnel provider can be added the same way.

## What exists

- **The client, proven (Step 0 of this plan, done).**
  - **Source:** Nym's `wasm/smolmix` crate, at tag `nym-binaries-v2026.20-glasgow` (commit
    `28904698fd68337cc722d51ab21f29f4fd6c56ce`).
  - **Patch:** a 179-line patch adds wasm-bindgen exports:
    - `connectTcp(host, port)` returns `read()` (a chunk, or `null` at the end), `write(bytes)`
      and `close()`;
    - `bindUdp()` returns `sendTo(host, port, bytes)`, `recv(timeoutMs?)` and `close()`;
    - `mixDNS(host)` already exists.

    Names are resolved through the mixnet, never on this computer.
  - **Build:** `wasm-pack build --target web` gives a 9.4 MB `.wasm` (2.55 MB gzipped) and its JS
    glue.
  - **Measured under Node 24, three runs:**
    - a TLS 1.3 page load and a UDP DNS query both crossed the mixnet, with a different exit
      address from the direct one every time;
    - the tunnel came up in 3.2 to 7.9 s;
    - a first HTTPS GET took 5.4 to 6.2 s, a warm one 4.5 to 6.3 s;
    - a UDP round trip took 0.5 to 1.2 s.
  - **Licences:** all of it is Apache-2.0, MIT, BSD, ISC, 0BSD, MPL-2.0 (two crates) or
    CDLA-Permissive-2.0. There is no GPL.
- **What the module needs:** `WebSocket` (to Nym's gateways), `fetch` (Nym's directory), `indexedDB`,
  `crypto.getRandomValues`, timers, and `self` and `WorkerGlobalScope` present. Electron 44's
  utility process (Node 24.18) has all of them except `indexedDB`; `fake-indexeddb` (MIT, pure
  JavaScript) supplies it, in memory. One tunnel per module instance.
- **The tunnel for apps.**
  - `src/broker/route/`: the SOCKS5 provider, with each app's own isolation credentials.
  - `src/main/route/`: the store, the fronts, the sessions, the Settings row and the switch.
- **A supervised utility process to reuse.** `src/main/verifier/host-supervisor.ts`, the local
  nodes' pinned-file check (`local-node-artifact.ts`) and their fetch script
  (`scripts/fetch-local-nodes.mjs`, `resources/<name>/<name>.json`). The local-node host itself
  (`src/protocols/local-node/`) runs WASI 0.2 components through jco; this module is wasm-bindgen
  output, so it gets a host of its own.

## Design

### The artifact (durable; built outside the app, pinned by hash)

- `vendor/nym-smolmix/`:
  - the patch;
  - `UPSTREAM.md`: the tag, the commit, the licence and the NOTICE;
  - a build script that clones the tag, applies the patch and runs the crate's own
    `wasm-pack` build with the `wasm-bindgen` version its lockfile pins.

  Building needs rustup and the `wasm32-unknown-unknown` target. That is a developer step, never
  part of `npm install`.
- **Publish:** the output (`.wasm`, JS glue, `LICENSE`, `NOTICE`) on the owner's VPS IPFS node,
  pinned, with its summary file updated (CLAUDE.local.md section VPS).
- **Manifest:** `resources/nym-tunnel/nym-tunnel.json` pins the CID and each file's size and sha256.
  `scripts/fetch-local-nodes.mjs` learns this folder too: widen its folder rule rather than
  renaming the tunnel a node. A build made before the artifact is published has Nym off, and the
  reason is shown.

### The Nym host (tied to Electron: a utility process entry), `src/protocols/nym-tunnel/`

| File | Holds |
|---|---|
| `entry.ts` | The process. It takes `start{ moduleDir, port, secret }`, installs the globals the module needs (`self`, a `WorkerGlobalScope` class, `fake-indexeddb` in memory), loads the glue and the `.wasm` from the pinned directory, and posts `listening`, `ready`, `failed` and `instances` |
| `socks-server.ts` | SOCKS5 on `127.0.0.1:<port>`: username/password only (the password must equal the secret, compared in constant time), CONNECT by name or literal, and UDP ASSOCIATE with the relay on loopback. No BIND. No other method. Use a maintained pure-JavaScript server if one handles UDP ASSOCIATE; otherwise write this small one, and say why in the README (Rule 6) |
| `instances.ts` | One tunnel per SOCKS5 username, so each routed app gets its own mixnet client and exit, as Tor isolates circuits by credentials. An instance starts at its first request, the request waiting for it (30 s at most, then refused), and closes after 10 minutes unused. A cap on live instances is set from Step 1's memory figure. Past the cap, a new app is refused, `unreachable` and saying why; it never shares another app's tunnel |
| `module-net.ts` | The module's own network: `fetch` and `WebSocket` wrapped so that only `https:` and `wss:` to public unicast addresses (`src/broker/policy/address.ts`) pass. Nothing else leaves this process |
| `protocol.ts`, `README.md` | The messages, plain data; what this folder may import (`../../broker/policy/`, never `src/main/`) |

**Why a utility process** goes in an ADR (the next free number). It follows ADR-0078: this is not
app code but WebAssembly pinned by hash, whose glue is generated at our build and reaches only the
globals the entry hands it. A crash ends this process, never main.

### Main side (tied to Electron), `src/main/route/`

- **`nym-subsystem.ts`.** It starts the host through `HostSupervisor` when the first routed app on
  Nym needs it, and stops it 10 minutes after the last one goes. It picks a quiet loopback port
  and a fresh secret per start. Restarts follow the supervisor's backoff.
- **The tunnel choice.** The setting `network.route.kind` is `'nym' | 'socks5'`, `'nym'` by default
  (an existing stored address with no kind keeps `'socks5'`). For Nym, the route's provider is the
  existing SOCKS5 provider pointed at the host's port, with each app's isolation username and the
  secret as password. The routing, the fronts, the fail-closed rules and the leaving question are
  untouched.
- **A system proxy configured:** Nym does not start, because its own connections to Nym's gateways
  would go around the proxy. The reason is shown, as the Swarm node does (T20).
- **Status.** The host's `ready` and `failed` reach the Settings row and the site-info popover:
  "Connecting to Nym…", "Nym tunnel ready", "Nym is not answering". While the tunnel comes up, a
  routed app's requests wait for it, and they fail if it does not.

### Settings and UI

The Settings row for the tunnel becomes a choice, "Nym (built in)" or "Your own SOCKS5 address",
with the address field shown only for the second. Its Test action brings Nym up and resolves a
name through it, and says how long that took. The app card's switch and the leaving question are
unchanged. Name Nym plainly (the owner's call).

## Step 1: the host in a real utility process, before building the rest

Through `node scripts/run-headless.mjs`, with a scratch `--user-data-dir`, fork a utility process
that loads the built module with the globals above.

1. A TLS GET to `https://api.ipify.org` through `connectTcp` returns an address that is not the
   direct one.
2. A UDP DNS query through `bindUdp` is answered.
3. The process's resident memory: idle, then with one tunnel up, then with two. This sets the cap.
4. Two instances in one process give two different exit addresses.

**If 1 or 2 fails in a utility process, stop and report**: the plan changes.

## Tests

- **Unit, written first:**
  - `socks-server.ts`, driven by the existing `socks` client: a wrong secret refused, CONNECT, UDP
    ASSOCIATE, no BIND;
  - `instances.ts`: lazy start, wait, idle close, cap;
  - `module-net.ts`: private and loopback refused;
  - the tunnel choice and its default;
  - the subsystem's lifecycle.
- **End to end (hermetic):** a fake module with the same exports, which connects locally,
  selected through the fetch script's `ORIVON_<NAME>_DIR` seam.
  - A routed fixture app on Nym reaches its fixture targets through the host's SOCKS5 server,
    proven by the fake module's log.
  - With the fake module failing to start, the app fails closed.
  - Add a catalogue row if an app-facing behaviour changes, and a `CHANGELOG.md` line.
- **Live, opt-in** (`ORIVON_NYM_LIVE=1`, never in CI): the real module, and a routed app whose
  `https` fetch sees the mixnet exit address.
- **Cross-OS:** `node scripts/ci/cross-os.mjs` in the background once it builds. A utility process
  must load the module on Windows and macOS.

## Docs

- The ADR above.
- `security-model.md`: a row for the Nym host, covering:
  - its network seam;
  - the secret;
  - per-app instances;
  - that Nym's gateways see this computer's address while the destinations see only the exit;
  - and T84's provider sentence.
- `ARCHITECTURE.md`: the new process, labelled tied to Electron.
- `src/protocols/README.md`, `docs/features.md`, `docs/roadmap.md` and the compatibility matrix.

## PRs

1. **`stream/nym-artifact`:** `vendor/nym-smolmix/`, the build script, the publish, the manifest and
   the fetch script's wider folder rule.
2. **`stream/nym-tunnel`:** Step 1, then the host, the main side, the setting, the UI, the tests
   and the docs. Split it if it grows past review size.

Each PR gets `typecheck`, `test:changed`, the `check:*` guards, the specs `select-e2e.mjs` names,
`/code-review` and `/security-review`. The second also gets the QA `orivon-qa` names. After both:
`adversarial-reviewer` on the host and the route.

## Not in this step

- Offering the patch upstream to Nym (the owner's call, since it is outward-facing).
- Routing Orivon's own `.eth` and IPFS loading through the tunnel.
- Ordinary websites.
- Nym's paid bandwidth credentials: the mixnet answers without them today. If that changes, the
  Nym choice says so and refuses, never going direct.
