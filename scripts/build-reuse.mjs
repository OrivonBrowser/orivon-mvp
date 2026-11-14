// Runs `electron-vite build` for scripts/build-e2e.mjs and scripts/build-ordinary.mjs, or skips it when
// out/ already holds the build of the same inputs (scripts/build-key.mjs), or when the build of this kind that
// out/ replaced waits in .cache/build/<kind>/ and its inputs are still the same. ORIVON_FORCE_BUILD=1 builds anyway.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { relativeToRoot, spawnCommandSync } from './cli.mjs'
import { KINDS, buildKey } from './build-key.mjs'

export const OUTPUT_DIR = 'out'
export const KEY_FILE = 'out/.build-key'

/**
 * Where a build of each kind waits while the other kind is in out/: `.cache/build/<kind>/` holds exactly what
 * out/ held, key file included, so a move by rename carries a build and its key together.
 */
export const CACHE_DIR = '.cache/build'

/** What a finished build leaves: one entry of each of the three bundles. */
export const REQUIRED_OUTPUTS = ['out/main/start.js', 'out/main/index.js', 'out/preload/app.js', 'out/renderer/index.html']

const KEY_NAME = '.build-key'

const slotOf = (kind) => `${CACHE_DIR}/${kind}`

/**
 * `env` as the build of `kind` runs with it: the developer-only grant flag is set for the e2e kind and absent
 * for the ordinary one, as scripts/build-e2e.mjs and scripts/build-ordinary.mjs pass it.
 */
function kindEnv (kind, env) {
  const own = { ...env }
  if (kind === 'e2e') own.ORIVON_ENABLE_DEV_GRANT = '1'
  else delete own.ORIVON_ENABLE_DEV_GRANT
  return own
}

/**
 * A digest of the name, size and modification second of every file in `dir` (out/ or a parked copy of it, as a
 * path relative to `root`), taken when a build finishes and compared before it is reused. `electron-vite dev`
 * and a bare `electron-vite build` write into out/ without touching the key file, and a key that outlived such
 * a write would pass off their output as this build's. Names are relative to `dir`, so a build keeps its stamp
 * when it moves. Whole seconds, because a copy that keeps modification times may keep only those.
 */
export function outputsStamp (root, dir = OUTPUT_DIR) {
  const entries = []
  const base = join(root, dir)
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (full !== join(base, KEY_NAME)) {
        const { size, mtimeMs } = statSync(full)
        entries.push(`${relativeToRoot(base, full)}:${String(size)}:${String(Math.floor(mtimeMs / 1000))}`)
      }
    }
  }
  try {
    walk(base)
  } catch {
    return null
  }
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

/** The record a finished build leaves in `dir`, or null when there is none or it is damaged. */
function readKeyFile (root, dir) {
  try {
    const { key, outputs, kind } = JSON.parse(readFileSync(join(root, dir, KEY_NAME), 'utf8'))
    return typeof key === 'string' && typeof outputs === 'string' && KINDS.includes(kind) ? { key, outputs, kind } : null
  } catch {
    return null
  }
}

/** True when `dir` is the finished build of `kind` that its key file names for `key`, still as that build left it. */
function isBuildOf (root, dir, kind, key) {
  const recorded = readKeyFile(root, dir)
  return recorded !== null && recorded.kind === kind && recorded.key === key &&
    REQUIRED_OUTPUTS.every((path) => existsSync(join(root, dir, path.slice(OUTPUT_DIR.length + 1)))) &&
    recorded.outputs === outputsStamp(root, dir)
}

/** Removes `dir`, its key file first so that a removal cut short leaves no record of a build. A folder that cannot be removed stays. */
function drop (root, dir) {
  try {
    rmSync(join(root, dir, KEY_NAME), { force: true })
    rmSync(join(root, dir), { recursive: true, force: true })
  } catch {
    // What remains is checked against its key and its stamp before it is ever used.
  }
}

/**
 * Moves the build of the other kind that out/ holds into its slot, so building `kind` does not destroy it. Only
 * a build whose key is the one its kind has now is worth keeping, and only a rename moves it: it is atomic and
 * cheap, and a refused one (a file held open on Windows, another volume) leaves out/ as it was for the build to
 * overwrite. The slot's old build is dropped first, so each kind keeps one copy.
 */
function parkOutput ({ root, kind, env, runtime, log }) {
  const held = readKeyFile(root, OUTPUT_DIR)
  if (held === null || held.kind === kind) return
  const key = buildKey(root, held.kind, kindEnv(held.kind, env), runtime)
  if (key === null || !isBuildOf(root, OUTPUT_DIR, held.kind, key)) return
  try {
    mkdirSync(join(root, CACHE_DIR), { recursive: true })
    drop(root, slotOf(held.kind))
    renameSync(join(root, OUTPUT_DIR), join(root, slotOf(held.kind)))
    log(`Parked the ${held.kind} build of out/ in ${slotOf(held.kind)}/.`)
  } catch {
    // out/ stays where it is.
  }
}

/** Moves the parked build of `kind` into out/ when it is the build of `key`, and says whether out/ now holds it. */
function restoreOutput ({ root, kind, key }) {
  if (!isBuildOf(root, slotOf(kind), kind, key)) return false
  try {
    drop(root, OUTPUT_DIR)
    renameSync(join(root, slotOf(kind)), join(root, OUTPUT_DIR))
  } catch {
    return false
  }
  return isBuildOf(root, OUTPUT_DIR, kind, key)
}

/**
 * Builds `kind` from `root` unless out/ already is that build or its slot holds it, and returns the exit status.
 *
 * The key file is deleted before a build and written only after one succeeded with inputs still at the key
 * it started from, so an interrupted, failed or raced build never leaves a key that matches. The key file
 * lives in the folder it describes, which moves whole by rename: out/ and its key never part.
 *
 * @param {{ root: string, kind: 'e2e' | 'ordinary', env: NodeJS.ProcessEnv, build?: () => number,
 *   log?: (line: string) => void, runtime?: { node?: string, platform?: string, arch?: string } }} options `env` is what the build runs with.
 */
export function buildOrReuse ({ root, kind, env, build, log = console.log, runtime }) {
  const run = build ?? (() => spawnCommandSync('npx', ['electron-vite', 'build'], { cwd: root, env }).status ?? 1)
  const key = buildKey(root, kind, env, runtime)
  const reuse = (where) => {
    log(`Reusing out/${where}: no build input changed since this ${kind} build (key ${String(key).slice(0, 12)}). ORIVON_FORCE_BUILD=1 builds anyway.`)
    return 0
  }
  if (key !== null) {
    const forced = env.ORIVON_FORCE_BUILD === '1'
    if (!forced && isBuildOf(root, OUTPUT_DIR, kind, key)) return reuse('')
    parkOutput({ root, kind, env, runtime, log })
    if (!forced && restoreOutput({ root, kind, key })) return reuse(` (moved back from ${slotOf(kind)}/)`)
    // out/ is about to hold this kind, so an older build of it in the slot would be a second copy.
    drop(root, slotOf(kind))
  }
  rmSync(join(root, KEY_FILE), { force: true })
  const status = run()
  if (status !== 0 || key === null) return status
  if (buildKey(root, kind, env, runtime) !== key) {
    log('A build input changed while the build ran: out/ is not recorded as reusable.')
    return status
  }
  const outputs = outputsStamp(root)
  if (outputs !== null) writeFileSync(join(root, KEY_FILE), JSON.stringify({ key, outputs, kind }))
  return status
}
