/**
 * Fails the build if a source file exceeds 500 lines, or a test file 800, or a
 * change makes a `src/**` `README.md` larger than 12 KB or grows one already over it.
 *
 * docs/development/code-guidelines.md Rule 2. A file at that length has almost
 * always stopped being one thing, and a smaller model can hold a 300-line file
 * and reason about it confidently in a way it cannot for 900. Rule 2 was
 * enforced by hand in the 2026-08-27 refactor; this is the mechanical guard
 * for it, following the same idiom as check-no-native-modules.mjs and
 * check-contracts-pure.mjs. Wired into `npm run check:size` and CI's `check`
 * job as of 2026-09-04 -- code-guidelines.md's own section Status records the
 * reversal of the earlier "rules first, enforcement later" deferral.
 *
 * "Test file" is exactly what code-guidelines.md Rule 2 defines, no more:
 * a `*.test.ts` file, anything under `test/` except `test/apps/`, and
 * `scripts/smoke.mjs` specifically. Everything else -- including the rest of
 * `scripts/` and the apps under `test/apps/` -- is source, at 500 lines.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

/** Source files split above this many lines. */
export const SOURCE_LIMIT = 500

/** Test files split above this many lines. */
export const TEST_LIMIT = 800

/**
 * A `src/**` README may not be larger than this many bytes (12 KB), and one
 * already larger may not grow. The README is the map an agent reads before
 * editing a directory; rationale lives in a `DESIGN.md` beside it.
 */
export const README_LIMIT = 12 * 1024

/**
 * Extensions this guard treats as code. `.d.ts` is deliberately excluded --
 * it is generated or ambient, never hand-authored against Rule 2.
 */
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const DECLARATION_FILE = /\.d\.ts$/

/**
 * Directories never walked, and why:
 *   - install/build output: nothing here is authored, all of it is generated.
 *     Matches .gitignore's own "Build output" grouping (dist/, out/, build/)
 *     plus release/ (electron-builder.yml's configured output directory) and
 *     coverage/ (generated test-coverage reports). `build/` is listed
 *     pre-emptively, before it exists: per electron-builder.yml's own comment
 *     it will hold icon source images, not code, the day someone adds one.
 *   - `spike/`: week-0 spike scaffolding, explicitly absent from
 *     parallel-work.md's ownership map and predates code-guidelines.md by
 *     weeks -- the orivon-electron skill states outright it is throwaway and
 *     will be deleted once reviewed. Confirmed (2026-09-03) that excluding it
 *     changes nothing about whether the guard currently passes: nothing under
 *     spike/ is over either limit today, checked file by file.
 *   - `vendor/`: third-party source kept in its upstream shape, patched as
 *     its UPSTREAM.md lists. Rule 2 is Orivon's own authoring style; it was
 *     never upstream's, and reformatting a vendored file to fit it would
 *     make future patches harder to diff against the original.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'build', 'release', 'coverage', 'spike', 'vendor'])

/**
 * Top-level directories never walked: `resources/` holds data the app reads,
 * never code (its README), and the files `fetch-bundled-extensions.mjs` and
 * `fetch-local-nodes.mjs` download into it, which git ignores. Matched at the
 * root only, so a `resources` folder inside `src/` is still checked.
 */
const SKIPPED_ROOT_DIRECTORIES = new Set(['resources'])

/**
 * @param {string} file Root-relative, forward-slashed path.
 * @returns {boolean} True if `file` is a test file under the guideline's own
 *   definition: `*.test.ts`, anything under `test/` except `test/apps/`, or
 *   `scripts/smoke.mjs`.
 */
function isTestFile (file) {
  return file.endsWith('.test.ts') || file === 'scripts/smoke.mjs' ||
    (file.startsWith('test/') && !file.startsWith('test/apps/'))
}

/**
 * Number of lines in `text`, matching what an editor would show: a trailing
 * newline is end-of-file, not one more line. Equivalent to `wc -l` for a
 * normally-terminated file, and (unlike `wc -l`) still counts a final line
 * that lacks a trailing newline.
 */
