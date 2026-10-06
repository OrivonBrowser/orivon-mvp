# `src/main/`: the Electron main process

**What lives here.** The browser shell: the window, tabs, the omnibox, shell IPC, and the
subsystem registry every other stream plugs into, one directory per job
([`ADR-0023`](../../docs/decisions/ADR-0023-src-main-is-organised-by-job.md)). `start.ts`
(the process entry: it takes the single-instance lock before `index.ts`, the rest of the browser, is loaded),
`index.ts`, `registry.ts`, `subsystems.ts` and `channels.ts` stay at the top level: `registry.ts` and
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
| [`import/`](import/) | Bookmarks and history read once from another browser's profile files, through a read-only copy, into Orivon's own stores | no | `import-host.ts` only |
| [`privacy/`](privacy/) | Clearing history, site data, the cache and app storage; the network controls (request headers, cookie policy, HTTPS-only, secure DNS) | no | the installer and the runners only |
| [`site-settings/`](site-settings/) | What a site may do: per-site permissions, content settings and the prompt that asks | yes: `site-settings.json` (memory only in a private session) | the installers only |
| [`media-grants/`](media-grants/) | A registered app's camera, microphone and screen: the grants the display gate reads, and the asker that answers the permission gate from them | in memory only: a refusal until the page loads again | the installer only |
| [`passwords/`](passwords/) | The saved-login store, its Settings domain and the form watcher that feeds it | yes: `passwords.json` | the installer and the runner only |
| [`auth/`](auth/) | The sign-in sheets an HTTP server asks for and the certificates a connection shows | in memory only: pending challenges, the certificates connections presented | the installer, the clipboard write and the tab navigation count |
| [`os/`](os/) | What the operating system is told about Orivon: links from other programs, the default-browser registration and its weekly ask, launcher menus, shortcuts, sharing | `default-browser-ask.json` in the default profile | the runners, `install-launcher-menu.ts`, `install-default-browser-ask.ts` and `windows-taskbar-real.ts` |
| [`autofill/`](autofill/) | Saved postal addresses and the chooser that fills a form from them; this build has only an empty installer | no | the installer only |
| [`devices/`](devices/) | The choosers for a screen to share and for a USB or HID device; this build has only an empty installer | no | the installer only |
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
| [`loading-screen/`](loading-screen/) | The screen over a tab while a protocol page (`ipfs://`) loads: when it goes up, what it says and when it goes away | no | no (types only, and the watcher's `webContents` events) |
| [`omnibox/`](omnibox/) | The address bar's suggestions: rows from history, bookmarks, open tabs and, if asked, the default engine's suggestions, the text finished inline, and what choosing a row does | the rows and the selection of the last query, in memory | no (types only, but the overlay and the actions use the window) |
| [`tab-groups/`](tab-groups/) | Named, coloured, collapsible tab groups: the store, the rules for where grouped tabs sit, the commands, the bubble | each tab's group on its record; the groups of a window in `session.json` (never when private) | no (types only) |
| [`tab-search/`](tab-search/) | The tab search list: open tabs of every window and recently closed ones, and what choosing a row does | which tab was in front last, in memory | no (types only) |
| [`side-panel/`](side-panel/) | The panel docked beside the page: bookmarks, history, a reading list view that nothing fills yet, and downloads views, and the slot an extension's view fills | the width and last view in `side-panel.json` (memory in a private window); which windows have it open, in memory | the host, the overlay and the store (types only elsewhere) |
| [`memory-saver/`](memory-saver/) | Putting an idle tab to sleep and waking it: the rules for which tab may sleep, the sweep, the sleeping tab's look, the energy saver | what each sleeping tab keeps, on its record; when each tab was last in front, in memory | the sweep, the swap and the page question (types only elsewhere) |
| [`reader/`](reader/) | Reader view: the article taken from a page in an isolated world, the validated block model, the reader tab and what its page may ask | the article each window's reader tab shows, in memory | the extraction, the command, the picture copy and the installer |
| [`focus/`](focus/) | Keyboard focus across the chrome, the side panel and the page (F6), and caret browsing with its question sheet | which pane had focus last, in memory | the pane cycle, the caret runner and the sheet |
| [`appearance/`](appearance/) | The stylesheet of token overrides inserted into Orivon's own surfaces, never into a site's tab | no | `shell-style-runner.ts` only |
| [`qr/`](qr/) | The page's address as a QR code, with copy and save as PNG | no | `qr-real.ts` only |
| [`startup/`](startup/) | What a cold start opens (the new tab page, last session, chosen pages) and the offer to restore after a crash | no | `startup-overlays.ts` only |
| [`settings/`](settings/) | What the person set, validated, persisted and told to whoever listens | `settings.json` on disk | no |
| [`storage/`](storage/) | The debounced, single-flight disk write every small persisted file shares | no | no |
| [`browsing/`](browsing/) | What the address bar and tab strip are made of | bookmarks and search engines on disk | `favicon.ts` only |
| [`ipc/`](ipc/) | The chrome-to-main channels, one sender check each | no | yes |
| [`consent/`](consent/) | Decide what to ask, say it in words, show the dialog | no | the `-prompt` files only |
| [`permissions/`](permissions/) | The grant list a person can revoke from, and the per-site popover | no | the two `-panel` files and `popover-view.ts` |
| [`install/`](install/) | A hinted manifest becomes a registered, consented app | per-origin queue | the `-subsystem` file, `manifest-hint.ts` only |
| [`local-files/`](local-files/) | The sessions, handler and fence that make a document opened from this computer an origin of its exact path | the record of files allowed to use Orivon permissions (`local-file-apps.json`) | `local-partition.ts`, `refuse-file-scheme.ts`, `local-files-subsystem.ts` only |
| [`sessions/`](sessions/) | What an Electron `Session` is allowed to do | each site's notification answer | `permission-gate.ts`, `web-context-host.ts`, `web-request-owner.ts`, `session-attribution.ts` |
| [`keyring/`](keyring/) | The identity seed, OS-keyring-backed or session-only | the encrypted seed file | `electron-keychain.ts` only |
| [`self-update/`](self-update/) | Check, notify, never install | last-check timestamp | `-runner` only |
| [`dev/`](dev/) | Dev only: inert, gated, or compiled out | no | `local-ddoc.ts` only, lazily |
| [`verifier/`](verifier/) | Start the `.eth` verifier, trust its certificate, choose its checkpoint | host process, checkpoint, IPNS sequences | `verifier-subsystem.ts` only |
| [`embed/`](embed/) | The pages an app shows inside itself, in a `<webview>` (`ADR-0039`) | which app owns which guest | `embed-host.ts` and `embed-subsystem.ts` only |
| [`children/`](children/) | The hidden host each app's forked/threaded children run in, and how long they live (`ADR-0046`) | live pages per origin, one offscreen host per origin | `watch-pages.ts`, `child-host.ts` and `children-subsystem.ts` only |
| [`extensions/`](extensions/) | Install, register and load Chrome extensions | the installed-extension registry | all but `action-pins-runner.ts`, `action-pins.ts`, `base-manifest-source.ts`, `crx.ts`, `crx3-format.ts`, `details-optional.ts`, `dnr-action-options.ts`, `dnr-api.ts`, `dnr-match-log.ts`, `effective-manifest.ts`, `electron-chrome-extensions-lib.d.ts`, `extension-commands.ts`, `extension-host-access.ts`, `extension-known-permissions.ts`, `extension-permission-check.ts`, `extension-prefs-runner.ts`, `extension-prefs.ts`, `extension-sender-id-check.ts`, `extension-tab-details.ts`, `extension-tab-invocation.ts`, `extension-url-policy.ts`, `extensions-detail-parts.ts`, `extensions-domain.ts`, `extensions-install-test-hook.ts`, `extensions-menu-command.ts`, `extensions-menu-model.ts`, `extensions-menu-names.ts`, `extensions-menu-overlay.ts`, `extensions-menu-points.ts`, `extensions-page-commands.ts`, `extensions-view-runner.ts`, `extensions-view.ts`, `granted-host-rule.ts`, `granted-reconcile.ts`, `install-lifecycle.ts`, `install-private.ts`, `install-store-runner.ts`, `manifest-stage-granted.ts`, `manifest-stage-site-access.ts`, `optional-permissions.ts`, `permission-nag-limit.ts`, `permission-prompt-overlay.ts`, `registry-runner.ts`, `registry.ts`, `shortcuts-page.ts`, `site-reach-runner.ts`, `site-reach.ts`, `store-download-seam.ts`, `store-runner.ts`, `store-test-hook.ts` and `unpack-runner.ts` |

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
