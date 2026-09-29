# `src/main/extensions/`: install, register and load Chrome extensions

**What lives here.** The CRX3 verifier, the zip unpacker, the installed-extension registry
(`<userData>/extensions/registry.json`), the install/uninstall/enable runner, the install prompt,
the subsystem that loads every enabled entry into `session.defaultSession` at boot, and the
extension host (`extension-host.ts`) that wires the electron-chrome-extensions library into the
shell (ADR-0043) through the URL policy (`extension-url-policy.ts`) it applies to every URL an
extension asks to open.

**What it depends on.** `electron` (every file except `crx.ts`, `crx3-format.ts`, `registry.ts`,
`extension-url-policy.ts` and `unpack-runner.ts`'s pure `checkZipEntryPath`), `node:crypto`,
`node:fs`, `node:path`, `adm-zip`, `pbf`,
[`../../broker/policy/extension-manifest.ts`](../../broker/policy/extension-manifest.ts)
(durable: the manifest facts, the stripped-manifest copy, the install prompt's words),
[`../../broker/grants/node-ledger-storage.ts`](../../broker/grants/node-ledger-storage.ts)'s
`writeFileAtomic`, and, for `crx.ts` and `install-runner.ts`,
[`vendor/electron-chrome-web-store`](../../../vendor/electron-chrome-web-store)'s `id.ts`
(`convertHexadecimalToIDAlphabet`, `generateId`). `extension-host.ts` reaches the vendored
`electron-chrome-extensions` library through the three virtual specifiers
`electron-chrome-extensions-lib.d.ts` declares (that file's own header says why), never its real path.

**What it must never import.** [`src/renderer/`](../../renderer/): this is main-process code,
same rule as the rest of `src/main/` (`../README.md`). Nothing under `vendor/` beyond an import
(`crx3.ts` is the one exception this directory does NOT import -- see Design notes for why;
`electron-chrome-extensions/src/browser/{index,partition,router}.ts` are the same exception,
reached only through the virtual specifiers above).

**Tied to Electron**, except the four files named above.

**Owner stream.** `shell`.

## The suffix rule, applied here

| File | Layer |
|---|---|
| `crx.ts`, `crx3-format.ts`, `registry.ts` | The decision -- no `electron`, unit-tested under plain vitest |
| `unpack-runner.ts`, `registry-runner.ts`, `install-runner.ts` | The real I/O |
| `extension-install-prompt.ts` | The native `dialog.showMessageBox` |
| `extensions-subsystem.ts` | Registers everything into the running app via `../registry.ts` |

## Design notes

**Why `loadableManifest` (`../../broker/policy/extension-manifest.ts`) strips `webRequest*`,
`declarativeNetRequest*` and `nativeMessaging`, and why `extensions-subsystem.ts` is listed in
`../subsystems.ts` right after `verifierSubsystem`.** Measured
(`docs/planning/spike-results/extension-netfetch-probe.json`): with either permission present,
Chromium proxies the session's URL loader, bypassing `protocol.handle` and crashing the main
process on the first `net.fetch` -- every permission shape tested, 15 of 15 runs. `stripped`
records exactly what was removed, so a later feature can serve those APIs itself from Orivon's own
engine; the verifier's own `webRequest` listener, attached before any extension loads, is a second
line of defence.

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
per-extension setting keyed by id. Order: the manifest's own `key` (Chrome keeps it); else a
`.crx`'s developer public key; else a key Orivon generates once per slot and persists at
`<userData>/extensions/<slot>/key.pub`, reused for every later install into that slot.

**The previous version is found by slot** (`install-runner.ts`'s `finishInstall`). The slot,
`<userData>/extensions/<slot>/`, is where every version of one install lives; the version segment
beneath it is what changes on an update.

**`allowFileAccess` is never `true`, anywhere in this directory.** An extension with file access
could read `file://` pages, including a page-cache-served or dashboard `file://` URL the shell
itself never grants an ordinary web page.
