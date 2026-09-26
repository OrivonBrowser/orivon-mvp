# `src/shim-electron/`: the `electron` module compatibility package

**What lives here.** Electron's `app`, `dialog`, `safeStorage`, `ipcRenderer`/`ipcMain`,
`BrowserWindow`, `Menu` and `Tray`, reconstructed (or explicitly refused) on top of `orivon.*`, so
that `require('electron')` / `import ... from 'electron'`, a tier-2 app's guaranteed first import,
resolves to something instead of failing to load at all
([`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md) Table 2, family 2,
A95).

This is the **second** of the matrix's three adapter families, a sibling of
[`src/shim/`](../shim/README.md) (the Node stdlib family), not a part of it. An app imports
`net`/`fs` from one and `electron` from the other; they solve different problems. **One
narrow exception (A135):** `src/shim/` imports this package's `unimplemented.ts` (`refusingProxy`)
directly, to give its own Node-stdlib gaps the same "refuse by name, not absence" treatment this
package built first; see that file's README for the reasoning. The reverse import still does not
happen and must not (§What it must never import, below).

| Electron API | What backs it | This package |
|---|---|---|
| `app.getVersion()` | `orivon.app.manifest()` | `app.ts` |
| `app.getPath('userData')` | the app's own confined `fs` root | `app.ts` |
| `app.getPath(anything else)` | nothing; ambient FS is excluded by design | refuses, named `'ambient-fs'` |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` | `dialog.ts`: **the broker does not implement this yet**; every call refuses, named `'not-built'` |
| `dialog.showMessageBox` / `showSaveDialog` / `showErrorBox` / anything else on `dialog` | nothing, never considered | `dialog.ts`, refuses, named `'unimplemented'` |
| `safeStorage.isAsyncEncryptionAvailable` / `encryptStringAsync` / `decryptStringAsync` | `orivon.secrets` (ADR-0033) | `safe-storage.ts` |
| `safeStorage.isEncryptionAvailable` (sync) | nothing; always `false`, so a ported app takes its own non-keyring fallback | `safe-storage.ts` |
| `safeStorage.encryptString` / `decryptString` (sync) | nothing; `orivon.secrets` is async-only | `safe-storage.ts`, refuses, named `'not-built'` |
| `safeStorage.getSelectedStorageBackend` / `setUsePlainTextEncryption` / anything else on `safeStorage` | nothing, never considered | `safe-storage.ts`, refuses, named `'unimplemented'` |
| `ipcRenderer.invoke` / `ipcMain.handle`, `.on`/`.send` | a local in-sandbox message bus, no capability, no broker | `ipc.ts` |
| `BrowserWindow`, `Menu`, `Tray` | nothing; desktop-shell surface, out of scope | `desktop-shell.ts`, where every entry point refuses, named `'desktop-shell'` |
| `shell`, `clipboard`, `session`, `protocol`, `webContents`, `nativeImage`, `screen`, `contextBridge`, `crashReporter`, `powerMonitor`, `systemPreferences`, `globalShortcut`, `nativeTheme`, `webFrame`, `desktopCapturer` | nothing, never considered in either direction | `unimplemented.ts`, where every property access refuses, named `'unimplemented'` |
| any other real Electron top-level export, read off `import electron from 'electron'` | nothing, never considered | `unimplemented.ts`'s default-export fallback (`index.ts`), which refuses, named `'unimplemented'`, without needing to be listed anywhere first |

**What it depends on.** [`src/contracts/`](../contracts/) (types only: `Manifest`, `Orivon`;
this package emits no contracts-affecting runtime code) and the real `window.orivon` global a
preload installs before app code runs.

**What it must never import.** `electron`, since this package exists to *be* `electron`'s
replacement, so importing the real module would be circular and would also violate Rule 8 (this
package must run in a renderer, never load a native Electron binding). `src/broker/`, because this runs
entirely inside the sandbox; `ipc.ts`'s message bus in particular needs no broker round-trip at
all (see its own header comment). `src/shim/` or `src/preload/`, because no call in this package needs
either; if one ever does, that is a design question to raise, not an import to add.

**Owner stream.** New as of this package; `compatibility-matrix.md` names it "unaccounted for"
before this lands. No row for `src/shim-electron/` exists yet in
[`parallel-work.md`](../../docs/development/parallel-work.md)'s ownership map; that table is
`docs`-owned, so adding the row is a coordination point for that stream, not an edit made here.

## Design notes

**Why one `ElectronShimError` class with a closed `reason` union, instead of one error class per
refusal.** Every unsupported or not-yet-built API in this package needs the same three things: a
name, a reason a porting developer can branch on or at least read, and a message. A class per
reason would multiply for no benefit `errors.ts` doesn't already give exhaustively; a bare
`Error` would fail the exit criterion this whole package exists to meet: "an unsupported API
throws an error naming why," not a generic `TypeError: x is not a function`.

**Why `app.getVersion()`/`getPath()` require `app.whenReady()` first, when real Electron's
don't.** `handle-contracts.md`'s binding requirement 5 (`src/shim/README.md` carries the same
rule for the sibling family): a synchronous accessor is served from a value captured at
acquisition, never a cache an event fills in later. Real Electron's version comes from a
synchronous `package.json` read at process start; ours comes from `orivon.app.manifest()`, an
async broker round-trip, and no JavaScript turns a pending promise into a returned value on the
same call stack without a mechanism this repo does not have (`compatibility-matrix.md`'s A94,
unresolved for the same reason). `whenReady()` is the one honest way to bridge that gap, and it
asks nothing new of a ported app, because real Electron code already gates its own startup on the
identical call.

**Why `getPath('userData')` returns `/orivon/app`.** It is the virtual root every Node-shaped
path in an app tab agrees on: `process.cwd()`, `os.homedir()`, `$HOME` and `$APPDATA` all name it,
and `src/shim/`'s `fs` strips it before calling `orivon.fs`, so a porting app's own
`path.join(app.getPath('userData'), 'settings.json')` lands in the app's confined files. Handed
straight to `orivon.fs` instead, it is refused: the broker rejects every absolute path
(`src/broker/policy/paths.ts`), so an app reaching `orivon.fs` directly passes relative paths.
`app.ts` holds its own copy of the value because this package may not import `src/shim/`;
`src/shim/tests/virtual-root.test.ts` holds the two equal.

**Why `dialog.showOpenDialog` always refuses, rather than calling through when
`orivon.fs.userSelected` happens to exist.** It never does today: `compatibility-matrix.md`
Table 1 marks the broker's implementation ❌, and the preload does not expose it on
`window.orivon` either (`src/preload/surface/orivon.ts` exposes only `app.manifest`/`grants` and
`fs.readFile`/`writeFile`). Even a built broker would not close this cleanly: `userSelected`
resolves to a `FileHandle`, not a host OS path, so `OpenDialogReturnValue.filePaths` (a
`string[]` in real Electron) cannot be filled in without a further design decision about what a
ported app can honestly do with the result. Wiring a call through today would be building ahead
of both the broker and that decision; refusing now and revisiting when `fs.userSelected` lands
is the smaller, reversible choice.

**Why `safeStorage` backs the async trio but the sync trio refuses.** `orivon.secrets`
(ADR-0033) is async-only, the same design rule `net`/`fs` already follow
(`capability-api.ts`'s rule 2): every call crosses to the broker and back. Real Electron's
`isEncryptionAvailable`/`encryptString`/`decryptString` are synchronous and this package has no
mechanism to block the renderer on an IPC round trip the way `fs.readFileSync`'s own narrow
ADR-0016 exception does -- and unlike that exception, nothing here forces a startup path through
the sync form, so there is no equivalent pressure to build one. `isEncryptionAvailable()`
answering `false` unconditionally is not a placeholder: it is the exact signal Element Desktop's
and AirGap Vault's own documented non-keyring fallbacks already check for, so a ported app that
calls it before reaching for the async trio still ends up somewhere that works.

**Why `ipcRenderer`/`ipcMain` share one bus with no broker call anywhere in `ipc.ts`.**
`ADR-0005` dissolved the app backend: all app code is renderer JavaScript, so a ported app's
"main process" and "renderer process" halves run in the exact same realm here. There is nothing
to cross and nothing to authorise: `ipc.ts` is a same-realm `Map`-backed request/response and
event registry, not IPC in the OS sense. Building broker plumbing for it would add a capability
check to a call that was never privileged in the first place.

**Why the desktop-shell refusals are three small classes rather than one generic Proxy.**
`app`/`dialog`/`ipcRenderer`/`ipcMain` are plain objects with a known, small set of methods, so a
factory function is the natural shape. `BrowserWindow`/`Menu`/`Tray` are used with `new` and with
statics real code calls before ever constructing one (`Menu.setApplicationMenu`,
`BrowserWindow.getAllWindows`): a handful of named entry points that all do the same thing (name
the boundary, then throw) reads more plainly than a `Proxy` over a constructor doing the
equivalent through `construct`/`get` traps for a set of methods this small.

**Why an unsupported API throws a named error instead of being absent (and why one Proxy
mechanism, not several).** This package's own exit criterion, from the build queue item that
created it, is that an unsupported API throws an error naming why, never a generic
`TypeError: x is not a function`. Before this file existed, that held for exactly seven names
(`app`, `dialog.showOpenDialog`, `ipcRenderer`, `ipcMain`, `BrowserWindow`, `Menu`, `Tray`);
everything else real Electron apps commonly reach for (`shell.openExternal`, `clipboard`,
`session`, `dialog.showMessageBox`) was simply absent, so it threw the exact bare `TypeError`
the package exists to prevent. `unimplemented.ts`'s `refusingProxy` closes that gap with one
mechanism, reused three ways: a whole missing module (`unimplementedMember`, used for `shell`,
`clipboard`, and the rest of `index.ts`'s curated list), one extra method on an object that
mostly works (`dialog.ts`'s other methods, alongside `showOpenDialog`'s own decided refusal),
and the package's whole export surface for default-style consumption
(`withUnimplementedFallback`, `index.ts`'s default export). **A fourth reuse, outside this
package (A135):** `refusingProxy` itself takes a `classify` that returns the `Error` to throw
directly, so
[`src/shim/`](../shim/README.md) reuses this exact function with its own error type for the
Node-stdlib family's equivalent gaps, without this package knowing that caller exists.

**Three refusal reasons, because they are three different situations for a porting developer.**
`'desktop-shell'` means refused by design: this will never work, an owner policy decision.
`'not-built'` means a decision exists and a build path is named (`dialog.showOpenDialog` ->
`fs.userSelected`), expected to work later. `'unimplemented'` means neither, and nothing has
decided whether `shell.openExternal` ever will work, and the message says exactly that rather
than implying a decision was made either way. Conflating the last two would tell a porting
developer a feature is coming when nobody has agreed it is; conflating either with
`'desktop-shell'` would tell them something is impossible when it might just not be built yet.

**Why "total" stops short of literally every possible name, and where it stops.** A real ES
module namespace object, which is what every named export of this file sits on, and what
`await import('electron')`/`import * as electron from 'electron'` return, cannot be intercepted:
reading a property Electron never declared as an export returns `undefined` unconditionally, by
spec, regardless of anything this package's own code does. Verified directly (a throwaway Node
script: a Proxy exported as a named binding leaves an undeclared property `undefined` on the
resulting namespace; the identical Proxy exported as `default` throws correctly, because a
default export's *value* can be anything). Practical effect: `import { someBrandNewApi } from
'electron'` for a name this file has never declared fails at the point a bundler resolves that
import: loud, but not through `ElectronShimError`, and outside this package's control either
way. The curated list in `index.ts` (15 names, from the audit that found this gap) closes that
specific failure for the names real ported apps use most; the default export closes it
completely for `import electron from 'electron'`-style consumption, because that value is one
we fully control. Nothing analogous exists for the named-export style beyond naming every real
Electron export explicitly, which is neither realistic nor this package's job to keep current.

**Alias map coordination.** Wiring the bare specifier `electron` to this package's `index.ts` in
`electron.vite.config.ts`'s `renderer.resolve.alias` is the `shim` stream's exclusive append
point (`parallel-work.md`). This package does not add that entry; it is a parked coordination
question, reported rather than edited here.
