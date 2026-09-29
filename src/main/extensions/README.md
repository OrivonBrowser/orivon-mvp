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
`extension-host.ts`).

**What it depends on.** `electron` (every file except `crx.ts`, `crx3-format.ts`, `registry.ts`,
`extensions-view.ts`, `extension-url-policy.ts`, `store-download-seam.ts`, `extension-host-access.ts`
and `unpack-runner.ts`'s pure `checkZipEntryPath`), `node:crypto`, `node:fs`, `node:path`,
`adm-zip`, `pbf`,
[`../../broker/policy/extension-manifest.ts`](../../broker/policy/extension-manifest.ts)
(durable: the manifest facts, the stripped-manifest copy, the install prompt's words, and the
words `extensions-view.ts` reuses for the page),
[`../../broker/policy/extension-host-patterns.ts`](../../broker/policy/extension-host-patterns.ts)
(durable: the Chrome match-pattern matcher `extension-host-access.ts` uses for chrome.cookies'
and chrome.tabs' own host-access checks),
[`../../broker/grants/node-ledger-storage.ts`](../../broker/grants/node-ledger-storage.ts)'s
`writeFileAtomic`, [`../pages/internal-ipc.ts`](../pages/internal-ipc.ts)'s `InternalDomain`,
[`../settings/`](../settings/) (Developer mode is a setting there), and two vendored libraries.
[`vendor/electron-chrome-web-store`](../../../vendor/electron-chrome-web-store): `id.ts`, and, for
the store, `index.ts`, `installer.ts` and `types.ts`, whose `UPSTREAM.md` says how patch 4 routes
every install through Orivon's own path. `vendor/electron-chrome-extensions`: reached by
`extension-host.ts` only through the five virtual specifiers `electron-chrome-extensions-lib.d.ts`
declares (that file's header says why), never its real path.

**What it must never import.** [`src/renderer/`](../../renderer/): this is main-process code,
same rule as the rest of `src/main/` (`../README.md`). Nothing under `vendor/` beyond an import
(`crx3.ts` is the one exception this directory does NOT import -- see Design notes for why;
`electron-chrome-extensions/src/browser/{index,partition,router}.ts` and
`electron-chrome-extensions/src/browser/api/{cookies,tabs}.ts` are the same exception, reached
only through the virtual specifiers above).

**Tied to Electron**, except the files named above with no electron import.

**Owner stream.** `shell`.

## The suffix rule, applied here

| File | Layer |
|---|---|
| `crx.ts`, `crx3-format.ts`, `registry.ts`, `extensions-view.ts`, `store-download-seam.ts` | The decision -- no `electron`, unit-tested under plain vitest |
| `unpack-runner.ts`, `registry-runner.ts`, `install-runner.ts`, `extensions-view-runner.ts`, `store-runner.ts` | The real I/O |
| `extension-install-prompt.ts`, `extensions-picker-runner.ts` | The native dialogs (`dialog.showMessageBox`, `dialog.showOpenDialog`) |
| `extensions-subsystem.ts` | Registers everything into the running app via `../registry.ts`, including the Chrome Web Store (`store-runner.ts`) |
| `store-test-hook.ts` | Test builds only -- exposes the store methods on `globalThis` for `test/e2e-extensions-store.test.ts` |
| `extensions-domain.ts` | The `orivon://extensions` page's `InternalDomain` -- validates every request, wires the pieces above to what the page asks |

## Design notes

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

**Why `loadableManifest` (`../../broker/policy/extension-manifest.ts`) strips `webRequest*`,
`declarativeNetRequest*` and `nativeMessaging`, and why `extensions-subsystem.ts` is listed in
`../subsystems.ts` right after `verifierSubsystem`.** Measured
(`docs/planning/spike-results/extension-netfetch-probe.json`): with either permission present,
Chromium proxies the session's URL loader, bypassing `protocol.handle` and crashing the main
process on the first `net.fetch` -- every permission shape tested, 15 of 15 runs. `stripped`
records exactly what was removed, so a later feature can serve those APIs itself from Orivon's own
engine; the verifier's own `webRequest` listener, attached before any extension loads, is a second
line of defence.

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
removed, the same as a same-version reinstall's own rollback already did.

**chrome.cookies and chrome.tabs gate on host access, not only on holding the `cookies`/`tabs`
API permission.** `extension-host-access.ts`'s `hasApiPermission`/`hasHostAccess`/
`hasApiOrHostAccess` read an extension's OWN loaded manifest (`event.extension.manifest`) the same
way `readExtensionManifest` reads one at install time, and match its `hostPatterns` against a URL
with Chrome's own match-pattern grammar
([`../../broker/policy/extension-host-patterns.ts`](../../broker/policy/extension-host-patterns.ts)).
`extension-host.ts`'s `createExtensionHost` installs three hooks the vendored library calls back
into, the same shape as the sender-id check (`extension-sender-id-check.ts`): `setEventListenerFilter`
(router.ts, UPSTREAM.md patch 15) gates or strips a broadcast event per listener --
`cookies.onChanged` needs both the `cookies` permission and host access to the cookie's own URL;
`tabs.onCreated`/`onUpdated` strip `url`/`pendingUrl`/`title`/`favIconUrl` unless the listener
holds `tabs` or host access to the tab's URL; a `webNavigation.*` event needs the `webNavigation`
permission outright. `setCookieHostAccessCheck` (api/cookies.ts, patch 16) and
`setTabUrlAccessCheck` (api/tabs.ts, patch 18) apply the same two rules to a direct
`chrome.cookies`/`chrome.tabs` call, not only a broadcast event. `webNavigation.getFrame`/
`getAllFrames` require the `webNavigation` permission through router.ts's own `permission` option
(patch 19), the same mechanism `api/cookies.ts` uses for the `cookies` permission.

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
`orivon:crx-extensions`/`-partition`/`-router`, three specifiers no real file matches; tsc falls
back to those declarations, and `electron.vite.config.ts`'s `main.resolve.alias` maps each to the
real vendored file for Rollup to bundle. `src/preload/shell.ts`'s own import of
`vendor/.../src/browser-action.ts` (a shallow, single-file leaf: only `electron`) instead got
patched directly (UPSTREAM.md's patches 7-8), the same choice `crx3-format.ts` made for a small
file -- this boundary is for the one import that is genuinely too large to patch its way through.

**Who updates an extension is always shown** (the owner's requirement, `registry.ts`'s own doc on
`InstalledExtension.updater`): every entry carries an `updater` independent of `source`, because
an unpacked folder and a `.zip` file are both "no automatic updates" for different reasons, and a
future Chrome Web Store install's `updater.kind: 'store'` carries its own check-cadence state
that has nothing to do with where the bytes came from.

**Every installed copy's manifest carries a `key`** (`install-runner.ts`'s `resolveInstallKey`),
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
(`install-runner.ts`'s `finishInstall`), so this ordering can never hand two slots the same id.

**The previous version is found by slot** (`install-runner.ts`'s `finishInstall`). The slot,
`<userData>/extensions/<slot>/`, is where every version of one install lives; the version segment
beneath it is what changes on an update. A reinstall of the SAME version (Developer mode's Reload
with no version bump, or a same-version store reinstall) targets its own existing folder: that
folder is moved aside before the new copy is written and loaded, and only deleted once the new
copy has actually loaded -- a failure restores it and reloads it, so a person never ends up with
neither.

**`allowFileAccess` is never `true`, anywhere in this directory.** An extension with file access
could read `file://` pages, including a page-cache-served or dashboard `file://` URL the shell
itself never grants an ordinary web page.

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
`install-runner.ts`'s `installFromStoreCrx`, the same `finishInstall` every other install uses:
`verifyCrx3` with `requirePublisherProof: true`, the id checked against what was requested, and,
for an update, `updateRequiresConsent` (`extension-manifest.ts`'s T19 subset rule) held back
rather than installed silently if it widens what the person already granted -- `registry.ts`'s
`ExtensionUpdater.pendingUpdate` records what a held-back update would need, for the page's
"Update" button to re-fetch and prompt on. A fresh store install shows one prompt, from the store
page's own manifest, through the library's `beforeInstall` hook, before any byte downloads; a
background update prompts nobody, and holds back rather than widening silently; the "Update"
button's own installs go through the same ordinary prompt a fresh install would.
