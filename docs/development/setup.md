# Setup

## Prerequisites

- **Node.js `>=22.12.0`.** CI runs Node 24; either works.
- **git.**

That is the whole list. **No compiler, no Python, no CMake, no Visual Studio Build Tools.**

That is not an accident, and it is worth understanding before you add a dependency: Windows and
macOS are supported from day one via *run from source* rather than signed installers, which
sidesteps SmartScreen and Gatekeeper without buying certificates. If `npm install` ever needs
`node-gyp`, run-from-source becomes a worse wall than the certificate it was meant to avoid. So
**no native modules in Orivon's own dependencies** ([`CLAUDE.md`](../../CLAUDE.md) Rule 8), enforced
automatically;
see `check:natives` below.

## Install and run

```bash
git clone https://github.com/OrivonBrowser/orivon-mvp.git
cd orivon-mvp
npm install
npm run dev
```

A window should appear. If it does not, read the next section before debugging anything else.

---

## The `ELECTRON_RUN_AS_NODE` trap

**Read this even if nothing has gone wrong yet. It is the single most expensive thing in this
repository to discover by debugging.**

If `ELECTRON_RUN_AS_NODE=1` is set anywhere in your shell environment, the Electron binary runs
as **plain Node**: no window, no renderer, no `MessagePortMain`. And it **does not fail
loudly**: the process starts, exits cleanly, prints nothing unusual. Tests hang, or pass
against nothing at all.

*(Check `~/.bashrc`: that is where it is set on the machine this project is developed on.)*

Check yours:

```bash
echo "${ELECTRON_RUN_AS_NODE:-not set}"
```

**Never launch Electron directly.** Use [`test/launch-electron.mjs`](../../test/launch-electron.mjs),
which strips the variable and verifies the launch is real. `npm run dev` and `npm run smoke` are
already safe.

Background: [`.claude/skills/orivon-electron/SKILL.md`](../../.claude/skills/orivon-electron/SKILL.md).

---

## The scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload. This is the one you want |
| `npm run build` | Builds `main`, `preload` and `renderer` into `out/` |
| `npm start` | Runs the built output, without the dev server |
| `npm run typecheck` | `tsc --noEmit`. The compiler is the primary correctness check here |
| `npm test` | Vitest, `environment: 'node'`. Unit tests only, no DOM |
| `npm run check:natives` | **Rule 8.** Fails if any dependency needs a compiler. Also runs automatically on `postinstall` |
| `npm run check:contracts` | Fails if `src/contracts/` is incomplete or references anything outside itself |
| `npm run check:secrets` | Fails if a credential is in a git-tracked file. **This repo is public**, so run `git config core.hooksPath .githooks` once, and it also runs before every commit |
| `npm run smoke` | Builds, then drives the **real** shell with real clicks. Slow, and the only check that proves a window appears |

Before opening a pull request:

```bash
npm run typecheck && npm test && npm run check:natives && npm run check:contracts
npm run smoke     # only if you touched src/main/
```

**Reading `npm run smoke` output:** it prints a JSON result and a failure list. **Read those,
not the exit code alone.**

---

## The no-focus switch

`npm run dev`, `npm run smoke` and `npm run test:e2e` open a real Electron window without taking
OS keyboard focus, so a build or test run does not interrupt whatever you are typing in another
window. If a window flashes on screen but your cursor and keystrokes stay wherever they already
were, that is this working as intended, not a bug.

Mechanism: `src/main/shell/window.ts`'s `showOnce()` calls `win.showInactive()` instead of `win.show()`
when `ORIVON_WINDOW_NO_FOCUS=1` is set. It is **never** set for a real user's own launch
(`npm start`, or a packaged build). Only:

- `npm run dev`, via `scripts/dev.mjs`;
- every Electron launch made through [`test/launch-electron.mjs`](../../test/launch-electron.mjs),
  which both `npm run smoke` and `npm run test:e2e` go through, so this holds even running a
  single e2e file directly (`npx vitest run --config test/vitest.e2e.config.ts test/some-file.
  test.ts`), bypassing the npm scripts below entirely.