function countLines (text) {
  if (text.length === 0) return 0
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Calls `onFile(fullPath, name)` for every regular file under `startDir`,
 * never entering a skipped directory or following a symlink.
 * @param {string} root The repo root, which `SKIPPED_ROOT_DIRECTORIES` is matched against.
 * @param {string} startDir
 * @param {(full: string, name: string) => void} onFile
 */
function walkFiles (root, startDir, onFile) {
  walk(startDir)

  function walk (dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // A directory this guard cannot even list -- gone, or permission
      // denied -- gives zero information about what might be inside it, so
      // there is nothing to report a violation about either way. That is
      // coarser than readSafe below, which DOES split "gone" from "blocked"
      // for a single file: a file failure happens after this same
      // readdirSync already told us the file exists, so a genuine
      // permissions problem there is a known, specific thing worth failing
      // loudly about. Do not "fix" this catch to match readSafe's
      // fails-loud-on-real-problems behaviour, or "fix" readSafe to match
      // this catch's blanket silence -- they differ on purpose, not by
      // oversight, and both already agree on the part that matters: neither
      // ever reports a violation about something it never actually read.
      return
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)

      // Never follow a symlink -- a package or fixture may point outside the
      // tree, or at itself, and following either produces a false result or
      // an unbounded walk (same guard as check-no-native-modules.mjs).
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
        if (dir === root && SKIPPED_ROOT_DIRECTORIES.has(entry.name)) continue
        walk(full)
        continue
      }

      if (entry.isFile()) onFile(full, entry.name)
    }
  }
}

/**
 * @param {string} root Directory to check, typically the repo root.
 * @returns {{ ok: boolean, offenders: Array<{file: string, lines: number, limit: number}>,
 *   unreadable: Array<{file: string, error: string}> }}
 *   `file` is root-relative and forward-slashed. Both arrays sorted by path.
 *   `unreadable` lists files that exist but this guard genuinely could not
 *   open (permissions, ownership) -- their size is unknown, not zero, so
 *   they fail the check rather than passing it silently. A file that raced
 *   out of existence between being listed and being read is NOT one of
 *   these -- see readSafe below.
 */
export function checkFileSizes (root) {
  const offenders = []
  const unreadable = []
  walkFiles(root, root, (full, name) => {
    if (DECLARATION_FILE.test(name) || !SOURCE_EXTENSION.test(name)) return

    const file = relativeToRoot(root, full)
    const read = readSafe(full)
    if ('gone' in read) return // vanished since readdirSync above: nothing to check, not a violation
    if ('error' in read) {
      unreadable.push({ file, error: read.error })
      return
    }

    const lines = countLines(read.text)
    const limit = isTestFile(file) ? TEST_LIMIT : SOURCE_LIMIT
    if (lines > limit) offenders.push({ file, lines, limit })
  })
  offenders.sort((a, b) => a.file.localeCompare(b.file))
  unreadable.sort((a, b) => a.file.localeCompare(b.file))
  return { ok: offenders.length === 0 && unreadable.length === 0, offenders, unreadable }
}

/**
 * Reads `path` as UTF-8, or reports why it could not -- and NOT every "could
 * not" means the same thing:
 *
 *   - ENOENT: `path` was listed by the `readdirSync` in `walk` above but is
 *     gone by the time this runs -- deleted, renamed, briefly touched by
 *     something else. That is a benign race, not a violation: there is
 *     nothing left to check, so it must not fail the run. (Exported as
 *     `{ gone: true }` rather than swallowed here so checkFileSizes's caller
 *     can skip it explicitly instead of this function deciding silently.)
 *   - anything else (EACCES, EPERM, ...): `path` exists and this guard is
 *     genuinely blocked from reading it. Its line count is unknown, not
 *     zero, so treating this the same as an empty compliant file would make
 *     the one guard whose entire purpose is "a wrong guard is worse than
 *     none" the thing that is wrong -- reported via checkFileSizes's
 *     `unreadable` list instead.
 *
 * (2026-09-03: this function used to fail loudly on ENOENT too, which meant
 * a file that simply raced out of existence -- nowhere near any size limit
 * -- could flip the whole check to failing. That conflated the two cases
 * above; fixed by splitting them.)
 * @returns {{ text: string } | { error: string } | { gone: true }}
 */
