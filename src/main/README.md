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
| [`launch/`](launch/) | Which browser this process is (default, another profile, a private session) and its data directory | the profiles, on disk | `start-launch.ts` only, as a type |
| [`shell/`](shell/) | The window and the views inside it | the tab collection | yes |
| [`overlays/`](overlays/) | Orivon HTML above the page: where an overlay sits, when it closes, where focus goes; every bar, sheet and popup below shares it | no | `overlay-host.ts` and `overlay-view.ts` |
| [`pages/`](pages/) | The shell's own pages at `orivon://`, in a session only they can load, and the one channel they speak on | which webContents are which page | `internal-session.ts`, `internal-ipc.ts` and `pages-subsystem.ts` only |
| [`downloads/`](downloads/) | The files tabs download, saved without a dialog, tracked and managed from `orivon://downloads` | `downloads.json` on disk (memory only in a private session) | `install-downloads.ts`, `folder-runner.ts` and the `DownloadItem` type in `download-service.ts` |
| [`history/`](history/) | The pages that were visited, kept on this computer and forgotten on request | `history.db` on disk | `attach-history.ts` and `install-history.ts` only |
| [`privacy/`](privacy/) | Clearing history, site data, the cache and app storage | no | no |
| [`site-settings/`](site-settings/) | What a site may do: per-site permissions, content settings and the prompt that asks | no | the installers only |
| [`passwords/`](passwords/) | The saved-login store and the form watcher that feeds it | no | the runners only |
| [`auth/`](auth/) | The sign-in sheets an HTTP server asks for and the certificates a connection shows | no | the runners only |
| [`os/`](os/) | What the operating system is told about Orivon: links from other programs, the default-browser registration, shortcuts, sharing | no | the runners only |
| [`autofill/`](autofill/) | Saved postal addresses and the chooser that fills a form from them | no | the runners only |
| [`devices/`](devices/) | The choosers for a screen to share and for a USB or HID device | no | the runners only |
| [`devtools/`](devtools/) | When developer tools may open on a page, and the question before they open on an app | which tools are open | `devtools-prompt.ts` only |
| [`info/`](info/) | The About page and the task manager: the version and graphics facts, the process list, ending a process | when the last processor reading was taken | `about-runner.ts` and `tasks-runner.ts` only |
| [`page-tools/`](page-tools/) | Print, save as PDF, save the page, view source, screenshots and picture in picture, and the toast that reports them | no | `real-deps.ts` and the files that type a `webContents`, as types |
| [`zoom/`](zoom/) | How large each site is shown, chosen per site and remembered | `zoom.json` on disk | `attach-zoom.ts` and `install-zoom.ts` only |
| [`find/`](find/) | Find in page: the bar, the search it runs in the tab in front, and its commands | the query, per window, in memory | no (types only) |
| [`spellcheck/`](spellcheck/) | Spell checking in tabs, switched on or off by a setting | no: Chromium keeps the custom dictionary | `install-spellcheck.ts` only |
| [`window-state/`](window-state/) | Where the first window opens (the last-used window's place) and what a kiosk may run | `window-state.json` on disk | `window-state-recorder.ts` as a type only |
| [`shortcuts/`](shortcuts/) | Which key runs which command, the rules for changing one, and the listener that runs them | `shortcuts.json` on disk | `dispatcher.ts`, `install-shortcuts.ts` and `app-menu.ts` only |
| [`session-restore/`](session-restore/) | The tabs and windows that were closed, for reopening, and the open windows kept in `session.json` | `session.json` on disk, the closed stack in memory | `session-hook.ts` only |
| [`sad-tab/`](sad-tab/) | The card over a tab whose page crashed or stopped answering, with Reload and Close tab | no | no |
| [`omnibox/`](omnibox/) | The address bar's suggestions: rows from history, bookmarks and open tabs, the text finished inline, and what choosing a row does | the rows and the selection of the last query, in memory | no (types only, but the overlay and the actions use the window) |
| [`tab-search/`](tab-search/) | The tab search list: open tabs of every window and recently closed ones, and what choosing a row does | which tab was in front last, in memory | no (types only) |
| [`qr/`](qr/) | The page's address as a QR code, with copy and save as PNG | no | `qr-real.ts` only |
| [`startup/`](startup/) | What a cold start opens (the new tab page, last session, chosen pages) and the offer to restore after a crash | no | `startup-overlays.ts` only |
| [`settings/`](settings/) | What the person set, validated, persisted and told to whoever listens | `settings.json` on disk | no |
| [`storage/`](storage/) | The debounced, single-flight disk write every small persisted file shares | no | no |
| [`browsing/`](browsing/) | What the address bar and tab strip are made of | bookmarks on disk | `favicon.ts` only |
| [`ipc/`](ipc/) | The chrome-to-main channels, one sender check each | no | yes |
| [`consent/`](consent/) | Decide what to ask, say it in words, show the dialog | no | the `-prompt` files only |
| [`permissions/`](permissions/) | The grant list a person can revoke from, and the per-site popover | no | the two `-panel` files and `popover-view.ts` |
| [`install/`](install/) | A hinted manifest becomes a registered, consented app | per-origin queue | the `-subsystem` file, `manifest-hint.ts` only |
| [`sessions/`](sessions/) | What an Electron `Session` is allowed to do | each site's notification answer | `permission-gate.ts`, `web-context-host.ts`, `web-request-owner.ts`, `session-attribution.ts` |
| [`keyring/`](keyring/) | The identity seed, OS-keyring-backed or session-only | the encrypted seed file | `electron-keychain.ts` only |
| [`self-update/`](self-update/) | Check, notify, never install | last-check timestamp | `-runner` only |
| [`dev/`](dev/) | Dev only: inert, gated, or compiled out | no | `local-ddoc.ts` only, lazily |
| [`verifier/`](verifier/) | Start the `.eth` verifier, trust its certificate, choose its checkpoint | host process, checkpoint, IPNS sequences | `verifier-subsystem.ts` only |
| [`embed/`](embed/) | The pages an app shows inside itself, in a `<webview>` (`ADR-0039`) | which app owns which guest | `embed-host.ts` and `embed-subsystem.ts` only |
| [`children/`](children/) | The hidden host each app's forked/threaded children run in, and how long they live (`ADR-0046`) | live pages per origin, one offscreen host per origin | `watch-pages.ts`, `child-host.ts` and `children-subsystem.ts` only |
| [`extensions/`](extensions/) | Install, register and load Chrome extensions | the installed-extension registry | all but `crx.ts`, `crx3-format.ts`, `electron-chrome-extensions-lib.d.ts`, `extension-host-access.ts`, `extension-sender-id-check.ts`, `extension-tab-details.ts`, `extension-url-policy.ts`, `extensions-domain.ts`, `extensions-view-runner.ts`, `extensions-view.ts`, `registry-runner.ts`, `registry.ts`, `store-download-seam.ts`, `store-runner.ts`, `store-test-hook.ts` and `unpack-runner.ts` |

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