`npm run smoke` and `npm run test:e2e` go a step further on Linux:
[`scripts/run-headless.mjs`](../../scripts/run-headless.mjs) runs them under a fresh virtual
display (`xvfb-run -a`) automatically, whenever `xvfb-run` is on `PATH`, so nothing appears on a
real screen at all, not even briefly. **On macOS, on Windows, or a Linux box that never installed
`xvfb-run`, they still run**, just directly, relying on the no-focus switch above instead of a
virtual display. Either way, typing a plain `npm run smoke` or `npm run test:e2e` with no wrapper
is safe to do while you are working.

With `ORIVON_PRIVATE_BUS=1`, `run-headless.mjs` also gives the command a D-Bus session bus of its
own (`dbus-run-session`, started inside `xvfb-run`) and refuses to run if it cannot; the
notification phase of `test/e2e-site-permissions.test.ts` runs only under it. It is not the
default, because a whole suite on a private bus would lose the keyring that `safeStorage` reads.

### `npm run dev` deliberately does not pass `--watch`

`electron-vite dev` only rebuilds the main process and the preloads when `-w`/`--watch` is
passed (confirmed in `node_modules/electron-vite/dist/cli.js`, which sets a build `watch`
config on that flag and not otherwise). `scripts/dev.mjs` does **not** pass it.

The flag makes the app **restart on every `src/main/` or `src/preload/` edit**, and a restart
destroys and recreates the window. `ORIVON_WINDOW_NO_FOCUS` stops that window taking the
keyboard; nothing stops it *appearing*. With an agent editing main-process files while a dev
server is running, that is a window popping back onto the owner's desktop every few seconds.
The convenience is not worth the interruption.

What this costs you, and the failure it looks like: **a main-process or preload edit does not
show up until you restart `npm run dev`.** The renderer still hot-reloads, so a change that
spans both halves goes half-applied: the 2026-09-15 collapsing bookmarks bar rendered as a
dead 28px band of chrome, because the renderer had hidden the row while main was still
reserving space for it. That reads as a bug in the feature. Restart before believing it.

Related: `.claude/hookify.window-focus.local.md` blocks an agent from starting any Electron
process that is not wrapped in `scripts/run-headless.mjs`. Starting a dev server is the owner's
action.

**Not a substitute for `xvfb-run` in the fleet/unattended-run protocol**
([`unattended-run-protocol.md`](../../.claude/unattended-run-protocol.md)): that policy wraps every launch
externally as a process-hygiene guarantee independent of what the code under test does, and still
applies to any automated/unattended run. Doubling up, with an external `xvfb-run -a npm run test:e2e`
around a command that now also wraps itself, is harmless (confirmed empirically: a nested
`xvfb-run` just opens a second virtual display on top of the first), so no existing convention
needed to change.

Debugging: `echo "${ORIVON_WINDOW_NO_FOCUS:-not set}"` inside whatever launched `electron-vite` or
`test/launch-electron.mjs` tells you whether it is active for that run.

---

## Developer origins

A page served from your own static server on loopback (`127.0.0.1`, `[::1]` or a `localhost`
name) needs neither variable below: in every build, `npm start` and a packaged one included, its
`<link rel="orivon-manifest">` hint raises the consent prompt, and the origin is granted without
being installed (`src/main/install/grant-without-install.ts`). The grants last the session.

Two environment variables, both off unless you set them. `npm run dev` sets the first; nothing
sets the second for you.

