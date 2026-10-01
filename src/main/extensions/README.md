# `src/main/extensions/`: install, register and load Chrome extensions

**What lives here.** The CRX3 verifier, the zip unpacker, the installed-extension registry
(`<userData>/extensions/registry.json`), the install/uninstall/enable runner, the install prompt,
the subsystem that loads every enabled entry into `session.defaultSession` at boot; the extension
host (`extension-host.ts`) that wires the electron-chrome-extensions library into the shell
(ADR-0043) through the URL policy (`extension-url-policy.ts`) it applies to every URL an
extension asks to open; the sender-id check on `crx-msg` (`extension-sender-id-check.ts`) and the
service-worker-preload health check and one-time recovery (`extension-sw-preload-recovery.ts`,
paired with `../../preload/extension-sw-verify.ts` and `../../preload/extension-api.ts`); the
Chrome Web Store wiring (`store-runner.ts`, `store-download-seam.ts`,
`store-test-hook.ts`); and the `orivon://extensions` page's main-side half: `extensions-view.ts`
(the row and details view model), `extensions-view-runner.ts` (reads a manifest, icon and locale
catalogue off a loaded entry's own folder), `extensions-picker-runner.ts` (the native pickers
Developer mode's buttons open) and `extensions-domain.ts` (the `InternalDomain` the page's
requests go through, `../pages/README.md`); and the host-access decision chrome.cookies and
chrome.tabs gate on (`extension-host-access.ts`, wired into the vendored library from
`extension-host.ts`); the activeTab-style invocation ledger `chrome.tabCapture` gates on
(`extension-tab-invocation.ts`) and the toolbar-click recorder that fills and clears it on a real
`WebContents` (`extension-tab-capture-invocation.ts`); the one list of manifest permission names
this app actually serves,
which `extensions-subsystem.ts` uses before its first `loadExtension()` to filter the
`ExtensionLoadWarning` lines Electron's own native permission schema logs for one of them
(`extension-known-permissions.ts`); and, for the same reason a person deciding about a site's
permissions should see who else can act on it, `site-reach.ts` (which enabled extensions' host
access covers a given origin) and `site-reach-runner.ts` (the real manifest reads behind it),
reused by `../consent/` and `../permissions/`. `extension-sandbox-page-query.ts` answers the
vendored preload's own synchronous "is this frame a declared sandbox page" query
(`EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL`, `../channels.ts`) from the sender's real URL and its
extension's real loaded manifest -- UPSTREAM.md patch 37's own doc; and `extension-sandbox-csp.ts`
serves a manifest `sandbox.pages` document Chrome's own CSP `sandbox` directive, so it actually
gets an opaque origin rather than only withholding `chrome.*` (UPSTREAM.md patch 40).

