/**
 * Fails the build if src/contracts/ is incomplete or references any module.
 *
 * src/contracts/ is the frozen interface every parallel stream codes against
 * (docs/planning/repo-and-parallel-work-design.md, Part B). Two properties
 * make it safe for several streams to depend on it at once:
 *
 *   1. IT REFERENCES ONLY ITS OWN SIBLINGS. No electron, no node:*, no
 *      third-party type, not even via `import type`. An external import is a
 *      dependency edge, and a dependency edge is a merge conflict waiting for
 *      two streams to reach it from different directions -- and worse, it
 *      would tie the durable interface to the disposable engine underneath it
 *      (ADR-0002). `./errors.js` from `./handles.js` is fine and necessary;
 *      `electron` is not. ReadableStream, WritableStream and Uint8Array are
 *      ambient globals here, available via tsconfig.json's
 *      lib: ["ES2023", "DOM", "DOM.Iterable"] -- they need no import at all.
 *   2. Every required file exists, so a stream importing from ./index.js never
 *      finds a half-transcribed surface.
 *
 * Colocated *.test.ts files are exempt: they are not part of the shipped
 * surface and no stream imports them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

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
 * Forms that name a module WITHOUT a `from` clause, so the specifier check
 * below cannot see them. Each of these is a violation on its own, in any file.
 *
 *   `import 'x'`   side-effect import
 *   `import("x")`  dynamic import
 *   `require("x")` CommonJS
 *
 * A bare `import(` also catches the dynamic form used as an expression, which
 * is how an external dependency would most plausibly sneak in.
 */
const UNSPECIFIED_REFERENCE_PATTERNS = [
  /\bimport\s*[('"`]/,
  /\brequire\s*\(/
]

/** Every module specifier named in a `from` clause, import or export alike. */
const SPECIFIER_PATTERN = /\bfrom\s*['"`]([^'"`]+)['"`]/g

/**
 * What a contracts file may name: a sibling in this same directory.
 *
 * `./errors.js`, `./capability-api.js` -- yes. `electron`, `node:fs`,
 * `../main/registry.js`, `./sub/thing.js` -- no. The `.js` extension is what
 * moduleResolution: "bundler" and verbatimModuleSyntax expect for a relative
 * TypeScript import.
 */
const SIBLING_SPECIFIER = /^\.\/[a-z0-9-]+\.js$/

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
    .filter((name) => referencesANonSibling(stripComments(readSafe(join(dir, name)))))
    .map((name) => relativeToRoot(root, join(dir, name)))
    .sort()

  return { ok: offenders.length === 0 && missing.length === 0, offenders, missing }
}

/**
 * True if the source names anything other than a sibling of this directory.
 *
 * Applies uniformly to every file. An earlier version banned imports outright
 * and carved out index.ts as a special case; that was the wrong rule, and it
 * fell over the moment capability-api.ts legitimately needed TcpSocket from
 * handles.ts. The property worth enforcing was never "no imports" -- it is
 * "no edge leaving this directory".
 */
function referencesANonSibling (source) {
  if (UNSPECIFIED_REFERENCE_PATTERNS.some((pattern) => pattern.test(source))) return true
  const specifiers = [...source.matchAll(SPECIFIER_PATTERN)].map((match) => match[1])
  return specifiers.some((specifier) => !SIBLING_SPECIFIER.test(specifier))
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

if (isInvokedDirectly(import.meta.url)) {
  const { ok, offenders, missing } = checkContractsArePure(process.cwd())

  if (!ok) {
    if (missing.length > 0) {
      console.error('\nsrc/contracts/ is incomplete. Missing:\n')
      for (const file of missing) console.error(`  ${file}`)
    }
    if (offenders.length > 0) {
      console.error('\nsrc/contracts/ may reference only its own siblings. These do more:\n')
      for (const file of offenders) console.error(`  ${file}`)
      console.error(
        '\nAllowed: ./errors.js, ./handles.js and the other files in this directory.' +
        '\nNot allowed: electron, node:*, any package, any path outside this directory.' +
        '\nReadableStream, WritableStream and Uint8Array are ambient globals and need' +
        '\nno import at all. If a contract genuinely needs a type from elsewhere, that' +
        '\nis a design change -- raise it, do not add the import.'
      )
    }
    console.error('\nSee docs/planning/repo-and-parallel-work-design.md, Part B.\n')
    process.exit(1)
  }

  console.log(
    `src/contracts/ is complete (${REQUIRED_CONTRACT_FILES.length} files) ` +
    'and references nothing outside itself.'
  )
}
