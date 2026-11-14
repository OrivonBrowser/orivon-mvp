// The key of a build: a digest of everything `electron-vite build` reads (electron.vite.config.ts and its
// imports), so scripts/build-reuse.mjs can skip a build whose inputs have not changed. Git only, argument
// arrays and no shell, so it runs the same on Windows and macOS.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

export const KINDS = ['e2e', 'ordinary']

/** The build configuration, whose relative imports are inputs of the build too. */
export const CONFIG = 'electron.vite.config.ts'

/**
 * Paths, relative to the repository root, that the build reads and that cannot be found from the code, less the
 * unit tests that sit among them (isUnitTest), and besides the files `electron.vite.config.ts` imports, which
 * configImports finds. scripts/tests/build-key-inputs.test.ts fails when a file the build reaches lies outside
 * these paths and those files, or is a unit test, which is how a new input gets added here.
 */
export const BUILD_INPUTS = [
  'src',
  'vendor',
  'resources',
  'docs/privacy/notice.md',
  CONFIG,
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'CHANGELOG.md'
]

const UNIT_TEST = /(?:^|\/)(?:tests|__tests__)\/|\.test\.(?:ts|tsx|mts|mjs|js)$/

/**
 * True for a unit test: a file under a `tests/` or `__tests__/` folder, or named `*.test.<ext>`. electron-vite
 * bundles what its entries import and no entry reaches a test, so an edit to one leaves the build as it was.
 * @param {string} path Root-relative, forward-slashed.
 */
export const isUnitTest = (path) => UNIT_TEST.test(path)

/** A relative path in code: `from '../x'`, `import('./y')`, `import './z'`, `require('./w')`, `new URL('./v', import.meta.url)`. */
export const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*|new\s+URL\(\s*)['"](\.{1,2}\/[^'")\s]+)/g

const CODE_FILE = /\.(?:ts|tsx|mts|mjs|js)$/

/** A comment, or a string or template literal, which a comment marker inside it does not start. */
const COMMENT_OR_STRING = /\/\*[^]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[^]|[^`\\])*`/g

/** `code` with its comments blanked: prose such as "would require('./chunks/...')" is no import. */
const withoutComments = (code) => code.replace(COMMENT_OR_STRING, (part) => (part.startsWith('/') ? ' ' : part))

/** The files a relative specifier can name: an import says `./x.js` for the `./x.ts` or `./x.mjs` beside it. */
const candidates = (path) => path.endsWith('.js')
  ? [path, path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.mjs'), path.replace(/\.js$/, '.tsx')]
  : [path, `${path}.ts`, `${path}.mjs`, `${path}.js`, `${path}/index.ts`]

/** The file, as a root-relative path, that `specifier` names from `from`, or null when none exists inside `root`. */
function resolveImport (root, from, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier.split('?')[0] ?? ''))
  if (base.startsWith('../')) return null
  return candidates(base).find((path) => {
    try {
      return statSync(join(root, path)).isFile()
    } catch {
      return false
    }
  }) ?? null
}

/** True for a path that BUILD_INPUTS already names, as a file or as a folder. */
const named = (path) => BUILD_INPUTS.some((input) => path === input || path.startsWith(`${input}/`))

/**
 * The files `electron.vite.config.ts` imports, with the files those import in turn, as sorted root-relative paths:
 * what the configuration loads while it runs, such as the bundle plugins, found from the code so that an import
 * the configuration gains is covered without an edit to BUILD_INPUTS. A file that BUILD_INPUTS names as
 * a folder's content is listed, but its own imports are not followed: scripts/tests/build-key-inputs.test.ts
 * holds those to BUILD_INPUTS.
 * Null when the configuration or a file it imports cannot be read, or an import names no file.
 * @param {string} root Repository root.
 * @returns {string[] | null}
 */
export function configImports (root) {
  const found = new Set()
  const queue = [CONFIG]
  try {
    for (let from = queue.shift(); from !== undefined; from = queue.shift()) {
      const text = withoutComments(readFileSync(join(root, from), 'utf8'))
      for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
        const path = resolveImport(root, from, match[1] ?? '')
        if (path === null) return null
        if (found.has(path) || path === CONFIG) continue
        found.add(path)
        if (CODE_FILE.test(path) && !named(path)) queue.push(path)
      }
    }
  } catch {
    return null
  }
  return [...found].sort()
}

/** Packages whose installed version steers the output: electron-vite targets the installed Electron's Node and Chromium. */
const TOOL_PACKAGES = ['electron', 'electron-vite', 'vite']

/** Variables electron-vite and Vite read, besides the dev-grant flag, which `define` folds to a boolean. */
const ENV_NAMES = ['NODE_ENV', 'NODE_ENV_ELECTRON_VITE']
const ENV_PREFIXES = ['VITE_', 'MAIN_VITE_', 'PRELOAD_VITE_', 'RENDERER_VITE_']

const KEY_FORMAT = '2'

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
 * The blob id of every file the working tree holds under BUILD_INPUTS and `extra` (the files the configuration
 * imports), by path: the index's id for a file unchanged since it was staged, git's own hash of the file for one
 * edited since or untracked and not ignored. Unit tests under BUILD_INPUTS are left out, a file of `extra` never.
 * Null when a conflict is open, a file is hidden from git's change check, a name could not be passed to git as a
 * line, or a file of `extra` is not among them (git ignores it, or does not list it).
 */
function workingTreeBlobs (root, extra) {
  const inputs = [...new Set([...BUILD_INPUTS, ...extra])]
  const kept = (path) => extra.includes(path) || !isUnitTest(path)
  const blobs = new Map()
  // A file marked assume-unchanged or skip-worktree hides its edits from `-m`, so its index id could be stale.
  // `-v` puts a status letter and a space before each path.
  if (paths(git(root, ['ls-files', '-v', '-z', '--', ...inputs])).some((entry) => !entry.startsWith('H ') && kept(entry.slice(2)))) return null
  for (const entry of paths(git(root, ['ls-files', '-s', '-z', '--', ...inputs]))) {
    const [, id, stage, path] = /^\d+ ([0-9a-f]+) (\d)\t([^]*)$/.exec(entry) ?? []
    if (id === undefined || stage !== '0' || path === undefined) return null
    if (kept(path)) blobs.set(path, id)
  }
  const deleted = new Set(paths(git(root, ['ls-files', '-d', '-z', '--', ...inputs])).filter(kept))
  for (const path of deleted) blobs.delete(path)
  const toHash = [
    ...paths(git(root, ['ls-files', '-m', '-z', '--', ...inputs])).filter((path) => !deleted.has(path)),
    ...paths(git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...inputs]))
  ].filter(kept)
  if (toHash.some((path) => path.includes('\n'))) return null
  if (toHash.length > 0) {
    const ids = git(root, ['hash-object', '--stdin-paths'], toHash.join('\n') + '\n').toString('utf8').split('\n')
    if (!toHash.every((_path, index) => /^[0-9a-f]{40,64}$/.test(ids[index] ?? ''))) return null
    toHash.forEach((path, index) => blobs.set(path, ids[index] ?? ''))
  }
  return extra.every((path) => blobs.has(path)) ? blobs : null
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
    const imports = configImports(root)
    if (imports === null) return null
    const blobs = workingTreeBlobs(root, imports)
    if (blobs === null || blobs.size === 0) return null

    add('format', KEY_FORMAT)
    add('kind', kind)
    add('inputs', JSON.stringify([...BUILD_INPUTS, ...imports]))
    add('unit tests left out', UNIT_TEST.source)
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
