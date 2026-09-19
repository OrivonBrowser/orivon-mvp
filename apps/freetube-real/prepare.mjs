#!/usr/bin/env node
// Turns an upstream FreeTube build into an Orivon app, WITHOUT modifying a
// line of FreeTube's own source.
//
// Three things a stock build has no reason to carry, added here as a build
// step so the server that later hosts this stays a plain file server:
//   1. `/.well-known/orivon.json` -- the manifest, ./orivon.json, copied in.
//   2. a `<link rel="orivon-manifest">` in index.html -- the ONLY discovery
//      trigger Orivon has; without it nothing ever prompts.
//   3. (--build only) the ft-electron-bridge.js <script> and botGuardScript.js
//      the Electron-renderer build needs -- see README.md's "Why the
//      Electron renderer, not the web build".
//
// FreeTube is AGPL-3.0-or-later and its build output is deliberately NOT
// copied into this repository: source and destination both default to
// directories inside the clone. Point them elsewhere with --src/--out.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildShimBundle } from './build-shim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CLONE = '/home/jhon/git/freetube-src'

/**
 * The sandboxed iframe youtubei.js needs to decipher YouTube's `n`/signature
 * parameters. Without it the Local API reaches YouTube, gets a player
 * response, and then fails with "Please setup the eval function for the n/sig
 * deciphering" -- so no video details load at all.
 *
 * `src/index.ejs` renders this only under `IS_ELECTRON`, because upstream
 * disables the Local API for the web entirely. Built here instead, from
 * FreeTube's OWN `_scripts/sigFrameConfig.js`, so the data: URL and its CSP
 * hash are the same bytes their Electron build ships rather than a
 * reimplementation of their hashing that could drift.
 *
 * It stays sandboxed exactly as upstream has it: `allow-scripts` only, no
 * same-origin, and a CSP that permits nothing but the one hashed script.
 */
async function sigFrameMarkup (cloneRoot) {
  let parameters
  try {
    const requireFromHere = createRequire(import.meta.url)
    parameters = requireFromHere(join(cloneRoot, '_scripts', 'sigFrameConfig.js')).sigFrameTemplateParameters
  } catch (error) {
    console.warn(`[prepare] no sigFrame (${error instanceof Error ? error.message : String(error)}) -- the Local API will fail at n/sig deciphering`)
    return undefined
  }
  return '<iframe id="sigFrame"' +
    ` src="${parameters.sigFrameSrc}"` +
    ` csp="default-src 'none'; script-src '${parameters.sigFrameCspHash}' 'unsafe-eval'"` +
    ' sandbox="allow-scripts" height="1" width="1"' +
    ' style="display: none; pointer-events: none" tabindex="-1"></iframe>'
}

