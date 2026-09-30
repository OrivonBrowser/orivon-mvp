# `src/shim/bundler/`: the esbuild plugin a port bundles with

**What lives here.** [`esbuild-plugin.ts`](esbuild-plugin.ts), an esbuild plugin that points a
bundle's Node builtins (`fs`, `net`, `http`, `child_process`, `events`, ...) at this shim, and
[`alias-table.generated.json`](alias-table.generated.json), the table it reads. It is
tied to no Electron API: it runs in the build tool's Node, never in a page.

## Using it from a port

```js
import { build } from 'esbuild'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = join(process.env.ORIVON_MVP_ROOT, 'src/shim/bundler/esbuild-plugin.ts')
const { orivonShimPlugin, virtualRoot } = await import(pathToFileURL(plugin).href)
```

Run the build with Node 22.18 or later (type stripping is on by default), or pass
`--experimental-strip-types`. [`package.json`](package.json) beside the plugin marks this directory
an ES module, so Node loads it without a module-type warning. Then:

```js
await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [orivonShimPlugin()]
})
```

`virtualRoot` is `/orivon/app`, the one directory every Node-shaped path in an app agrees on.

**A port locates this checkout through the `ORIVON_MVP_ROOT` environment variable.** Provisional:
it needs a checkout beside the port, and a published package would settle it.

### `node:sqlite`

An app that opens a database imports `orivon-node-shim/sqlite-ready` first, before any code that
requires `node:sqlite`; the plugin resolves that name to [`../sqlite/ready.ts`](../sqlite/ready.ts),
whose top-level `await` finishes the engine's asynchronous start-up. The bundle is therefore an ES
module (`format: 'esm'`), and a forked child imports it as one.

```js
// server/index.ts
import 'orivon-node-shim/sqlite-ready'
import './main.js' // and whatever else requires 'node:sqlite'
```

The plugin also bundles the engine's browser build (`@sqlite.org/sqlite-wasm/dist/index.mjs`) under
`platform: 'node'`; the package's `node` condition names a build that reads the disk with Node's `fs`.
The engine fetches `sqlite3.wasm` at `new URL('sqlite3.wasm', import.meta.url)`: **relative to the
module that holds its code, which is the bundle file itself**, whether a page or a forked child
loads it. Copy each file `shimAssets()` lists into the bundle's directory, with the name it gives:

```js
const { shimAssets } = await import(pathToFileURL(plugin).href)
for (const { name, path } of shimAssets()) copyFileSync(path, join(outDir, name))
```

A bundle split into chunks needs the file beside the chunk that holds the engine; a single-file
bundle needs it beside that file. `loadSqliteEngine({ wasmBinary })` in a ready module of the app's
own replaces the fetch.

## What the plugin does

- Every `ready` row of `module-map.ts` matches its specifier whole, bare and `node:`-prefixed; a
  `prefixOnly` row (`sqlite`) matches `node:sqlite` alone, since the bare name is another npm package.
  A `local` row resolves to the `.ts` file in this checkout, a `package` row to the package in
  this checkout's `node_modules`, whatever directory the port builds from.
- Any other Node builtin (`cluster`, `v8`, `inspector`, ...) fails the build with
  an error naming the specifier and the file that imported it. Left to esbuild, `platform: 'node'`
  would keep it as an external `import`, and the bundle would fail only when run.
- An unmapped builtin's error reads exactly `'<name>' is a Node builtin the Orivon shim has no
  module for (imported from <file>); see src/shim/module-map.ts`; a port parses it, so the wording
  is stable.
- It registers `onResolve` only: a port adds its own `onLoad`.

## Design notes

**The plugin loads without this repository's TypeScript setup.** It is erasable TypeScript, imports
only `node:` modules and `import type` from esbuild, and reads its alias table as JSON, because a
port loads it by absolute path under Node's type stripping: no `.js` specifier that names a `.ts`
file, no tsconfig paths, no `enum`. `tests/esbuild-plugin.test.ts` loads it that way from a
temporary directory. `tests/alias-table.test.ts` fails when the JSON is stale;
`ORIVON_WRITE_ALIAS_TABLE=1` rewrites it after a `module-map.ts` edit.

**A package the shim depends on keeps its `browser` field, even under `platform: 'node'`.**
`crypto-browserify` and what it stands on (`create-hash`, `randombytes`, `browserify-sign`, ...)
each ship a Node entry point that requires the very builtin they implement; through this plugin
that is the shim's `crypto` again, and the cycle leaves `createHash` undefined. esbuild applies a
`browser` field only for `platform: 'browser'`, so the plugin applies it, for the files of the shim
and of the packages this checkout's `dependencies` reach, and for those only: the port's own
packages, and this checkout's devDependencies, resolve as a Node bundle does. Provisional: it
reimplements the part of esbuild's `browser` handling the shim's tree needs (a string that replaces
`main`, whether `main` is written `lib/index.js` or `./lib`; `"./file": "./other"` and `"lib/file": "lib/other"`,
with or without an extension; `"name": false`), and a nested `package.json` with no `name` (only a `type`)
belongs to the package above it. A published package would ship this tree already bundled.

**A package row named like a builtin is asked for with a trailing slash** (`events/`). Under
`platform: 'node'`, esbuild otherwise answers `events` with the builtin.

**A CommonJS `require()` of a local module gets its default export.**
`require('assert')` is the function in Node, `require('process')` is the global, and `require('fs').x = y`
patches the one module every other file sees, while esbuild answers a `require()` of an ES module with
a copy of its namespace. The plugin answers a `require-call` of a local row with a small CommonJS
wrapper (the `orivon-shim-require` namespace) that exports the default when it is a function or an
object, and a copy of the namespace only when a module has no default.

**What it may depend on.** Node's own modules, and `import type` from `esbuild`.
**What it must never import.** Any other file of this repository, [`src/broker/`](../../broker/)
or `electron`. `is-shim-source.ts` treats this directory as build tooling: a module here resolves
`node:fs` to Node's own.
