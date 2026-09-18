#!/usr/bin/env node
// Turns an upstream FreeTube web build into an Orivon app, WITHOUT modifying
// a line of FreeTube's own source.
//
// Two things a stock web build has no reason to carry, added here as a build
// step so the server that later hosts this stays a plain file server:
//   1. `/.well-known/orivon.json` -- the manifest, ./orivon.json, copied in.
//   2. a `<link rel="orivon-manifest">` in index.html -- the ONLY discovery
//      trigger Orivon has; without it nothing ever prompts.
//
// FreeTube is AGPL-3.0-or-later and its build output is deliberately NOT
// copied into this repository: source and destination both default to
// directories inside the clone. Point them elsewhere with --src/--out.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const clone = argValue('--clone', DEFAULT_CLONE)
const src = argValue('--src', join(clone, 'dist', 'web'))
const out = argValue('--out', join(clone, 'dist', 'orivon-web'))

const HINT = '<link rel="orivon-manifest" href="/.well-known/orivon.json">'

async function main () {
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
  await writeFile(join(out, 'index.html'), indexHtml)

  await mkdir(join(out, '.well-known'), { recursive: true })
  const manifest = await readFile(join(HERE, 'orivon.json'), 'utf8')
  await writeFile(join(out, '.well-known', 'orivon.json'), manifest)

  const hosts = JSON.parse(manifest).capabilities.net.https.connect.length
  console.log(`[prepare] ${out}\n[prepare] manifest declares ${String(hosts)} hosts; discovery hint injected into index.html`)
}

await main()
