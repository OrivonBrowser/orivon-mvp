/**
 * Fails the build if src/contracts/ is incomplete or references any module.
 *
 * src/contracts/ is the frozen interface every parallel stream codes against
 * (docs/planning/repo-and-parallel-work-design.md, Part B). Two properties
 * make it safe for several streams to depend on it at once:
 *
 *   1. It imports NOTHING -- not electron, not node:*, not a third-party type,
 *      not even `import type`. An import is a dependency edge, and a
 *      dependency edge is a merge conflict waiting for two streams to reach it
 *      from different directions. ReadableStream, WritableStream and
 *      Uint8Array are ambient globals here, available via tsconfig.json's
 *      lib: ["ES2023", "DOM", "DOM.Iterable"] -- they need no import.
 *   2. Every required file exists, so a stream importing from ./index.js never
 *      finds a half-transcribed surface.
 *
 * Colocated *.test.ts files are exempt: they are not part of the shipped
 * surface and no stream imports them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Files that must exist. Order is the reading order, not alphabetical. */
export const REQUIRED_CONTRACT_FILES = [
  'errors.ts',
  'handles.ts',
  'manifest.ts',
  'capability-api.ts',
  'limits.ts',
  'ipc.ts',
  'index.ts'
]

const CONTRACTS_DIR = join('src', 'contracts')

/**
 * Deliberately several narrow patterns rather than one broad alternation. A
 * single regex with an unbounded `[\s\S]*?` between `export` and `from` spans
 * unrelated statements, so a file with an `export` near the top and the word
 * `from` in a string near the bottom reads as a re-export. These each match
 * one syntactic form and stop.
 */
const IMPORT_PATTERNS = [
  /** `import 'x'`, `import("x")` -- side-effect and dynamic. */
  /\bimport\s*[('"`]/,
  /** `import x from 'y'`, `import type { a } from 'y'`, `import * as x from 'y'`. */
  /\bimport\b[\s\S]{0,200}?\bfrom\s*['"`]/,
  /** `require('x')`. */
  /\brequire\s*\(/
]

/** `export { a } from 'y'`, `export type { a } from 'y'`, `export * from 'y'`. */
const REEXPORT_PATTERN =
  /\bexport\b\s*(?:type\s*)?(?:\{[\s\S]{0,400}?\}|\*(?:\s+as\s+\w+)?)\s*from\s*['"`]/

/**
 * @param {string} root Directory containing the src/contracts tree to check.
 * @returns {{ ok: boolean, offenders: string[], missing: string[] }}
 *   `offenders` reference a module; `missing` are absent required files. Both
 *   are root-relative, sorted, and forward-slashed so output is stable across
 *   platforms.
 */
export function checkContractsArePure (root) {
  const dir = join(root, CONTRACTS_DIR)

  let present = []
  try {
    if (statSync(dir).isDirectory()) {
      present = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    }
  } catch {
    // Absent or unreadable directory: every required file is missing, which
    // the `missing` list below reports on its own.
  }

  const missing = REQUIRED_CONTRACT_FILES
    .filter((name) => !present.includes(name))
    .map((name) => `src/contracts/${name}`)
    .sort()

  const offenders = present
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => referencesAModule(stripComments(readSafe(join(dir, name)))))
    .map((name) => relative(root, join(dir, name)).split(sep).join('/'))
    .sort()

  return { ok: offenders.length === 0 && missing.length === 0, offenders, missing }
}

/** True if the source imports, requires, or re-exports from anywhere. */
function referencesAModule (source) {
  return IMPORT_PATTERNS.some((pattern) => pattern.test(source)) ||
    REEXPORT_PATTERN.test(source)
}

function readSafe (path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Removes line and block comments so prose about importing does not trip the
 * check. Deliberately naive -- it does not track string or regex literals,
 * because a contracts file is type declarations and frozen literals only, and
 * contains no code where a `//` could appear inside a string.
 */
function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href

if (invokedDirectly) {
  const { ok, offenders, missing } = checkContractsArePure(process.cwd())

  if (!ok) {
    if (missing.length > 0) {
      console.error('\nsrc/contracts/ is incomplete. Missing:\n')
      for (const file of missing) console.error(`  ${file}`)
    }
    if (offenders.length > 0) {
      console.error('\nsrc/contracts/ must reference no module. These do:\n')
      for (const file of offenders) console.error(`  ${file}`)
      console.error(
        '\nReadableStream, WritableStream and Uint8Array are ambient globals here;' +
        '\nthey need no import. If a contract genuinely needs a type from elsewhere,' +
        '\nthat is a design change -- raise it, do not add the import.'
      )
    }
    console.error('\nSee docs/planning/repo-and-parallel-work-design.md, Part B.\n')
    process.exit(1)
  }

  console.log(
    `src/contracts/ is complete (${REQUIRED_CONTRACT_FILES.length} files) and imports nothing.`
  )
}
