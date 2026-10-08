# ADR-0073: An app sees a Node `process`, on Linux, x64

- **Status:** accepted, provisional
- **Date:** 2026-10-08
- **Type:** architecture
- **Decided by:** AI recommendation under owner decision d-0594 (apps are Node-shaped by default); the values below are provisional until the owner confirms them

## Decision
The `process` and `os` an app reads, in its page and in a forked child or thread, present as Node:

| Member | Value |
|---|---|
| `process.version`, `process.versions.node` | `v24.11.1` and `24.11.1`: the Node release the shim's surface is measured against (`node-builtin-exports.generated.json`), read from there, never a second constant |
| `process.versions` (other keys) | none: each is a build fact the shim cannot state honestly (`modules` and `napi` pick a native binary, and none runs; `v8`, `uv` and the rest describe a Node build) |
| `process.browser` | absent, as in Node |
| `process.platform`, `os.platform()`, `os.type()` | `linux`, `linux`, `Linux`, on every host |
| `process.arch`, `os.arch()` | `x64`, on every host |
| `process.release.name`, `process.title` | `node` |
| `process.versions.electron`, `process.versions.chrome`, `process.type` | never set by Orivon |

`Object.prototype.toString.call(process)` is `[object process]`. A forked child and a thread take the
same values from the same function.

## Context
d-0079 gave an app a browser-shaped `process` (`version: ''`, `versions: {}`, `browser: true`, `platform:
'browser'`, `arch: 'javascript'`) so that a library took its browser path. Owner decision d-0594
reverses it: Orivon's Node layer presents as Node, and a port bundles for Node (CLAUDE.md Rule 21).
The browser shape had a cost every port met: `iconv-lite` 0.4 enables its stream API only when
`process.versions.node` is set (subtitles failed in a ported torrent client), `application-config-path`
throws on an unknown platform, and a port had to compile Electron's values into its bundle to get the
paths upstream takes.

## Alternatives considered
- **`platform` of the host (`win32`, `darwin`, `linux`).** Rejected. The shim's file system is POSIX on
  every host (`/orivon/app`, forward slashes, case-sensitive, `virtual-root.ts`). A library on `win32`
  would build backslash paths and drive letters, look for `%APPDATA%`, and spawn `cmd.exe`, none of which
  the shim honours. The platform is the one whose rules the app's files follow, not the host's.
- **`darwin`.** Rejected: it adds Apple-specific code paths (`Library/Application Support`, keychain calls)
  with no reason to prefer them over Linux's XDG directories under `$HOME`, which the shim also honours.
- **`arch` of the host, or `wasm32`.** Rejected. A host `arm64` would send a library looking for an arm64
  prebuild on an Intel machine's behalf, and `wasm32` is not a value Node reports, so a `switch` on it
  falls to a default or throws. `x64` is a value every loader knows; natives run as WebAssembly
  (ADR-0040), so no prebuild of any architecture is present, and a loader that looks for one
  (`node-gyp-build`, a napi-rs v2 `index.js`) finds nothing and fails by name, as under Node without a
  prebuild. The addon loader of `src/shim/addon/` does not read `process.arch` or `process.platform`.
- **More `versions` keys (`v8`, `uv`, `modules`).** Rejected: a made-up `modules` would make a native
  loader pick an ABI that does not exist, and `v8` is the second half of a Node test some libraries
  use to choose the Node HTTP client over the browser's (a web-built bundle of AirGap Vault carries one:
  `process.versions.node && process.versions.v8`). With `node` alone such a bundle keeps `fetch`, which
  is the client the shim serves best.
- **Keeping `browser: true`.** Rejected by d-0594: it is the flag that sent every library to its
  browser path.

## Reasoning
Under Node a library asks `process` which path to take; an app Orivon runs is a Node program, so the
answer is Node, and a bundle built for Node behaves as it does under Node and Electron. `linux` is the
one platform whose rules the virtual file system already follows, so the paths a library builds from
`platform` are paths the shim serves. `x64` is the least surprising value for a field with no honest
answer, because no code path that depends on it exists to be misled.

Measured on real ports (the regression sweep in the pull request): FreeTube, Element, ASGARDEX, AirGap
Vault, Explore, WebTorrent and The Lounge render and do their main job before and after the change,
with the same page errors. The one consequence found is in WebTorrent Desktop (see Consequences).

## Consequences
- A library that detects Node (`process.versions.node`) now takes its Node path. Where that path needs a
  member the shim lacks, the call fails by name (`OrivonShimError`), where the browser path used to
  work silently.
- A port that compiled Electron's `process` values into its bundle to work around the browser shape
  can drop the workaround; one that relied on the browser shape (an `isProduction()` that read an
  unknown platform as false) must now say what it means.
- A library keyed on `process.browser` may lose a fast path. crypto-browserify's `pbkdf2` asked SubtleCrypto
  only when `process.browser` was `true`, so the shim's own `crypto.pbkdf2` now reaches SubtleCrypto itself
  (`polyfills/pbkdf2-native.ts`); another dependency with the same habit would be slower, not wrong.
- Emscripten glue on a page tests `process.versions.node` (and, in newer releases, `process.type !=
  'renderer'`) and so takes its Node branch, which reads the `.wasm` through `fs`. An app builds it for
  `web,worker`, or sets `process.type` to `renderer` as Electron's renderer has. Not measured: no port of
  the sweep runs Emscripten glue on its main page.
- WebTorrent Desktop's `config.js` treats `platform === 'linux'` with an `execPath` that does not end in
  `/electron` as a packaged install, and so started its telemetry and update check. Found by the sweep and
  closed in the port by compiling an Electron development run's `execPath` into its bundle (an
  orivon-ports change); a published copy needs a rebuild.
- `process.platform` is `linux` on a Windows or macOS host. A program that asks the platform in order
  to find a host path (`%LOCALAPPDATA%`, `~/Library`) finds the virtual root instead, which is the
  only place an app's files are.
- Orivon states no Electron identity: an Electron port's own build sets `versions.electron` and
  `process.type` to what its upstream runs.

## Reversibility
- **Cost to reverse:** cheap for any one value (`node-identity.ts`), moderate for the stance, since
  ports will have dropped their workarounds.
- **What would make us revisit:** a port that fails because a library asked for a Windows or macOS
  path the shim could serve, or a native loader that mis-selects a build for `x64`.
