/**
 * Fails if the developer-only grant path (docs/planning/unattended-build-
 * queue.md item 0.3, src/main/dev-grant.ts) is reachable in an ordinary
 * build -- the same one `npm run build` and `npm run package:linux` produce.
 * It must exist only for `npm run test:e2e`, the sole caller that sets
 * ORIVON_ENABLE_DEV_GRANT (scripts/build-e2e.mjs).
 *
 * HOW: run scripts/build-ordinary.mjs FOR REAL -- the exact command `npm run
 * build`/`npm run package:linux` run, not a reimplementation of it -- then
 * grep the actual compiled output in out/ for the hook's marker symbol.
 * Checking the real command's compiled behaviour, rather than the source, is
 * the point -- a `define` a bundler failed to fold away, a stray second call
 * site, or `build-ordinary.mjs` itself no longer being what `build` runs,
 * would all still show up here even if every source file looks correct on
 * its own.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

/** The dev-grant hook's global name -- present in compiled output only if the path survived into it. */
export const DEV_GRANT_MARKER = '__orivonDevGrant'

/** Where `electron-vite build` writes compiled output (electron.vite.config.ts has no `outDir` override). */
const OUTPUT_DIR = 'out'

/**
 * @param {string} root Repository root.
 * @param {{ build?: () => void, outputDir?: string }} [opts] `build` runs an
 *   ordinary (flag-unset) build; overridable so this guard's own test does
 *   not have to invoke a real electron-vite build. `outputDir` is scanned
 *   afterwards, root-relative.
 * @returns {{ ok: boolean, offenders: string[] }}
 */
export function checkDevGrantAbsent (root, opts = {}) {
  const build = opts.build ?? (() => { runOrdinaryBuild(root) })
  build()

  const dir = join(root, opts.outputDir ?? OUTPUT_DIR)
  const offenders = collectJsFiles(dir)
    .filter((file) => readSafe(file).includes(DEV_GRANT_MARKER))
    .map((file) => relativeToRoot(root, file))
    .sort()

  return { ok: offenders.length === 0, offenders }
}

/** The same command `npm run build` runs -- see scripts/build-ordinary.mjs for why it, not a bare `electron-vite build`, is the one to check. */
function runOrdinaryBuild (root) {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-ordinary.mjs')], { cwd: root, stdio: 'inherit' })
}

function collectJsFiles (dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // no output directory: nothing to scan, nothing to flag
  }
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectJsFiles(full))
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(full)
  }
  return files
}

function readSafe (file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, offenders } = checkDevGrantAbsent(process.cwd())

  if (!ok) {
    console.error('\nThe developer-only grant path is reachable in an ordinary build:\n')
    for (const file of offenders) console.error(`  ${file}`)
    console.error(
      '\nsrc/main/dev-grant.ts must be compiled out unless ORIVON_ENABLE_DEV_GRANT=1 was set' +
      "\nat build time (electron.vite.config.ts's `define`, scripts/build-e2e.mjs). See" +
      '\ndocs/planning/unattended-build-queue.md item 0.3.\n'
    )
    process.exit(1)
  }

  console.log(`The developer-only grant path is absent from an ordinary build (scanned ${OUTPUT_DIR}/).`)
}