export function readSafe (path) {
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (err) {
    if (err.code === 'ENOENT') return { gone: true }
    return { error: err.code ?? String(err) }
  }
}

/**
 * Size in bytes as git stores the file: a working tree that checked a README
 * out with CRLF line endings is not larger than its LF blob.
 */
function storedBytes (text) {
  return Buffer.byteLength(text.replaceAll('\r\n', '\n'))
}

/**
 * @param {string} root
 * @returns {{ readmes: Array<{file: string, bytes: number}>, unreadable: Array<{file: string, error: string}> }}
 *   Every `README.md` at or below `src/`, root-relative and forward-slashed.
 */
export function readmeSizes (root) {
  const readmes = []
  const unreadable = []
  walkFiles(root, join(root, 'src'), (full, name) => {
    if (name !== 'README.md') return
    const file = relativeToRoot(root, full)
    const read = readSafe(full)
    if ('gone' in read) return
    if ('error' in read) unreadable.push({ file, error: read.error })
    else readmes.push({ file, bytes: storedBytes(read.text) })
  })
  readmes.sort((a, b) => a.file.localeCompare(b.file))
  unreadable.sort((a, b) => a.file.localeCompare(b.file))
  return { readmes, unreadable }
}

/**
 * Sizes of `files` at `commit`, in order; `null` where one is not there.
 * @param {string} root
 * @param {string} commit
 * @param {string[]} files
 * @returns {Array<number | null>}
 */
