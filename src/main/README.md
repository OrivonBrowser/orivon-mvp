# `src/main/`: the Electron main process

**What lives here.** The browser shell: the window, tab management, the omnibox, shell IPC, and
the subsystem registry every other stream plugs into. Fifteen directories, each named for the job
it does; `## The directories` below is the index.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. The main process and the
renderer communicate over IPC, never by sharing modules.

**Owner stream.** `shell`, build step 1, **done**. Maintenance only; other streams add
themselves via `subsystems.ts` rather than editing here.

## The directories

`index.ts`, `registry.ts`, `subsystems.ts` and `channels.ts` stay at the top level: they belong
to no single job, and `registry.ts`/`channels.ts` are the seam other packages
(`src/broker/transport/ipc.ts`, `src/loader/subsystem.ts`, every `src/preload/` file) import as
**values**, so keeping them visible at the top is the point, not an exemption.

| Directory | Job | Holds state? | Imports `electron`? |
|---|---|---|---|
| [`shell/`](shell/) | **Compose**: the window and the views inside it | yes, the tab collection | yes |
| [`pages/`](pages/) | **Serve**: the shell's own pages at `orivon://`, in a session only they can load, and the one channel they speak on | which webContents are which page | `internal-session.ts`, `internal-ipc.ts` and `pages-subsystem.ts` only |
| [`history/`](history/) | **Remember**: the pages that were visited, kept on this computer and forgotten on request | yes, `history.db` on disk | `attach-history.ts` and `install-history.ts` only |
| [`privacy/`](privacy/) | **Forget**: clearing history, site data, the cache and app storage | no | no |
| [`devtools/`](devtools/) | **Inspect**: when developer tools may open on a page, and the question before they open on an app | which tools are open | `devtools-prompt.ts` only |
| [`zoom/`](zoom/) | **Size**: how large each site is shown, chosen per site and remembered | yes, `zoom.json` on disk | `attach-zoom.ts` and `install-zoom.ts` only |
| [`shortcuts/`](shortcuts/) | **Bind**: which key runs which command, the rules for changing one, and the listener that runs them | yes, `shortcuts.json` on disk | `dispatcher.ts`, `install-shortcuts.ts` and `app-menu.ts` only |
| [`settings/`](settings/) | **Choose**: what the person set, validated, persisted and told to whoever listens | yes, `settings.json` on disk | no |
| [`storage/`](storage/) | **Write**: the debounced, single-flight disk write every small persisted file shares | no | no |
| [`browsing/`](browsing/) | **Browse**: what the address bar and tab strip are made of | yes, bookmarks on disk | `favicon.ts` only |
| [`ipc/`](ipc/) | **Speak**: the chrome→main channels, one sender check each | no | yes, all three |
| [`consent/`](consent/) | **Ask**: decide what to ask, say it in words, show the dialog | no | the `-prompt` files only |
| [`permissions/`](permissions/) | **Review**: the grant list a person can revoke from | no | `permissions-panel.ts` only |
| [`install/`](install/) | **Install**: a hinted manifest becomes a registered, consented app | per-origin queue | the `-subsystem` file, `manifest-hint.ts` and `granted-origin-csp.ts` |
| [`sessions/`](sessions/) | **Confine**: what an Electron `Session` is allowed to do | yes, each site's notification answer on disk | `permission-gate.ts` and `web-context-host.ts` only |
| [`keyring/`](keyring/) | **Persist**: the identity seed, OS-keyring-backed or session-only | yes, the encrypted seed file | `electron-keychain.ts` only |
| [`self-update/`](self-update/) | **Update itself**: check, notify, never install | last-check timestamp | `-runner` only |
| [`dev/`](dev/) | **Dev only**: inert or compiled out of an ordinary build | no | no |
| [`verifier/`](verifier/) | **Verify names**: start the `.eth` verifier, trust its certificate, choose its checkpoint | the host process, stored checkpoint and IPNS sequences | `verifier-subsystem.ts` only |
| [`embed/`](embed/) | **Show**: the pages an app shows inside itself, in a `<webview>` (`ADR-0039`) | which app owns which guest | `embed-host.ts` and `embed-subsystem.ts` only |

Each directory carries its own `README.md` on this same template, plus its own `## Design notes`
for the rationale specific to the files it holds.

### The organising rule

The folder says **what job**. The filename suffix says **which layer** — a vocabulary this
directory already used in six places before it had a name:

| Suffix | Meaning |
|---|---|
| `<name>.ts` | The decision. No `electron` import, unit-tested under plain vitest |
| `<name>-prompt.ts` | The native `dialog.showMessageBox` that shows it |
| `<name>-subsystem.ts` | Registers it into the running app via `registry.ts` |
| `<name>-runner.ts` | The real I/O around it |

This is why, for example, `install-consent.ts` and `install-consent-prompt.ts`
([`consent/`](consent/)) stay in the same folder rather than splitting across a pure/Electron
directory boundary: the split is already legible from the name, and keeping the pair together
keeps the feature readable.

## Two things not to rediscover

**`webPreferences` is load-bearing.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` are what keep the preload's port out of the page
([`security-model.md`](../../docs/architecture/security-model.md) T17). A hookify rule rejects
edits that weaken them.

**`BaseWindow`, not `BrowserWindow`.** `BrowserWindow` supports a single full-size web view;
the shell needs a chrome view *plus* tab views, which only `BaseWindow` composes.

**Main and preload are CommonJS; only the renderer is ESM.** A sandboxed preload has no ESM
context at all. `sandbox: true` is non-negotiable, so the preload must be CJS, and matching
main to it avoids a two-format build for no gain. An ESM main process does work, verified
against Electron 44, if a reason to switch ever appears.

## Design notes

**[`index.ts`](index.ts): do not add `ozone-platform: x11`.** It makes things strictly worse:
the GPU process segfaults under XWayland on this machine (`exit_code=139`) and the window stops
rendering at all. It looks like a fix for "no window ever appears", but that symptom was never
about display selection; see [`shell/window.ts`](shell/window.ts)'s `showOnce` comment for the
actual root cause and fix (`ready-to-show` unreliable when loading from the dev server).