**What it depends on.** `electron` (every file except `action-pins-runner.ts`, `action-pins.ts`, `base-manifest-source.ts`, `crx.ts`, `crx3-format.ts`,
`details-optional.ts`, `dnr-action-options.ts`, `dnr-api.ts`, `dnr-match-log.ts`,
`effective-manifest.ts`, `electron-chrome-extensions-lib.d.ts`, `extension-commands.ts`,
`extension-host-access.ts`, `extension-known-permissions.ts`, `extension-permission-check.ts`,
`extension-prefs-runner.ts`, `extension-prefs.ts`, `extension-sender-id-check.ts`,
`extension-tab-details.ts`, `extension-tab-invocation.ts`, `extension-url-policy.ts`,
`extensions-detail-parts.ts`, `extensions-domain.ts`, `extensions-install-test-hook.ts`,
`extensions-menu-command.ts`, `extensions-menu-model.ts`, `extensions-menu-names.ts`,
`extensions-menu-overlay.ts`, `extensions-menu-points.ts`, `extensions-page-commands.ts`,
`extensions-view-runner.ts`, `extensions-view.ts`, `granted-host-rule.ts`, `granted-reconcile.ts`,
`install-lifecycle.ts`, `install-private.ts`, `install-store-runner.ts`,
`manifest-stage-granted.ts`, `manifest-stage-site-access.ts`, `optional-permissions.ts`,
`permission-nag-limit.ts`, `permission-prompt-overlay.ts`, `registry-runner.ts`, `registry.ts`,
`shortcuts-page.ts`, `site-reach-runner.ts`, `site-reach.ts`, `store-download-seam.ts`,
`store-runner.ts`, `store-test-hook.ts` and `unpack-runner.ts`), `node:crypto`, `node:fs`, `node:path`,
`adm-zip`, `pbf`,
[`../sessions/web-request-owner.ts`](../sessions/web-request-owner.ts)'s `webRequestOwnerFor`/
`RUN_LAST` and [`../install/granted-origin-csp.ts`](../install/granted-origin-csp.ts)'s
`withAppendedCsp` (`extension-sandbox-csp.ts`'s own dependencies -- the same header-composition
seam `granted-origin-csp.ts` itself uses, reused rather than duplicated),
[`../../broker/policy/extension-manifest.ts`](../../broker/policy/extension-manifest.ts)
(durable: the manifest facts, the stripped-manifest copy, the install prompt's words, and the
words `extensions-view.ts` reuses for the page),
[`../../broker/policy/extension-host-patterns.ts`](../../broker/policy/extension-host-patterns.ts)
(durable: the Chrome match-pattern matcher `extension-host-access.ts` uses for chrome.cookies'
and chrome.tabs' own host-access checks, and `site-reach.ts` uses for a person's own popups),
[`../../broker/policy/origin.ts`](../../broker/policy/origin.ts)'s `originFromUrl` (durable;
`extension-tab-capture-invocation.ts`'s own recorder and `extension-host.ts`'s `chrome.tabCapture`
app-refusal check both key on it),
[`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts)'s
`writeFileAtomic`, [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts)'s `InternalDomain`,
[`../channels.ts`](../channels.ts)'s `EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL`,
[`../sessions/tab-capture-grants.ts`](../sessions/tab-capture-grants.ts)'s `mintTabCaptureGrant`
(durable; `permission-gate.ts`'s own `'media'` carve-out reads the same ledger),
[`../settings/`](../settings/) (Developer mode is a setting there),
[`../shell/window.ts`](../shell/window.ts)'s `createShellWindow`,
[`../shell/shell-services.ts`](../shell/shell-services.ts)'s `ShellServices` type and
[`../shell/devtools-app-origin.ts`](../shell/devtools-app-origin.ts)'s `appOrigin` (the same
granted-app-origin question the DevTools prompt answers, reused for the `chrome.tabCapture`
refusal above),
[`../registry.ts`](../registry.ts)'s `Subsystem`/`SubsystemContext` types and
`publishExtensions`, [`../../protocols/builtin.ts`](../../protocols/builtin.ts)'s
`BUILTIN_ADDRESSES`, and two vendored libraries.
[`vendor/electron-chrome-web-store`](../../../vendor/electron-chrome-web-store): `id.ts`, and, for
the store, `index.ts`, `installer.ts` and `types.ts`, whose `UPSTREAM.md` says how patch 4 routes
every install through Orivon's own path. `vendor/electron-chrome-extensions`: reached by
`extension-host.ts` only through the seven virtual specifiers `electron-chrome-extensions-lib.d.ts`
declares (that file's header says why), never its real path.

**What it must never import.** [`src/renderer/`](../../renderer/): this is main-process code,
same rule as the rest of `src/main/` (`../README.md`). Nothing under `vendor/` beyond an import
(`crx3.ts` is the one exception this directory does NOT import -- see Design notes for why;
`electron-chrome-extensions/src/browser/{index,partition,router}.ts` and
`electron-chrome-extensions/src/browser/api/{browser-action,cookies,tab-capture,tabs}.ts` are the
same exception, reached only through the virtual specifiers above).

**Tied to Electron**, except the files named above with no electron import.

**Owner stream.** `shell`.

## The suffix rule, applied here

| File | Layer |
|---|---|
| `crx.ts`, `crx3-format.ts`, `registry.ts`, `extensions-view.ts`, `store-download-seam.ts`, `extension-prefs.ts`, `effective-manifest.ts`, `manifest-stage-granted.ts`, `manifest-stage-site-access.ts`, `extensions-detail-parts.ts`, `extensions-page-commands.ts`, `extension-permission-check.ts`, `install-private.ts`, `optional-permissions.ts`, `permission-nag-limit.ts`, `granted-host-rule.ts`, `granted-reconcile.ts`, `details-optional.ts` | The decision -- no `electron`, unit-tested under plain vitest |
| `crx.ts`, `crx3-format.ts`, `registry.ts`, `extensions-view.ts`, `extension-commands.ts`, `extension-action-anchor.ts`, `store-download-seam.ts`, `extension-prefs.ts`, `effective-manifest.ts`, `manifest-stage-granted.ts`, `manifest-stage-site-access.ts`, `extensions-detail-parts.ts`, `extensions-page-commands.ts`, `extension-permission-check.ts`, `install-private.ts` | The decision -- no `electron`, unit-tested under plain vitest |
| `unpack-runner.ts`, `registry-runner.ts`, `install-runner.ts`, `install-store-runner.ts`, `install-lifecycle.ts`, `extensions-view-runner.ts`, `store-runner.ts`, `extension-prefs-runner.ts`, `effective-manifest-runner.ts`, `extension-page-open.ts` | The real I/O |
| `extension-commands-runner.ts`, `install-extension-commands.ts`, `shortcuts-page.ts` | The keys of extension commands: the table and what a key runs (fakes for everything it reaches), the real session, registry and shell behind it, and what the shortcuts page may ask |
| `extension-install-prompt.ts`, `extensions-picker-runner.ts` | The native dialogs (`dialog.showMessageBox`, `dialog.showOpenDialog`) |
| `action-pins.ts`, `action-context-menu.ts`, `extensions-menu-model.ts`, `extensions-menu-names.ts`, `extensions-menu-points.ts`, `extensions-menu-deps.ts` | The decision for the toolbar's pins and the Extensions menu -- which extensions sit on the toolbar, the menu's rows and requests, the right-click template, and the slots a feature adds to the menu through |
| `action-pins-runner.ts`, `extensions-menu-overlay.ts`, `extensions-menu-command.ts`, `loaded-extensions.ts` | The pins acted on (the toolbar list, `chrome.action.getUserSettings`, `onUserSettingsChanged`, the right-click menu), the menu's `OverlayDef`, the `extensions.menu` command and the loaded-extension count the button follows |
| `permissions-api.ts`, `permission-prompt-overlay.ts` | `chrome.permissions` and the sheet it asks in (an `OverlayDef` queued through `requestSlot`) |
| `extension-host.ts`, `extension-host-impl.ts`, `extension-popup-policy.ts`, `extension-event-filter.ts` | The library wiring: construction and tab lifecycle, the shell callbacks, the popup and background-page window policy, the per-listener event filter |
| `api/` | Main-side handlers for the namespaces Orivon adds to `chrome.*`, and the one permission check (`api/README.md`) |
| `dnr/`, `dnr-api.ts`, `dnr-action-options.ts`, `dnr-match-log.ts`, `dnr-webrequest.ts`, `extensions-dnr.ts` | `declarativeNetRequest`, applied by Orivon rather than Electron ([`ADR-0051`](../../../docs/decisions/ADR-0051-orivon-applies-extensions-declarativenetrequest-rules-itself.md)): the Electron-free engine and its disk reads (`dnr/README.md`), the `chrome.declarativeNetRequest` handlers and badge counts, and the handlers registered on the session's one `webRequest` owner |
| `extensions-subsystem.ts` | Registers everything into the running app via `../registry.ts`, including the Chrome Web Store (`store-runner.ts`) |
| `store-test-hook.ts` | Test builds only -- exposes the store methods on `globalThis` for `test/e2e-extensions-store.test.ts` |
| `extensions-domain.ts` | The `orivon://extensions` page's `InternalDomain` -- validates every request, wires the pieces above to what the page asks |

## Design notes

**What the person chose is kept apart from what the extension shipped.** `extension-prefs-runner.ts`
keeps one record per extension in `<userData>/extensions/prefs.json` (`ExtensionsApi.prefs`; memory
only in a private runtime). The manifest the extension loads is the installed one with those choices
applied: `finishInstall` writes the installed manifest as `<slot>/manifest.base.json`, and
`effective-manifest-runner.ts` writes `effectiveManifest(base, prefs)` into the version folder's
`manifest.json` and reloads (`ExtensionsApi.applyManifest`: `now`, or `quiet` once no page of the
extension is open, and at the next launch when that never happens). A feature adds its stage to
`MANIFEST_STAGES` (`manifest-stage-granted.ts`, `manifest-stage-site-access.ts`). A store update is
judged against the base copy, so a choice that narrowed the loaded manifest never makes an update
look like it asks for more.

**A later permission request is asked, never granted unasked.** `permissions-api.ts` replaces the
library's `permissions.*` handlers: `optional-permissions.ts` classifies a request against the
manifest (held, never grantable, undeclared, or to ask), the sheet in `permission-prompt-overlay.ts`
is the only way to a grant, and the answer lands in `prefs.granted`. Library checks follow at once
(`extension-permission-check.ts` reads the grants, `granted-host-rule.ts` answers host questions);
Chromium's own checks follow at the quiet reload, because `manifest-stage-granted.ts` merges the
grants into the loaded manifest. Orivon never grants `nativeMessaging`, `webRequest*` or
`declarativeNetRequest*`, which stay governed by the strip list.
**An extension's commands are keys in Orivon's own dispatcher, never a second listener.**
`extension-commands.ts` reads the manifest's `commands` and decides which key each one ends up
with: the person's choice (`prefs.shortcuts`, `''` for one they cleared), else the suggested key
when Orivon and every earlier-installed command leave it free. `extension-commands-runner.ts` keeps
that table and answers `../shortcuts/dispatcher.ts`, which asks Orivon's own commands first, so an
extension never takes a key Orivon binds and a bare key or an editing key is never offered. A key
that runs a command is consumed; every other key still reaches the page. `_execute_action` opens
the popup as a click on the icon does, under the icon or else the Extensions button
(`extension-action-anchor.ts`); a named command reaches `chrome.commands.onCommand` through
`ElectronChromeExtensions.sendCommand` with the active tab, and counts as an invocation of the
extension on that tab. A tab no extension is told about (a registered app's, or an internal page)
is passed as no tab. `commands.getAll` (`api/commands-api.ts`) answers with the live key. The
table is empty until `installShortcuts` says the saved shortcuts are read, because a lookup before
that would cache the defaults. The macOS reading of `Command` and `MacCtrl` is *provisional*: it
is unit-tested and has not run on a Mac.

**`extension-sw-preload-recovery.ts` must import nothing beyond `electron`'s ambient types.**
Its own exports (the two health-check channel constants, `extensionIdFromScope`) are imported by
`src/preload/extension-sw-verify.ts`, a PRELOAD script that runs in every extension service
worker. A real import added to `extension-sw-preload-recovery.ts` -- even one nothing in that
file ever calls -- bundles that whole dependency's module graph into that preload script too: a
bundler's tree-shaking works per used export, not per file, and cannot prune an import with real
side effects (disk I/O, a vendored library) just because the importing file's own exports never
reach it. Measured directly: adding `extensions-dnr.ts` as an unused import there added several
seconds to a single e2e run seeding four real extensions (dNR's own vendored rule engine and its
`node:fs` I/O layer riding along into every service worker's preload). `watchForMissedServiceWorkerPreload`'s
`onReloadBoundary` parameter is how a caller-side concern (dNR's own reload marking, wired from
`extension-host.ts`'s call site instead) reaches this file's generic hook without this file ever
importing that caller's module itself.

**[`site-reach.ts`](site-reach.ts) returns none for an origin served from its pinned cache,
without ever looking at the installed extensions.** ADR-0045 has extensions run on every page,
including a granted app -- but `GRANTED_APPS_CLAUSE`
(`../../broker/policy/extension-manifest.ts`) already carries the one exception: "except an app
running from its pinned copy". Naming extensions on such an origin's site-info popup or grant
prompt would say something false, so this file matches that exception exactly rather than
letting its own answer drift from what the install prompt and the extensions page already say.
The check is an injected predicate (`isOriginServedFromCacheSync`, real implementation in
`../../loader/electron/serve.ts`), so this file stays pure and testable against a fake, the same
shape [`../permissions/site-info-controller.ts`](../permissions/site-info-controller.ts)'s
`SiteTrustSources` already uses it in.

**Why `loadableManifest` (`../../broker/policy/extension-manifest.ts`) strips `webRequest*`,
`declarativeNetRequest*` and `nativeMessaging`, and why `extensions-subsystem.ts` is listed in
`../subsystems.ts` right after `verifierSubsystem`.** Measured
(`docs/planning/spike-results/extension-netfetch-probe.json`): with either permission present,
Chromium proxies the session's URL loader, bypassing `protocol.handle` and crashing the main
process on the first `net.fetch` -- every permission shape tested, in 10 of 10 runs without an
embedder `webRequest` listener. `stripped` records exactly what was removed, so a later feature
can serve those APIs itself from Orivon's own request-filtering engine; the verifier's own
`webRequest` listener, attached before any extension loads, is a second line of defence.

**`readExtensionManifest`'s `version` grammar, and `finishInstall`'s own path check, are two
independent layers over the same risk.** A `version` is Chrome's own grammar (one to four
dot-separated integers, each 0-65535, no leading zeros) --
[`../../broker/policy/extension-manifest.ts`](../../broker/policy/extension-manifest.ts) refuses
anything else, so a value shaped like a path (`../../../../.config/autostart`) never reaches
`install-runner.ts`'s `join(extensionsRoot, slot, version)` as a plausible version. `finishInstall`
also refuses unless the resolved slot and version-numbered directories land strictly inside their
own parent (`isStrictlyInsideDirectory`, the same shape `unpack-runner.ts`'s `checkZipEntryPath`
applies to a zip entry), independent of that grammar holding. A fresh install (no previous version
in its slot) whose write succeeded but whose load failed afterward has its own just-written folder
removed, the same as a same-version reinstall's own rollback does.

**chrome.cookies and chrome.tabs gate on host access, not only on holding the `cookies`/`tabs`
API permission -- and host access means `hostPermissions` (explicit host_permissions and MV2's
host-pattern entries in `permissions`), never a content_scripts match on its own.**
`extension-host-access.ts`'s `hasApiPermission`/`hasHostAccess`/`hasApiOrHostAccess` read an
extension's OWN loaded manifest (`event.extension.manifest`) the same way `readExtensionManifest`
reads one at install time, and match its `hostPermissions` against a URL with Chrome's own
match-pattern grammar
([`../../broker/policy/extension-host-patterns.ts`](../../broker/policy/extension-host-patterns.ts)).
`extension-manifest.ts`'s own doc on `hostPermissions` says why a content-script match does not
count: Chrome keeps two separate host sets (explicit_hosts vs. scriptable_hosts,
`extensions/docs/permissions.md` in Chromium's own source), and only explicit_hosts gates API
access. `hostPatterns`, the union of both, stays reserved for the install prompt's wording, which
Chrome's own prompt warns about either kind of host reach.
`extension-host.ts`'s `createExtensionHost` installs several hooks the vendored library calls back
into, the same shape as the sender-id check (`extension-sender-id-check.ts`): `setEventListenerFilter`
(router.ts, UPSTREAM.md patch 15) gates or strips a broadcast event per listener --
`cookies.onChanged` needs both the `cookies` permission and host access to the cookie's own URL;
`tabs.onCreated`/`onUpdated` strip `url`/`pendingUrl`/`title`/`favIconUrl` unless the listener
holds `tabs` or host access to the tab's URL; a `webNavigation.*` event needs the `webNavigation`
permission outright. `setCookieHostAccessCheck` (api/cookies.ts, patch 16) and
`setTabUrlAccessCheck` (api/tabs.ts, patch 18) apply the same two rules to a direct
`chrome.cookies`/`chrome.tabs` call, not only a broadcast event. `webNavigation.getFrame`/
`getAllFrames` require the `webNavigation` permission through router.ts's own `permission` option
(patch 19), the same mechanism `api/cookies.ts` uses for the `cookies` permission. The same rules
reach the rest of the library's surface: `chrome.windows.*` returns a window's tabs only when
asked (`populate`) and filtered the way `chrome.tabs` filters them; `chrome.tabs.insertCSS` needs
host access to the tab (`setTabHostAccessCheck`); a tab `chrome.tabs.create` opens in a granted
app's own session stays open for the person but never joins the library's store, so the
extension gets an error, not its id; `chrome.notifications` needs the `notifications`
permission; a popup URL must be the extension's own page; and `window.open` from a popup or a
background page goes through the same URL policy and `openTrusted` path as `chrome.tabs.create`.
**`chrome.offscreen` and `chrome.tabCapture` (UPSTREAM.md patches 32-33) follow the same
hook shape, for the one thing neither Electron nor the vendored library had at all.**
`chrome.offscreen.createDocument` hosts a never-shown, sandboxed `WebContentsView` per extension
(`api/offscreen.ts`) -- never a `BrowserWindow`: measured that a never-attached `WebContentsView`
still gets the library's own preload and messaging, and unlike a `BrowserWindow` it never counts
toward `BrowserWindow.getAllWindows()`, so an open offscreen document can no longer keep this
process alive past the last shell window closing. `window.open` from it is denied outright and
its own navigation is locked to the extension's own origin; a renderer crash
(`'render-process-gone'`) drops its own bookkeeping immediately, without also calling `close()`
on the crashed `WebContents` (measured: that call hangs, reproducing as a Chromium watchdog
FATAL). It closes by `Session`'s own `'extension-unloaded'` event too, so disable, uninstall and a
crash all tear it down the same way; `chrome.runtime.getContexts` (`api/runtime.ts`) reads it, the
currently open popup (`browser-action.ts`'s new `getOpenPopup`) and the running service worker to
answer for real, instead of leaving an extension's own existence check to fall back to
`clients.matchAll()`, which does not see a document this library creates.
`chrome.tabCapture.getMediaStreamId` (`api/tab-capture.ts`) refuses a tab six ways before
calling Electron's own `webContents.getMediaSourceId`: a tab outside this session, a non-`http(s)`
tab (another extension's own page included -- `appOrigin` returns null for one, so the app-refusal
check alone never caught it), a granted app's own tab (`setTabCaptureAppRefusalCheck`, wired to
the same `broker.app.hasGrantsSync` question `shell-services.ts`'s DevTools prompt asks, re-checked
on the tab's own navigation and again inside `permission-gate.ts`'s own `'media'` request handler),
a tab the extension was never invoked on (`setTabCaptureInvocationCheck`,
`extension-tab-invocation.ts`'s ledger, filled ONLY by a real toolbar click reaching
`browser-action.ts`'s `activateClick` over `crx-msg-remote` -- never a local `crx-msg` call, and
never `chrome.action.openPopup()`, which reaches the same code with no click at all -- and cleared
on that tab's own close, cross-origin navigation, or the extension's own unload), and a tab this
SAME extension is already capturing (Chrome's own "Cannot capture a tab with an active stream.").
A successful call
also mutes the tab locally (Electron duplicates a captured tab's audio instead of diverting it the
way Chrome does, measured directly), tracks consumption and release per (extension id, target tab
id) rather than per extension, watches whichever `WebContents` actually consumes the stream (the
offscreen document or an explicit `consumerTabId`) for its own destruction or crash, and mints a
short-lived record `permission-gate.ts`'s own `'media'` carve-out (`../sessions/tab-capture-grants.ts`)
reads -- keyed the same way, so one tab's redemption never marks a different tab the same
extension is also capturing.

Every `crx-msg`, `crx-add-listener` and `crx-remove-listener` message must name its sender's own
extension id (`extension-sender-id-check.ts`): the handlers that need no extension context are
reached only over `crx-msg-remote`, which admits a chrome view alone.

**[`crx3-format.ts`](crx3-format.ts) reads the CRX3 header protobuf itself, instead of importing
`vendor/electron-chrome-web-store/src/browser/crx3.ts`.** That vendored, pbf-generated reader does
not typecheck under the root tsconfig's `exactOptionalPropertyTypes` -- measured, `npx tsc --noEmit
-p tsconfig.json` reports two `TS2375` errors at its own lines the moment anything under `src/`
imports it. `crx3-format.ts` reads the same four fields, with the same `pbf` library and message
shapes, with types that satisfy the flag.

**`extension-host.ts` reaches `ElectronChromeExtensions` through a virtual specifier, not its real
path -- the same problem as `crx3-format.ts` above, at a much larger scale.** Importing
`vendor/electron-chrome-extensions/src/browser/index.ts` by its real path pulls its whole tree
(`api/*.ts`, `store.ts`, `router.ts`, `popup.ts`, `manifest.ts`) into the root tsconfig's stricter
settings -- measured, ~66 diagnostics across 16 files that satisfy `vendor/tsconfig.json`'s own,
deliberately looser ones (ADR-0043: "its TypeScript checks under `vendor/tsconfig.json`").
Patching all of it would mean reformatting most of the vendored tree, the opposite of what
ADR-0043 asks for. `electron-chrome-extensions-lib.d.ts` declares ambient types for
`orivon:crx-extensions`/`-partition`/`-router`/`-cookies`/`-tabs`/`-browser-action`/
`-tab-capture`, seven specifiers no real file matches; tsc falls back to those declarations, and
`electron.vite.config.ts`'s
`main.resolve.alias` maps each to the
real vendored file for Rollup to bundle. `src/preload/shell.ts`'s own import of
`vendor/.../src/browser-action.ts` (a shallow, single-file leaf: only `electron`) instead got
patched directly (UPSTREAM.md's patches 7-8), the same choice `crx3-format.ts` made for a small
file -- this boundary is for the one import that is genuinely too large to patch its way through.

**Who updates an extension is always shown** (`registry.ts`'s own doc on
`InstalledExtension.updater`): every entry carries an `updater` independent of `source`, because
an unpacked folder and a `.zip` file are both "no automatic updates" for different reasons, and a
Chrome Web Store install's `updater.kind: 'store'` carries its own check-cadence state that has
nothing to do with where the bytes came from.

**Every installed copy's manifest carries a `key`** (`registry-runner.ts`'s `resolveInstallKey`),
so Electron derives the same extension id from every version loaded into a slot, the way the
Chrome Web Store expects. Without one, Electron derives an unpacked extension's id from its own
load path (Chromium's `id_util::GenerateIdForPath`), which embeds the version number and so
changes on every update, silently losing `chrome.storage`, logins and every other
per-extension setting keyed by id. Order: a `.crx`'s verified developer public key wins outright
(Chrome itself ignores a packed CRX's manifest `key`, so a `.crx` install does too -- a manifest
`key` that differs is replaced, never kept); else, for a folder or `.zip` install, the manifest's
own `key` (Chrome keeps it there); else a key Orivon generates once per slot and persists at
`<userData>/extensions/<slot>/key.pub`, reused for every later install into that slot. An id
resolving to an entry already installed under a DIFFERENT slot is refused outright
(`install-runner.ts`'s `finishInstall`), so this ordering can never hand two slots the same id. A
manifest `key` is read the way Chromium reads it (`canonicalizeManifestKey`: PEM armour and
whitespace stripped, strict base64, parsed as an SPKI public key and re-exported), so the id
Orivon computes is the id Electron loads; a key that does not parse is refused, and a copy whose
loaded id still differs is unloaded and rolled back like a failed load. A keyed `.zip` whose id
matches an installed `.zip` or `.crx` entry installs into that entry's slot as its update.

**Every read-modify-write of the registry runs under `withRegistryLock`** (`registry-runner.ts`):
the extensions page, the store page's IPC and the store updater's background checks can all touch
the registry at once, so each call re-reads it inside the lock and writes only its own change. A
new call site that reads and then writes the registry must take the lock too.

**A folder install refuses a symlink anywhere in the tree** (`unpack-runner.ts`'s
`writeFolderCopy`, checked before and after the copy). Electron follows an extension's symlinks
wherever they point, so one would give the extension read access to the file system; the `.zip`
path refuses symlink entries for the same reason.

**The previous version is found by slot** (`install-runner.ts`'s `finishInstall`). The slot,
`<userData>/extensions/<slot>/`, is where every version of one install lives; the version segment
beneath it is what changes on an update. A reinstall of the SAME version (Developer mode's Reload
with no version bump, or a same-version store reinstall) targets its own existing folder: that
folder is moved aside before the new copy is written and loaded, and only deleted once the new
copy has actually loaded -- a failure restores it and reloads it, so a person never ends up with
neither.

**`allowFileAccess` is never `true`, anywhere in this directory.** An extension with file access
could read `file://` pages, including a page-cache-served or dashboard `file://` URL the shell
itself never grants an ordinary web page. Because no extension ever gets it, a `file:` URL is
never covered by an extension's host permission: `<all_urls>` leaves `file` out
(`../../broker/policy/extension-host-patterns.ts`'s `ALL_URLS_SCHEMES`), and
`dnr/host-permissions.ts`'s `createHostAccessChecker` and `extension-host-access.ts`'s
`hasHostAccess` refuse a `file:` request, initiator or url whatever pattern would otherwise match.

**The extensions page reads an entry's own loaded folder for what a list needs, never the
registry alone.** A name or description can be a `__MSG_...` reference into `_locales/<default_locale>/messages.json`,
and an icon is a path inside the same folder -- `extensions-view-runner.ts` resolves both, the
same way Chrome does, from the manifest actually loaded (`entry.path`), confined to that folder
(`readInside`, the same shape `src/main/pages/serve.ts` uses for a page's own assets).

**"Where it runs" and the install prompt's Web3 line share their wording** (`GRANTED_APPS_CLAUSE` and `GRANTS_STAY_WITH_APPS`,
`../../broker/policy/extension-manifest.ts`), so a person reading the details view after
installing sees the same fact in the same words, not a second description that could drift from
the first.

**The Chrome Web Store install and update path is Orivon's own, not the vendored library's.**
`store-runner.ts` registers the library's store-page preload and its IPC handlers
(`chrome.webstorePrivate` on chromewebstore.google.com's own top frame only -- vendor's
`api.ts`/`chrome-web-store.preload.ts`), but every actual write goes through
`install-store-runner.ts`'s `installFromStoreCrx`, the same `finishInstall` every other install uses:
`verifyCrx3` with `requirePublisherProof: true`, the id checked against what was requested, and,
for an update, `updateRequiresConsent` (`extension-manifest.ts`'s T19 subset rule) held back
rather than installed silently if it widens what the person already granted -- `registry.ts`'s
`ExtensionUpdater.pendingUpdate` records what a held-back update would need, for the page's
"Update" button to re-fetch and prompt on. A fresh store install shows one prompt, from the store
page's own manifest, through the library's `beforeInstall` hook, before any byte downloads; a
background update prompts nobody, and holds back rather than widening silently; the "Update"
button's own installs go through the same ordinary prompt a fresh install would. The store page
reaches only store installs: it cannot overwrite an extension installed from a file or a folder
with the same id, and it removes an extension only after the person confirms, and only one the
store installed (`store-runner.ts`).