function sizesAt (root, commit, files) {
  if (files.length === 0) return []
  const out = execFileSync('git', ['cat-file', '--batch-check'], {
    cwd: root,
    encoding: 'utf8',
    input: files.map((file) => `${commit}:${file}\n`).join(''),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return out.split('\n').slice(0, files.length).map((line) => {
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(line)
    return match === null ? null : Number(match[1])
  })
}

/**
 * Judges READMEs against the change's own base: the merge base of HEAD and
 * `base`, so a README already large on a long-lived branch fails only when
 * this change grows it. A README over the limit fails when it is new, or
 * larger than at the base; one at or under the limit never fails. The working
 * tree is what is measured, so an edit not yet committed counts.
 * @param {string} root
 * @param {string | undefined} base A git ref. Without one nothing can be judged
 *   as growth, so the result carries a `warning` and does not fail.
 * @returns {{ ok: boolean, grown: Array<{file: string, before: number | null, after: number}>,
 *   unreadable: Array<{file: string, error: string}>, warning?: string, error?: string }}
 *   `before` is `null` for a README the base does not have. `error` is a
 *   `base` that was given but names no merge base with HEAD: a comparison the
 *   caller asked for and could not be made fails rather than passing.
 */
export function checkReadmeSizes (root, base) {
  const { readmes, unreadable } = readmeSizes(root)
  const unreadableFails = unreadable.length > 0
  if (base === undefined) {
    return {
      ok: !unreadableFails,
      grown: [],
      unreadable,
      warning: 'no base to compare against (pass --base <ref> or set CHECK_SIZE_BASE), so README growth under src/ was not checked'
    }
  }

  let commit
  try {
    commit = execFileSync('git', ['merge-base', 'HEAD', base], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return {
      ok: false,
      grown: [],
      unreadable,
      error: `no merge base between HEAD and ${base}; fetch the base branch with full history`
    }
  }

  const over = readmes.filter(({ bytes }) => bytes > README_LIMIT)
  const before = sizesAt(root, commit, over.map(({ file }) => file))
  const grown = []
  over.forEach(({ file, bytes }, i) => {
    const was = before[i] ?? null
    if (was === null || bytes > was) grown.push({ file, before: was, after: bytes })
  })
  return { ok: grown.length === 0 && !unreadableFails, grown, unreadable }
}

/** The report for READMEs that grew past the cap, one line per file, then what to do. */
export function describeReadmeGrowth (grown) {
  const lines = grown.map(({ file, before, after }) => {
    const was = before === null ? 'new file' : `was ${String(before)} bytes`
    return `  ${file}  (${was}, now ${String(after)} bytes, cap ${String(README_LIMIT)})`
  })
  return [
    '\nREADMEs over the 12 KB cap (docs/development/code-guidelines.md Rule 1):\n',
    ...lines,
    '\nPut rationale in DESIGN.md beside the README. The README is the map: what is here, what it may' +
    '\ndepend on, what it must never import. One already over the cap may shrink, never grow.\n'
  ].join('\n')
}

/**
 * The base ref to judge README growth against: `--base <ref>`, else the
 * `CHECK_SIZE_BASE` environment variable, else none.
 * @param {string[]} argv Arguments after the script name.
 * @param {Record<string, string | undefined>} env
 * @returns {{ base?: string, error?: string }}
 */
export function readBaseArg (argv, env) {
  const at = argv.indexOf('--base')
  if (at !== -1) {
    const ref = argv[at + 1]
    if (ref === undefined || ref.startsWith('--')) return { error: '--base needs a ref, for example --base origin/main' }
    return { base: ref }
  }
  const fromEnv = env.CHECK_SIZE_BASE?.trim()
  return fromEnv === undefined || fromEnv === '' ? {} : { base: fromEnv }
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const { base, error: baseError } = readBaseArg(process.argv.slice(2), process.env)
  if (baseError !== undefined) {
    console.error(baseError)
    process.exit(1)
  }

  const { ok, offenders, unreadable } = checkFileSizes(root)
  const readme = checkReadmeSizes(root, base)
  const problems = []

  if (!ok) {
    problems.push('line limit')
    if (offenders.length > 0) {
      console.error('\nFiles over the Rule 2 line limit (docs/development/code-guidelines.md):\n')
      for (const { file, lines, limit } of offenders) {
        console.error(`  ${file}  (${lines} lines, limit ${limit})`)
      }
      console.error(
        '\nSource files split above 500 lines, test files (*.test.ts, test/, scripts/smoke.mjs)' +
        '\nabove 800. Split by concern, never by line count -- see Rule 2 for the reasoning and' +
        "\nCLAUDE.md's code-guidelines.md for the worked examples.\n"
      )
    }

    if (unreadable.length > 0) {
      console.error('\nFiles this guard could not read -- their line count is unknown, not 0,' +
        ' so this is reported as a failure rather than a silent pass:\n')
      for (const { file, error } of unreadable) {
        console.error(`  ${file}  (${error})`)
      }
      console.error('\nA file that merely raced out of existence would not be listed here -- see' +
        ' readSafe in this script. Fix the permissions and try again.\n')
    }
  }

  if (!readme.ok) {
    problems.push('README cap')
    if (readme.grown.length > 0) console.error(describeReadmeGrowth(readme.grown))
    if (readme.error !== undefined) console.error(`\n${readme.error}\nTreating this as a failed scan, not a clean one.\n`)
    if (readme.unreadable.length > 0) {
      console.error('\nREADMEs this guard could not read, so their size is unknown:\n')
      for (const { file, error } of readme.unreadable) console.error(`  ${file}  (${error})`)
      console.error('')
    }
  }

  if (problems.length > 0) process.exit(1)

  console.log('Every source and test file is within its Rule 2 line limit (500 / 800).')
  if (readme.warning !== undefined) console.warn(`check:size: ${readme.warning}. CI checks it on every pull request.`)
  else console.log(`No README under src/ grew past the ${String(README_LIMIT / 1024)} KB cap since ${String(base)}.`)
}
