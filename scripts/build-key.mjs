// The key of a build: a digest of everything `electron-vite build` reads (electron.vite.config.ts and its
// imports), so scripts/build-reuse.mjs can skip a build whose inputs have not changed. Git only, argument
// arrays and no shell, so it runs the same on Windows and macOS.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const KINDS = ['e2e', 'ordinary']

/**
 * Paths, relative to the repository root, that the build reads. `src/` holds its own unit tests, so a unit
 * test edit is a new key: scripts/tests/build-key-inputs.test.ts fails when a file the build reaches lies
 * outside these paths, which is how a new input gets added here.
 */
export const BUILD_INPUTS = [
  'src',
  'vendor',
  'resources',
  'docs/privacy/notice.md',
  'scripts/build-commit.ts',
  'scripts/chunk-check-worker-bundle.ts',
  'scripts/privacy-notice-plugin.ts',
  'electron.vite.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'CHANGELOG.md'
]

/** Packages whose installed version steers the output: electron-vite targets the installed Electron's Node and Chromium. */
const TOOL_PACKAGES = ['electron', 'electron-vite', 'vite']

/** Variables electron-vite and Vite read, besides the dev-grant flag, which `define` folds to a boolean. */
const ENV_NAMES = ['NODE_ENV', 'NODE_ENV_ELECTRON_VITE']
const ENV_PREFIXES = ['VITE_', 'MAIN_VITE_', 'PRELOAD_VITE_', 'RENDERER_VITE_']

const KEY_FORMAT = '1'

/** @returns {Buffer} stdout of git run in `root`, with no optional lock taken on the index. */
function git (root, args, input) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024
  })
}

const paths = (output) => output.toString('utf8').split('\0').filter(Boolean)

/**
 * The blob id of every file the working tree holds under BUILD_INPUTS, by path: the index's id for a file
 * unchanged since it was staged, git's own hash of the file for one edited since or untracked and not ignored.
 * Null when a conflict is open, a file is hidden from git's change check, or a name could not be passed to git as a line.
 */
function workingTreeBlobs (root) {
  const blobs = new Map()
  // A file marked assume-unchanged or skip-worktree hides its edits from `-m`, so its index id could be stale.
  if (paths(git(root, ['ls-files', '-v', '-z', '--', ...BUILD_INPUTS])).some((entry) => !entry.startsWith('H '))) return null
  for (const entry of paths(git(root, ['ls-files', '-s', '-z', '--', ...BUILD_INPUTS]))) {
    const [, id, stage, path] = /^\d+ ([0-9a-f]+) (\d)\t([^]*)$/.exec(entry) ?? []
    if (id === undefined || stage !== '0' || path === undefined) return null
    blobs.set(path, id)
  }
  const deleted = new Set(paths(git(root, ['ls-files', '-d', '-z', '--', ...BUILD_INPUTS])))
  for (const path of deleted) blobs.delete(path)
  const toHash = [
    ...paths(git(root, ['ls-files', '-m', '-z', '--', ...BUILD_INPUTS])).filter((path) => !deleted.has(path)),
    ...paths(git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...BUILD_INPUTS]))
  ]
  if (toHash.some((path) => path.includes('\n'))) return null
  if (toHash.length > 0) {
    const ids = git(root, ['hash-object', '--stdin-paths'], toHash.join('\n') + '\n').toString('utf8').split('\n')
    if (!toHash.every((_path, index) => /^[0-9a-f]{40,64}$/.test(ids[index] ?? ''))) return null
    toHash.forEach((path, index) => blobs.set(path, ids[index] ?? ''))
  }
  return blobs
}

function installedVersion (root, name) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function fileDigest (path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function envEntries (env) {
  const names = Object.keys(env).filter((name) => ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
  return [...new Set([...ENV_NAMES, ...names])].sort().map((name) => [name, env[name] ?? null])
}

/**
 * The key of the build `kind` would make from the checkout at `root`, or null when no key can be trusted
 * (not a git checkout, a conflict open, no record of the installed packages, an unreadable input): the build then always runs.
 *
 * The inputs are the files under BUILD_INPUTS as the working tree holds them, named by git's blob ids, so
 * the key follows content and nothing else: staging, committing, stashing or copying the checkout does not
 * move it. Files git ignores are not inputs. The commit id and the `-dirty` mark that electron.vite.config.ts
 * folds into the bundle are not part of the key either: they change on every commit whatever the inputs, and
 * a build reused across commits reports the commit it was made at.
 *
 * @param {string} root Repository root.
 * @param {'e2e' | 'ordinary'} kind
 * @param {NodeJS.ProcessEnv} env The environment the build will run with.
 * @param {{ node?: string, platform?: string, arch?: string }} [runtime]
 * @returns {string | null}
 */
export function buildKey (root, kind, env, runtime = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown build kind: ${String(kind)}`)
  const hash = createHash('sha256')
  const add = (label, value) => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value
    hash.update(`${label}\0${String(bytes.length)}\0`)
    hash.update(bytes)
    hash.update('\0')
  }
  try {
    // An empty prefix says `root` is the top of its work tree: below another project's top, that project's ignore rules decide what is an input.
    if (git(root, ['rev-parse', '--show-prefix']).toString('utf8').trim() !== '') return null
    const blobs = workingTreeBlobs(root)
    if (blobs === null || blobs.size === 0) return null

    add('format', KEY_FORMAT)
    add('kind', kind)
    add('inputs', JSON.stringify(BUILD_INPUTS))
    add('files', [...blobs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, id]) => `${path}\0${id}`).join('\n'))
    add('dev-grant', String(env.ORIVON_ENABLE_DEV_GRANT === '1'))
    add('env', JSON.stringify(envEntries(env)))
    add('node', runtime.node ?? process.version)
    add('platform', `${runtime.platform ?? process.platform} ${runtime.arch ?? process.arch}`)
    for (const name of TOOL_PACKAGES) add(`package ${name}`, installedVersion(root, name))
    // npm's record of what is installed: without it a changed dependency tree would go unseen.
    add('installed', fileDigest(join(root, 'node_modules', '.package-lock.json')))
  } catch {
    return null
  }
  return hash.digest('hex')
}
