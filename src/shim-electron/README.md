# `src/shim-electron/` — the `electron` module compatibility package

**What lives here.** Electron's `app`, `dialog`, `ipcRenderer`/`ipcMain`, `BrowserWindow`,
`Menu` and `Tray` — reconstructed (or explicitly refused) on top of `orivon.*`, so that
`require('electron')` / `import ... from 'electron'`, a tier-2 app's guaranteed first import,
resolves to something instead of failing to load at all
([`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md) Table 2, family 2,
A95).

This is the **second** of the matrix's three adapter families — a sibling of
[`src/shim/`](../shim/README.md) (the Node stdlib family), not a part of it. An app imports
`net`/`fs` from one and `electron` from the other; they solve different problems and neither
depends on the other.

| Electron API | What backs it | This package |
|---|---|---|
| `app.getVersion()` | `orivon.app.manifest()` | `app.ts` |
| `app.getPath('userData')` | the app's own confined `fs` root | `app.ts` |
| `app.getPath(anything else)` | nothing — ambient FS is excluded by design | refuses, named `'ambient-fs'` |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` | `dialog.ts` — **the broker does not implement this yet**; every call refuses, named `'not-built'` |
| `ipcRenderer.invoke` / `ipcMain.handle`, `.on`/`.send` | a local in-sandbox message bus, no capability, no broker | `ipc.ts` |
| `BrowserWindow`, `Menu`, `Tray` | nothing — desktop-shell surface, out of scope | `desktop-shell.ts` — every entry point refuses, named `'desktop-shell'` |

**What it depends on.** [`src/contracts/`](../contracts/) (types only — `Manifest`, `Orivon`;
this package emits no contracts-affecting runtime code) and the real `window.orivon` global a
preload installs before app code runs.

**What it must never import.** `electron` — this package exists to *be* `electron`'s
replacement, so importing the real module would be circular and would also violate Rule 8 (this
package must run in a renderer, never load a native Electron binding). `src/broker/` — this runs
entirely inside the sandbox; `ipc.ts`'s message bus in particular needs no broker round-trip at
all (see its own header comment). `src/shim/` or `src/preload/` — no call in this package needs
either; if one ever does, that is a design question to raise, not an import to add.

**Owner stream.** New as of this package — `compatibility-matrix.md` names it "unaccounted for"
before this lands. No row for `src/shim-electron/` exists yet in
[`parallel-work.md`](../../docs/development/parallel-work.md)'s ownership map; that table is
`docs`-owned, so adding the row is a coordination point for that stream, not an edit made here.

## Design notes

**Why one `ElectronShimError` class with a closed `reason` union, instead of one error class per
refusal.** Every unsupported or not-yet-built API in this package needs the same three things: a
name, a reason a porting developer can branch on or at least read, and a message. A class per
reason would multiply for no benefit `errors.ts` doesn't already give exhaustively; a bare
`Error` would fail the exit criterion this whole package exists to meet — "an unsupported API
throws an error naming why," not a generic `TypeError: x is not a function`.

**Why `app.getVersion()`/`getPath()` require `app.whenReady()` first, when real Electron's
don't.** `handle-contracts.md`'s binding requirement 5 (`src/shim/README.md` carries the same
rule for the sibling family): a synchronous accessor is served from a value captured at
acquisition, never a cache an event fills in later. Real Electron's version comes from a
synchronous `package.json` read at process start; ours comes from `orivon.app.manifest()`, an
async broker round-trip, and no JavaScript turns a pending promise into a returned value on the
same call stack without a mechanism this repo does not have (`compatibility-matrix.md`'s A94,
unresolved for the same reason). `whenReady()` is the one honest way to bridge that gap, and it
asks nothing new of a ported app — real Electron code already gates its own startup on the
identical call.

**Why `getPath('userData')` returns `'.'`, not a fabricated absolute path.**
`src/broker/policy/paths.ts` rejects an absolute path outright (`'absolute'` — never re-rooted).
A value a porting app's own `path.join(app.getPath('userData'), 'x')` could turn into a rejected
`orivon.fs` call would be a trap, not a convenience. `'.'` joins to a plain relative path under
every `path.join`, including a future Node `path` shim (`src/shim/`'s family, not this one).

**Why `dialog.showOpenDialog` always refuses, rather than calling through when
`orivon.fs.userSelected` happens to exist.** It never does today — `compatibility-matrix.md`
Table 1 marks the broker's implementation ❌, and the preload does not expose it on
`window.orivon` either (`src/preload/orivon-surface.ts` exposes only `app.manifest`/`grants` and
`fs.readFile`/`writeFile`). Even a built broker would not close this cleanly: `userSelected`
resolves to a `FileHandle`, not a host OS path, so `OpenDialogReturnValue.filePaths` (a
`string[]` in real Electron) cannot be filled in without a further design decision about what a
ported app can honestly do with the result. Wiring a call through today would be building ahead
of both the broker and that decision — refusing now and revisiting when `fs.userSelected` lands
is the smaller, reversible choice.

**Why `ipcRenderer`/`ipcMain` share one bus with no broker call anywhere in `ipc.ts`.**
`ADR-0005` dissolved the app backend: all app code is renderer JavaScript, so a ported app's
"main process" and "renderer process" halves run in the exact same realm here. There is nothing
to cross and nothing to authorise — `ipc.ts` is a same-realm `Map`-backed request/response and
event registry, not IPC in the OS sense. Building broker plumbing for it would add a capability
check to a call that was never privileged in the first place.

**Why the desktop-shell refusals are three small classes rather than one generic Proxy.**
`app`/`dialog`/`ipcRenderer`/`ipcMain` are plain objects with a known, small set of methods, so a
factory function is the natural shape. `BrowserWindow`/`Menu`/`Tray` are used with `new` and with
statics real code calls before ever constructing one (`Menu.setApplicationMenu`,
`BrowserWindow.getAllWindows`) — a handful of named entry points that all do the same thing (name
the boundary, then throw) reads more plainly than a `Proxy` over a constructor doing the
equivalent through `construct`/`get` traps for a set of methods this small.

**Alias map coordination.** Wiring the bare specifier `electron` to this package's `index.ts` in
`electron.vite.config.ts`'s `renderer.resolve.alias` is the `shim` stream's exclusive append
point (`parallel-work.md`). This package does not add that entry — it is a parked coordination
question, reported rather than edited here.
