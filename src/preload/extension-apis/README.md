# `src/preload/extension-apis/`: Orivon's own `chrome.*` namespaces

**What lives here.** The registry of namespaces Orivon adds to `chrome.*` in an extension's own
context (`apis.ts`), the type of what the library's renderer seam hands them (`crx.d.ts`), and
`register.ts`, which gives the list to the library's preload. Tied to Electron, entirely: every
entry runs in an extension page or service worker's main world.

**What it depends on.** The type `chrome` (`@types/chrome`) and
[`vendor/electron-chrome-extensions`](../../../vendor/electron-chrome-extensions/)'s
`src/renderer/extras.ts`, from `register.ts` only.

**What it must never import.** Anything from `src/main/`, `src/broker/` or `src/contracts/`, and
no module at all from an entry in `apis.ts` (see below).

## Design notes

**Each entry is one self-contained function.** The library runs an entry with
`contextBridge.executeInMainWorld({ func })`, which sends the function's source text and nothing
else: an import, a helper in the same file or any outer identifier is a `ReferenceError` in the
page. `tests/self-contained.test.ts` rebuilds every entry from `fn.toString()` against a fake
`__crx` and expects it to define at least one namespace without throwing.

**What an entry may use.** `globalThis.__crx` (`crx.d.ts`): `declares(permission)`, `call(name)`
for a main-side handler, `event(name)` for an event main routes, and `define(ns, build)`. Whether
a permission is granted is main's answer; `declares` only says the manifest asks for it.
`__crx` and the library's `electron` bridge are deleted, and `chrome` is locked, after the last
entry has run.
