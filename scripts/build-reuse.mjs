// Runs `electron-vite build` for scripts/build-e2e.mjs and scripts/build-ordinary.mjs, or skips it when
// out/ already holds the build of the same inputs (scripts/build-key.mjs). ORIVON_FORCE_BUILD=1 builds anyway.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { relativeToRoot, spawnCommandSync } from './cli.mjs'
import { buildKey } from './build-key.mjs'

export const OUTPUT_DIR = 'out'
export const KEY_FILE = 'out/.build-key'

/** What a finished build leaves: one entry of each of the three bundles. */
export const REQUIRED_OUTPUTS = ['out/main/start.js', 'out/main/index.js', 'out/preload/app.js', 'out/renderer/index.html']

/**
 * A digest of the name, size and modification second of every file in out/, taken when a build finishes and
 * compared before out/ is reused. `electron-vite dev` and a bare `electron-vite build` write into out/ without
 * touching the key file, and a key that outlived such a write would pass off their output as this build's.
 * Whole seconds, because a copy that keeps modification times may keep only those.
 */
export function outputsStamp (root) {
  const entries = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (full !== join(root, KEY_FILE)) {
        const { size, mtimeMs } = statSync(full)
        entries.push(`${relativeToRoot(root, full)}:${String(size)}:${String(Math.floor(mtimeMs / 1000))}`)
      }
    }
  }
  try {
    walk(join(root, OUTPUT_DIR))
  } catch {
    return null
  }
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function readKeyFile (root) {
  try {
    const { key, outputs } = JSON.parse(readFileSync(join(root, KEY_FILE), 'utf8'))
    return typeof key === 'string' && typeof outputs === 'string' ? { key, outputs } : null
  } catch {
    return null
  }
}

/** True when out/ is the finished build the key file names, still as that build left it. */
function isReusable (root, key) {
  const recorded = readKeyFile(root)
  return recorded !== null && recorded.key === key &&
    REQUIRED_OUTPUTS.every((path) => existsSync(join(root, path))) &&
    recorded.outputs === outputsStamp(root)
}

/**
 * Builds `kind` from `root` unless out/ already is that build, and returns the exit status.
 *
 * The key file is deleted before a build and written only after one succeeded with inputs still at the key
 * it started from, so an interrupted, failed or raced build never leaves a key that matches.
 *
 * @param {{ root: string, kind: 'e2e' | 'ordinary', env: NodeJS.ProcessEnv, build?: () => number,
 *   log?: (line: string) => void, runtime?: { node?: string, platform?: string, arch?: string } }} options `env` is what the build runs with.
 */
export function buildOrReuse ({ root, kind, env, build, log = console.log, runtime }) {
  const run = build ?? (() => spawnCommandSync('npx', ['electron-vite', 'build'], { cwd: root, env }).status ?? 1)
  const key = buildKey(root, kind, env, runtime)
  if (key !== null && env.ORIVON_FORCE_BUILD !== '1' && isReusable(root, key)) {
    log(`Reusing out/: no build input changed since this ${kind} build (key ${key.slice(0, 12)}). ORIVON_FORCE_BUILD=1 builds anyway.`)
    return 0
  }
  rmSync(join(root, KEY_FILE), { force: true })
  const status = run()
  if (status !== 0 || key === null) return status
  if (buildKey(root, kind, env, runtime) !== key) {
    log('A build input changed while the build ran: out/ is not recorded as reusable.')
    return status
  }
  const outputs = outputsStamp(root)
  if (outputs !== null) writeFileSync(join(root, KEY_FILE), JSON.stringify({ key, outputs }))
  return status
}
