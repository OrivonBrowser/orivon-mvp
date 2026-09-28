# `src/main/`: the Electron main process

**What lives here.** The browser shell: the window, tabs, the omnibox, shell IPC, and the
subsystem registry every other stream plugs into, one directory per job
([`ADR-0023`](../../docs/decisions/ADR-0023-src-main-is-organised-by-job.md)). `index.ts`,
`registry.ts`, `subsystems.ts` and `channels.ts` stay at the top level: `registry.ts` and
`channels.ts` are the seam other packages import as values.

**Tied to Electron, entirely.** Only the pure `<name>.ts` files run under plain vitest.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. Main and the renderer
communicate over IPC, never by sharing modules.

**Owner stream.** `shell`. Maintenance only; other streams add themselves via `subsystems.ts`
rather than editing here.

## The directories

| Directory | Job | Holds state? | Imports `electron`? |
|---|---|---|---|
| [`shell/`](shell/) | The window and the views inside it | the tab collection | yes |
| [`browsing/`](browsing/) | What the address bar and tab strip are made of | bookmarks on disk | `favicon.ts` only |
| [`ipc/`](ipc/) | The chrome-to-main channels, one sender check each | no | yes |
| [`consent/`](consent/) | Decide what to ask, say it in words, show the dialog | no | the `-prompt` files only |
| [`permissions/`](permissions/) | The grant list a person can revoke from, and the per-site popover | no | the two `-panel` files and `popover-view.ts` |
| [`install/`](install/) | A hinted manifest becomes a registered, consented app | per-origin queue | the `-subsystem` file, `manifest-hint.ts`, `granted-origin-csp.ts` |
| [`sessions/`](sessions/) | What an Electron `Session` is allowed to do | each site's notification answer | `permission-gate.ts`, `web-context-host.ts` |
| [`keyring/`](keyring/) | The identity seed, OS-keyring-backed or session-only | the encrypted seed file | `electron-keychain.ts` only |
| [`self-update/`](self-update/) | Check, notify, never install | last-check timestamp | `-runner` only |
| [`dev/`](dev/) | Dev only: inert, gated, or compiled out | no | `local-ddoc.ts` only, lazily |
| [`verifier/`](verifier/) | Start the `.eth` verifier, trust its certificate, choose its checkpoint | host process, checkpoint, IPNS sequences | `verifier-subsystem.ts` only |
| [`embed/`](embed/) | The pages an app shows inside itself, in a `<webview>` (`ADR-0039`) | which app owns which guest | `embed-host.ts` and `embed-subsystem.ts` only |
| [`extensions/`](extensions/) | Install, register and load Chrome extensions | the installed-extension registry | all but `crx.ts`, `crx3-format.ts`, `registry.ts` and `unpack-runner.ts`'s pure half |

### The organising rule

The folder says **what job**; the filename suffix says **which layer**. ADR-0023 says why a
decision and its dialog share a folder.

| Suffix | Meaning |
|---|---|
| `<name>.ts` | The decision. No `electron` import, unit-tested under plain vitest |
| `<name>-prompt.ts` | The native `dialog.showMessageBox` that shows it |
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