function argValue (name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const BUILD = process.argv.includes('--build')

const clone = argValue('--clone', DEFAULT_CLONE)
const src = argValue('--src', BUILD ? join(clone, 'dist', 'orivon-electron-web') : join(clone, 'dist', 'web'))
const out = argValue('--out', BUILD ? join(clone, 'dist', 'orivon-electron') : join(clone, 'dist', 'orivon-web'))

const HINT = '<link rel="orivon-manifest" href="/.well-known/orivon.json">'
const BRIDGE_SCRIPT = '<script src="/orivon/ft-electron-bridge.js"></script>'
// Loaded classic, synchronous, and AFTER the bridge's own <script> tag but
// BEFORE FreeTube's bundle -- the bridge's db* members read
// `globalThis.__orivonFtDatastore` lazily, at call time rather than at
// install time, precisely because this script has not run yet when the
// bridge's own top-level `installFtElectronBridge(...)` call does (see
// bridge/ft-datastore-entry.js's own header).
const DATASTORE_SCRIPT = '<script src="/orivon/ft-datastore.js"></script>'

/**
 * Runs upstream's OWN webpack, through ./webpack.orivon.config.cjs, then
 * the second bundle (upstream's own main-process datastore code, over this
 * repo's Node shim) through ./webpack.orivon-datastore.config.cjs, then
 * upstream's OWN `pnpm run pack:botGuardScript` -- all three in the clone,
 * all three needing the clone lock (agent-rules.md). None of them writes
 * anything into this repository; the two config files are the only things
 * of ours involved. The datastore bundle's own shim dependency is compiled
 * FIRST, from whatever src/shim/ is in THIS repo's tree right now (README.md's
 * "Where the shim comes from") -- webpack has no TypeScript loader, so it
 * can only consume that step's plain-JS output, never src/shim/ directly.
 */
function buildElectronRenderer () {
  const env = { ...process.env, FREETUBE_CLONE: clone, NODE_ENV: 'production' }

  const webpack = spawnSync('npx', ['webpack', '--mode=production', '--config', join(HERE, 'webpack.orivon.config.cjs')], { cwd: clone, env, stdio: 'inherit' })
  if (webpack.status !== 0) throw new Error(`[prepare] webpack build failed (exit ${String(webpack.status)})`)

  return buildShimBundle()
    .then(() => {
      const datastore = spawnSync('npx', ['webpack', '--mode=production', '--config', join(HERE, 'webpack.orivon-datastore.config.cjs')], { cwd: clone, env, stdio: 'inherit' })
      if (datastore.status !== 0) throw new Error(`[prepare] datastore webpack build failed (exit ${String(datastore.status)})`)

      const botGuard = spawnSync('pnpm', ['run', 'pack:botGuardScript'], { cwd: clone, env, stdio: 'inherit' })
      if (botGuard.status !== 0) throw new Error(`[prepare] pack:botGuardScript failed (exit ${String(botGuard.status)})`)
    })
}

async function main () {
  // Awaited now, unlike the single-webpack version this replaced: that one
  // returned after two synchronous spawnSync calls, so the function had
  // already finished its own work by the time it returned even unawaited.
  // buildElectronRenderer() now also runs buildShimBundle() (a real async
  // esbuild call), so skipping the await would let main() read `src`
  // before the datastore bundle -- and even the botGuard pack after it --
  // had finished.
  if (BUILD) await buildElectronRenderer()

  let indexHtml
  try {
    indexHtml = await readFile(join(src, 'index.html'), 'utf8')
  } catch {
    console.error(`[prepare] no build at ${src}\n  build it first:  cd ${DEFAULT_CLONE} && pnpm run pack:web`)
    process.exitCode = 1
    return
  }

  await cp(src, out, { recursive: true })

  if (!indexHtml.includes('id="sigFrame"')) {
    const frame = await sigFrameMarkup(clone)
    if (frame !== undefined) {
      indexHtml = indexHtml.includes('<div id="app"></div>')
        ? indexHtml.replace('<div id="app"></div>', `<div id="app"></div>\n    ${frame}`)
        : indexHtml.replace('</body>', `  ${frame}\n</body>`)
    }
  }

  if (!indexHtml.includes('rel="orivon-manifest"')) {
    // Before </head> when there is one, else at the very top: the watcher
    // scans the delivered document once and takes the FIRST hint, so where
    // it sits only has to be inside the document it was delivered in.
    indexHtml = indexHtml.includes('</head>')
      ? indexHtml.replace('</head>', `  ${HINT}\n</head>`)
      : `${HINT}\n${indexHtml}`
  }

  if (BUILD && !indexHtml.includes(BRIDGE_SCRIPT)) {
    // FIRST script in <head>, classic and synchronous: FreeTube's own
    // bundle calls window.ftElectron.handleChangeView at module top level
    // (src/renderer/main.js), so the bridge has to already exist by then.
    // The datastore bundle goes right after it, still before FreeTube's own
    // bundle -- DATASTORE_SCRIPT's own comment says why the order between
    // these first two does not actually matter at runtime, only that both
    // precede FreeTube's.
    indexHtml = indexHtml.includes('<head>')
      ? indexHtml.replace('<head>', `<head>\n    ${BRIDGE_SCRIPT}\n    ${DATASTORE_SCRIPT}`)
      : `${BRIDGE_SCRIPT}\n${DATASTORE_SCRIPT}\n${indexHtml}`
  }
  await writeFile(join(out, 'index.html'), indexHtml)

  await mkdir(join(out, '.well-known'), { recursive: true })
  const manifest = await readFile(join(HERE, 'orivon.json'), 'utf8')
  await writeFile(join(out, '.well-known', 'orivon.json'), manifest)

  if (BUILD) {
    await mkdir(join(out, 'orivon'), { recursive: true })
    await cp(join(HERE, 'bridge', 'ft-electron-bridge.js'), join(out, 'orivon', 'ft-electron-bridge.js'))
    await cp(join(clone, 'dist', 'botGuardScript.js'), join(out, 'orivon', 'botGuardScript.js'))
    await cp(join(clone, 'dist', 'orivon-electron-datastore', 'datastore.js'), join(out, 'orivon', 'ft-datastore.js'))
  }

  const hosts = JSON.parse(manifest).capabilities.net.https.connect.length
  console.log(`[prepare] ${out}\n[prepare] manifest declares ${String(hosts)} hosts; discovery hint injected into index.html`)
}

await main()
