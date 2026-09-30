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
`--experimental-strip-types`. Then:

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

## What the plugin does

- Every `ready` row of `module-map.ts` matches its specifier whole, bare and `node:`-prefixed.
  A `local` row resolves to the `.ts` file in this checkout, a `package` row to the package in
  this checkout's `node_modules`, whatever directory the port builds from.
- Any other Node builtin (`cluster`, `node:sqlite` until it has a row, ...) fails the build with
  an error naming the specifier and the file that imported it. Left to esbuild, `platform: 'node'`
  would keep it as an external `import`, and the bundle would fail only when run.
- It registers `onResolve` only: a port adds its own `onLoad`.

## Design notes

**The plugin loads without this repository's TypeScript setup.** It is erasable TypeScript, imports
only `node:` modules and `import type` from esbuild, and reads its alias table as JSON, because a
port loads it by absolute path under Node's type stripping: no `.js` specifier that names a `.ts`
file, no tsconfig paths, no `enum`. `tests/esbuild-plugin.test.ts` loads it that way from a
temporary directory. `tests/alias-table.test.ts` fails when the JSON is stale;
`ORIVON_WRITE_ALIAS_TABLE=1` rewrites it after a `module-map.ts` edit.

**A package row named like a builtin is asked for with a trailing slash** (`events/`). Under
`platform: 'node'`, esbuild otherwise answers `events` with the builtin.

**What it may depend on.** Node's own modules, and `import type` from `esbuild`.
**What it must never import.** Any other file of this repository, [`src/broker/`](../../broker/)
or `electron`. `is-shim-source.ts` treats this directory as build tooling: a module here resolves
`node:fs` to Node's own.
