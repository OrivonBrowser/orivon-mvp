/**
 * Fails the build if a source file exceeds 500 lines, or a test file 800.
 *
 * docs/development/code-guidelines.md Rule 2. A file at that length has almost
 * always stopped being one thing, and a smaller model can hold a 300-line file
 * and reason about it confidently in a way it cannot for 900. Rule 2 was
 * enforced by hand in the 2026-08-27 refactor; this is the mechanical guard
 * for it, following the same idiom as check-no-native-modules.mjs and
 * check-contracts-pure.mjs. It is deliberately NOT wired into `npm run
 * postinstall` or CI here -- code-guidelines.md's own §Open points #2 records
 * that as the owner's call, still open.
 *
 * "Test file" is exactly what code-guidelines.md §Rule 2 and test files
 * defines, no more: a `*.test.ts` file, anything under `test/`, and
 * `scripts/smoke.mjs` specifically. Everything else -- including the rest of
 * `scripts/` -- is source, at the 500-line limit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

/** Source files split above this many lines. */
export const SOURCE_LIMIT = 500

/** Test files split above this many lines. */
export const TEST_LIMIT = 800

/**
 * Extensions this guard treats as code. `.d.ts` is deliberately excluded --
 * it is generated or ambient, never hand-authored against Rule 2.
 */
const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const DECLARATION_FILE = /\.d\.ts$/

/**
 * Directories never walked, and why:
 *   - install/build output: nothing here is authored, all of it is generated.
 *   - `spike/`: week-0 spike scaffolding, explicitly absent from
 *     parallel-work.md's ownership map and predates code-guidelines.md by
 *     weeks -- the orivon-electron skill states outright it is throwaway and
 *     will be deleted once reviewed. Confirmed (2026-09-03) that excluding it
 *     changes nothing about whether the guard currently passes: nothing under
 *     spike/ is over either limit today, checked file by file.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist', 'release', 'coverage', 'spike'])

/**
 * @param {string} file Root-relative, forward-slashed path.
 * @returns {boolean} True if `file` is a test file under the guideline's own
 *   definition: `*.test.ts`, anything under `test/`, or `scripts/smoke.mjs`.
 */
function isTestFile (file) {
  return file.endsWith('.test.ts') || file === 'scripts/smoke.mjs' || file.startsWith('test/')
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
 * @param {string} root Directory to check, typically the repo root.
 * @returns {{ ok: boolean, offenders: Array<{file: string, lines: number, limit: number}> }}
 *   `file` is root-relative and forward-slashed. Sorted by path.
 */
export function checkFileSizes (root) {
  const offenders = []
  walk(root, root)
  offenders.sort((a, b) => a.file.localeCompare(b.file))
  return { ok: offenders.length === 0, offenders }

  function walk (dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: not this guard's failure to report
    }

    for (const entry of entries) {
      const full = join(dir, entry.name)

      // Never follow a symlink -- a package or fixture may point outside the
      // tree, or at itself, and following either produces a false result or
      // an unbounded walk (same guard as check-no-native-modules.mjs).
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(full)
        continue
      }

      if (!entry.isFile()) continue
      if (DECLARATION_FILE.test(entry.name) || !SOURCE_EXTENSION.test(entry.name)) continue

      const file = relativeToRoot(root, full)
      const lines = countLines(readSafe(full))
      const limit = isTestFile(file) ? TEST_LIMIT : SOURCE_LIMIT
      if (lines > limit) offenders.push({ file, lines, limit })
    }
  }
}

function readSafe (path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, offenders } = checkFileSizes(process.cwd())

  if (!ok) {
    console.error('\nFiles over the Rule 2 line limit (docs/development/code-guidelines.md):\n')
    for (const { file, lines, limit } of offenders) {
      console.error(`  ${file}  (${lines} lines, limit ${limit})`)
    }
    console.error(
      '\nSource files split above 500 lines, test files (*.test.ts, test/, scripts/smoke.mjs)' +
      '\nabove 800. Split by concern, never by line count -- see Rule 2 for the reasoning and' +
      "\nCLAUDE.md's code-guidelines.md for the worked examples.\n"
    )
    process.exit(1)
  }

  console.log('Every source and test file is within its Rule 2 line limit (500 / 800).')
}
