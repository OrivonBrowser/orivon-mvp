# `src/main/`: the Electron main process

**What lives here.** The browser shell: the window, tabs, the omnibox, shell IPC, and the
subsystem registry every other stream plugs into, one directory per job
([`ADR-0023`](../../docs/decisions/ADR-0023-src-main-is-organised-by-job.md)). `start.ts`
(the process entry: it takes the single-instance lock before `index.ts`, the rest of the browser, is loaded),
`index.ts`, `registry.ts`, `subsystems.ts` and `channels.ts` stay at the top level: `registry.ts` and
`channels.ts` are the seam other packages import as values; `published-slot.ts` is the one-time slot behind each field `registry.ts` lists.

**Tied to Electron, entirely.** Only the pure `<name>.ts` files run under plain vitest.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. Main and the renderer
communicate over IPC, never by sharing modules.

**A promise started and let go needs a rejection handler.** `start.ts` ends the whole browser on any
unhandled rejection, so `void work()` or a bare `work()` that can reject takes every tab with it. End
the chain with `.catch((error: unknown) => { console.error('[area] what failed:', error) })`, or await
it; `npm run check:floating-promises` lists the rest (this folder and everything it imports).

**Owner stream.** `shell`. Maintenance only; other streams add themselves via `subsystems.ts`
rather than editing here.

## The directories

One directory per job. `node scripts/ai/code-map.mjs src/main` prints each with what it is for, read from
the tree. A directory's own `README.md` says what it depends on and where it touches `electron`.

### The organising rule

The folder says **what job**; the filename suffix says **which layer**. ADR-0023 says why a
decision and its dialog share a folder.

| Suffix | Meaning |
|---|---|
| `<name>.ts` | The decision. No `electron` import, unit-tested under plain vitest |
| `<name>-prompt.ts` | The question that shows it, asked through `askQuestion` into the panel of the tab it belongs to ([`shell/question/`](shell/question/)). Leave this page opens a native box for now; `npm run check:native-dialogs` lists it |
| `<name>-subsystem.ts` | Registers it into the running app via `registry.ts` |
| `<name>-runner.ts` | The real I/O around it |

## Two things not to rediscover

**`webPreferences` is load-bearing.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` keep the preload's port out of the page
([`security-model.md`](../../docs/architecture/security-model.md) T17). A hookify rule rejects
edits that weaken them.

**`BaseWindow`, not `BrowserWindow`.** The shell composes a chrome view plus tab views;
`BrowserWindow` holds one full-size web view.

**Main and preload are CommonJS; only the renderer is ESM.** A sandboxed preload has no ESM
context, so the preload must be CJS, and main matches it to avoid a two-format build. An ESM main
does work in Electron 44, if a reason to switch appears.

## Design notes

**[`index.ts`](index.ts): do not add `ozone-platform: x11`.** The GPU process segfaults under
XWayland and the window stops rendering. "No window appears" is
[`shell/window.ts`](shell/window.ts)'s `showOnce` (`ready-to-show` is unreliable from the dev
server); the `orivon-electron` skill has the rest.
