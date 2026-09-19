#!/usr/bin/env node
// Pre-compiles the ONE src/shim/ TypeScript module the FreeTube datastore
// bundle needs (fs -- node-fs.ts) into a single plain-JS ES module, with
// esbuild bundling in every relative dependency it has inside src/shim/ and
// src/shim-electron/ (orivon-global.ts, node-fs-handle.ts, errors.ts, ...).
//
// WHY THIS EXISTS: webpack.orivon-datastore.config.cjs runs FreeTube's own
// clone webpack, which has no TypeScript loader configured -- it can only
// consume plain JS. This script is that config's own prerequisite, never
// run by it directly (see prepare.mjs's --build step, which runs this
// first). `src/shim/` itself is never edited or copied by this script, only
// read -- see README.md's "Where the shim comes from".
//
// `external` lists every module-map.ts kind: 'package' specifier the
// downstream webpack config already aliases to a real npm polyfill
// (originally for nedb's own imports), not only the ones node-fs.ts
// happens to reach today -- see README.md's "Where the shim comes from"
// for why the list is kept wider than the current call graph.
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SHIM_ENTRY = join(REPO_ROOT, 'src', 'shim', 'node-fs.ts')
const OUT_DIR = join(HERE, 'build', 'shim')

export async function buildShimBundle () {
  if (!existsSync(SHIM_ENTRY)) {
    throw new Error(`[build-shim] no src/shim/node-fs.ts at ${SHIM_ENTRY} -- run from a checkout that has it`)
  }
  await build({
    entryPoints: { fs: SHIM_ENTRY },
    outdir: OUT_DIR,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['buffer', 'stream', 'path', 'events', 'crypto', 'util'],
    logLevel: 'silent'
  })
  console.log(`[build-shim] ${join(OUT_DIR, 'fs.js')}`)
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  await buildShimBundle()
}