| Variable | What it turns on |
|---|---|
| `ORIVON_DEV_ORIGINS=1` | Developer mode (`src/main/dev/dev-mode.ts`): a `.eth` name from the file below may be granted capabilities **without being installed**, over `http:` only, and Inspect Element appears in the context menu. It is also the master switch for the row below |
| `ORIVON_ETH_NAMES_FILE=<path>` | A JSON file of `{"name.eth": port}` that `src/main/dev/eth-resolver.ts` reads and `src/main/verifier/` turns into Chromium DNS overrides, ahead of every other `.eth` name, so `http://name.eth` reaches `127.0.0.1:<port>`; typing such a name in the address bar opens it over `http:`. Ignored unless `ORIVON_DEV_ORIGINS=1` is also set. `orivon-ports`' `orivon-port names` writes this file, and its `serve` and `run` rewrite it from every recipe on each start; nothing points the shell at it for you, and the shell reads it once, at its own startup |

A name in that file is also declared a **secure context**, which is not cosmetic. Its origin is
plain `http:` on a non-loopback host, and Chromium judges trustworthiness by the origin, not by
where the name resolves -- so without that declaration the page loses `crypto.subtle`,
`crypto.randomUUID`, service workers and `navigator.clipboard` outright, while the identical
bundle at `127.0.0.1` keeps all four because loopback is exempt by host. Only names the resolver
also mapped are declared, so a malformed entry is dropped from both.

This is a development convenience layered over the capability boundary, never part of it. An
installed app needs none of it: its origin is really `https:` (`ADR-0007`).

---

## `.eth` names and the light client

Every other `.eth` name is served by the verifier (`ADR-0030`): a utility process that proves the
name with an Ethereum light client and checks every IPFS block it serves. The light client starts
once the first page has loaded and contacts the servers `src/main/verifier/endpoints.ts` lists;
Settings shows what it is doing.

| Variable | What it does |
|---|---|
| `ORIVON_ETH_LIGHT_CLIENT=off` | Keeps the light client from starting, so the run contacts no Ethereum server and every real `.eth` name fails closed. `test/launch-electron.mjs` sets it for every smoke and e2e launch unless a test asks otherwise |
| `ORIVON_LIVE_ETH=1` | Runs `src/verifier-host/light-client/tests/live-ens.test.ts`, which resolves real names through the light client against mainnet. Skipped otherwise |
| `ORIVON_TEST_ETH_FIXTURES`, `ORIVON_TEST_IPFS_GATEWAYS`, `ORIVON_TEST_DOH` | Test builds only (`npm run test:e2e` builds one): `.eth` names mapped to content with no light client, and the gateway and DNS-over-HTTPS endpoints to fetch it from. An ordinary build contains none of this (`npm run check:dev-grant-absent`) |

Each release ships a checkpoint for the light client, refreshed with
`node scripts/refresh-eth-checkpoint.mjs --write` before tagging: it refuses unless two beacon APIs
agree. An install keeps a newer one of its own after every sync, and refuses any checkpoint older
than 14 days.

---

## Platform notes

**Linux is the packaged target**: AppImage and deb. No code-signing cost, and the audience
skews Linux. `deb` is the primary artefact, because only a `.desktop` file registered by an
installed package can become the default browser via `xdg-settings`, and the success metric is
measured in daily-driver hours.

**Windows and macOS are supported from day one via run-from-source.** Those users count toward
the metric and their telemetry must work identically. Two constraints follow, and neither is
optional:

1. No native modules in Orivon's own dependencies (above).
2. **No platform-specific paths.** All storage goes through `app.getPath('userData')`, never a
   hardcoded XDG path ([`ADR-0003`](../decisions/ADR-0003-local-first-storage.md)). A hookify
   rule warns on hardcoded storage paths.

**`safeStorage` differs per platform:** Keychain on macOS, DPAPI on Windows, and on Linux it
needs an available keyring, and `isEncryptionAvailable()` returns false otherwise. A documented
fallback is required, and the seed must never be silently written in plaintext. Test it with:

```bash
npm run dev -- --password-store=basic
```

---

## Editor

Nothing is required. TypeScript is the only language ([`ADR-0002`](../decisions/ADR-0002-capability-api-is-the-durable-asset.md)),
`tsconfig.json` is strict, and any editor with a TypeScript server will do. `.vscode/` and
`.idea/` are git-ignored, so bring your own.
