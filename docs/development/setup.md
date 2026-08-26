# Setup

## Prerequisites

- **Node.js `>=22.12.0`.** CI runs Node 24; either works.
- **git.**

That is the whole list. **No compiler, no Python, no CMake, no Visual Studio Build Tools.**

That is not an accident, and it is worth understanding before you add a dependency: Windows and
macOS are supported from day one via *run from source* rather than signed installers, which
sidesteps SmartScreen and Gatekeeper without buying certificates. If `npm install` ever needs
`node-gyp`, run-from-source becomes a worse wall than the certificate it was meant to avoid. So
**pure-JS dependencies only** ([`CLAUDE.md`](../../CLAUDE.md) Rule 8), enforced automatically —
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
loudly** — the process starts, exits cleanly, prints nothing unusual. Tests hang, or pass
against nothing at all.

*(The machine this project was developed on has it set in `~/.bashrc`, which is how it was
found.)*

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
| `npm run smoke` | Builds, then drives the **real** shell with real clicks. Slow, and the only check that proves a window appears |

Before opening a pull request:

```bash
npm run typecheck && npm test && npm run check:natives && npm run check:contracts
npm run smoke     # only if you touched src/main/
```

**Reading `npm run smoke` output:** it prints a JSON result and a failure list. **Read those,
not the exit code alone.**

---

## Platform notes

**Linux is the packaged target** — AppImage and deb. No code-signing cost, and the audience
skews Linux. `deb` is the primary artefact, because only a `.desktop` file registered by an
installed package can become the default browser via `xdg-settings`, and the success metric is
measured in daily-driver hours.

**Windows and macOS are supported from day one via run-from-source.** Those users count toward
the metric and their telemetry must work identically. Two constraints follow, and neither is
optional:

1. Pure-JS dependencies only (above).
2. **No platform-specific paths.** All storage goes through `app.getPath('userData')`, never a
   hardcoded XDG path ([`ADR-0003`](../decisions/ADR-0003-local-first-storage.md)). A hookify
   rule warns on hardcoded storage paths.

**`safeStorage` differs per platform:** Keychain on macOS, DPAPI on Windows, and on Linux it
needs an available keyring — `isEncryptionAvailable()` returns false otherwise. A documented
fallback is required, and the seed must never be silently written in plaintext. Test it with:

```bash
npm run dev -- --password-store=basic
```

---

## Editor

Nothing is required. TypeScript is the only language ([`ADR-0002`](../decisions/ADR-0002-capability-api-is-the-durable-asset.md)),
`tsconfig.json` is strict, and any editor with a TypeScript server will do. `.vscode/` and
`.idea/` are git-ignored, so bring your own.
