/**
 * Fails the build if a source file opens with more than 25 lines of comment.
 *
 * docs/development/code-guidelines.md Rule 1. The rule's own test is whether a
 * comment restates the code, and that test cannot see the failure this guard
 * exists for: a file-header essay that argues for the design against the
 * alternatives it rejected. Every line of one passes Rule 1 read literally,
 * and half this codebase drifted that way before anyone noticed.
 *
 * WHY THE LEADING BLOCK AND NOT COMMENT DENSITY. Density was measured first and
 * does not separate the two cases: derive.ts is 67% comment and correct
 * (Rule 1 defends it by name), connection-log.ts is 75% and is an essay. What
 * does separate them is where the comment sits. A comment that earns its place
 * sits next to the line it protects; an essay accumulates at the top, detached
 * from any code, and is paid for by every reader before they reach line one.
 *
 * The limit is calibrated, not chosen: the files code-guidelines.md defends as
 * correctly dense open with 14-21 lines, and the essays open with 26-94.
 *
 * SCOPE: source only. Test files are deliberately not checked -- Rule 2 already
 * gives them a higher budget for the same reason (a header describing a test
 * strategy is worth its length), and the problem reported was in src/.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, trackedFiles } from './cli.mjs'

/** Lines of comment a file may open with before the block needs justifying. */
export const PREAMBLE_LIMIT = 25

/** Where the list of known, not-yet-fixed offenders lives. */
export const BASELINE_FILE = 'scripts/comment-budget-baseline.txt'

/**
 * Opting one file out, with the reason required rather than optional:
 * `// orivon:comment-budget -- <why this cannot be shortened>`. The reason is
 * the whole mechanism. A bare pragma would make the exemption free, and an
 * exemption that costs nothing stops meaning anything.
 */
const PRAGMA = /orivon:comment-budget/
const PRAGMA_WITH_REASON = /orivon:comment-budget\s*--\s*(\S.*?)\s*$/

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const DECLARATION_FILE = /\.d\.ts$/

/** A line opening (or continuing) an `import` statement -- see `findPreambleBlock`. */
const IMPORT_STATEMENT = /^import\b/

/**
 * Two directories this guard never reads.
 *
 * `src/contracts/` is Rule 1's own carve-out: doc comments on exported
 * declarations there ARE the product's API documentation, and thinning them
 * would trade the expensive thing for the cheap one.
 *
 * `spike/` is week-0 scaffolding, absent from parallel-work.md's ownership map
 * and documented as throwaway -- the same exclusion, for the same reason, that
 * scripts/check-size.mjs makes.
 */
const EXEMPT_DIRECTORY = /^(src\/contracts|spike)\//

/**
 * "Test file" exactly as code-guidelines.md Rule 2 defines it.
 * Duplicated from scripts/check-size.mjs; consolidating the two is tracked
 * as A54.
 */
function isTestFile (file) {
  return file.endsWith('.test.ts') || file === 'scripts/smoke.mjs' || file.startsWith('test/')
}

/** True for a line this guard treats as a comment line: `//`, `/*`, or a block-comment continuation (`*`). */
function isCommentLine (line) {
  return line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')
}

/**
 * Index just past the import statement starting at line `i` -- `i + 1` for an
 * ordinary single-line import, further along when its `{ ... }` (or,
 * defensively, `( ... )`) spans multiple lines. Tracks bracket depth rather
 * than looking for a terminating `from` or `;`, since neither is required
 * syntax: a bare `import './x.css'` has no `from`, and ASI makes the
 * semicolon optional.
 */
function skipImportStatement (lines, i) {
  const netDepth = (line) => {
    let d = 0
    for (const ch of line) {
      if (ch === '{' || ch === '(') d++
      else if (ch === '}' || ch === ')') d--
    }
    return d
  }

  let depth = netDepth(lines[i])
  let j = i + 1
  while (depth > 0 && j < lines.length) {
    depth += netDepth(lines[j])
    j++
  }
  return j
}

/**
 * Length of the comment run over `[from, until)`, a range built by
 * `findPreambleBlock` to hold only blank and comment lines. Measured, as
 * before, from `from` through the LAST comment line in the range, so an
 * interior blank line (a paragraph break) counts but trailing ones do not.
 */
function commentRunLength (lines, from, until) {
  let last = -1
  for (let i = from; i < until; i++) {
    if (isCommentLine(lines[i].trim())) last = i
  }
  return last < from ? 0 : last - from + 1
}

/**
 * The file's opening rationale block: the single largest contiguous run of
 * comment lines sitting before the first substantive (non-import,
 * non-comment, non-blank) line. An import line does not itself count toward
 * a run, but does not end the opening region either -- so a header placed
 * after the file's imports is measured exactly the same as one at line one,
 * closing the gap a header could open by moving below them (A64). A comment
 * block past that first real declaration is an ordinary per-declaration
 * comment, not this file's header, and this function never looks at it.
 *
 * @returns {{ length: number, start: number, end: number }} `start`/`end`
 *   bound the winning run (absolute line indices, `end` inclusive); both are
 *   0 and meaningless when `length` is 0.
 */
function findPreambleBlock (text) {
  const lines = text.split('\n')
  const start = lines[0]?.startsWith('#!') ? 1 : 0

  let best = { length: 0, start: 0, end: 0 }
  const consider = (from, until) => {
    const length = commentRunLength(lines, from, until)
    if (length > best.length) best = { length, start: from, end: from + length - 1 }
  }

  let segmentStart = start
  let i = start
  while (i < lines.length) {
    const trimmed = lines[i].trim()

    if (trimmed === '' || isCommentLine(trimmed)) {
      i++
      continue
    }

    if (IMPORT_STATEMENT.test(trimmed)) {
      consider(segmentStart, i)
      i = skipImportStatement(lines, i)
      segmentStart = i
      continue
    }

    consider(segmentStart, i)
    return best
  }

  consider(segmentStart, lines.length)
  return best
}

/**
 * How many lines of comment a file opens with -- see `findPreambleBlock` for
 * what "opens with" means once imports are in play.
 *
 * @returns {number} 0 when the file does not open with a comment at all.
 */
export function measurePreamble (text) {
  return findPreambleBlock(text).length
}

/** The pragma's reason, or null when there is no pragma or it carries none. */
function exemptionReason (text, block) {
  const lines = text.split('\n')
  for (let i = block.start; i <= block.end; i++) {
    if (!PRAGMA.test(lines[i])) continue
    return lines[i].match(PRAGMA_WITH_REASON)?.[1] ?? null
  }
  return undefined
}

/** Root-relative paths listed in the baseline, ignoring blanks and # comments. */
function readBaseline (root) {
  let text
  try {
    text = readFileSync(join(root, BASELINE_FILE), 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * @param {string} root Repository root to check.
 * @param {{ limit?: number }} [opts] `limit` overrides PREAMBLE_LIMIT, for this
 *   guard's own tests.
 * @returns {{ ok: boolean,
 *   offenders: Array<{file: string, preamble: number, limit: number}>,
 *   unjustified: Array<{file: string}>,
 *   exempted: Array<{file: string, reason: string}>,
 *   baselined: string[], stale: string[],
 *   unreadable: Array<{file: string, error: string}> }}
 *
 *   `stale` is what makes the baseline a ratchet rather than a hiding place: an
 *   entry whose file is now compliant, or gone, fails the check, so the list
 *   can only ever shrink.
 */
export function checkComments (root, opts = {}) {
  const limit = opts.limit ?? PREAMBLE_LIMIT
  const baseline = new Set(readBaseline(root))

  const offenders = []
  const unjustified = []
  const exempted = []
  const baselined = []
  const unreadable = []

  for (const file of trackedFiles(root)) {
    if (DECLARATION_FILE.test(file) || !SOURCE_EXTENSION.test(file)) continue
    if (isTestFile(file) || EXEMPT_DIRECTORY.test(file)) continue

    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      // Unknown, not zero. A guard that reads a failure as a pass is the one
      // kind of wrong that is worse than having no guard.
      unreadable.push({ file, error: err.code ?? String(err) })
      continue
    }

    const block = findPreambleBlock(text)
    if (block.length <= limit) continue

    const reason = exemptionReason(text, block)
    if (reason === null) {
      unjustified.push({ file })
      continue
    }
    if (reason !== undefined) {
      exempted.push({ file, reason })
      continue
    }
    if (baseline.has(file)) {
      baselined.push(file)
      continue
    }

    offenders.push({ file, preamble: block.length, limit })
  }

  const overLimit = new Set(baselined)
  const stale = [...baseline].filter((file) => !overLimit.has(file))

  const byPath = (a, b) => (a.file ?? a).localeCompare(b.file ?? b)
  offenders.sort(byPath)
  unjustified.sort(byPath)
  exempted.sort(byPath)
  unreadable.sort(byPath)
  baselined.sort()
  stale.sort()

  return {
    ok: offenders.length === 0 && unjustified.length === 0 &&
      stale.length === 0 && unreadable.length === 0,
    offenders,
    unjustified,
    exempted,
    baselined,
    stale,
    unreadable
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkComments(process.cwd())

  if (process.argv.includes('--exemptions')) {
    console.log(`\nFiles exempt from the ${PREAMBLE_LIMIT}-line comment budget:\n`)
    for (const { file, reason } of result.exempted) console.log(`  ${file}\n    ${reason}`)
    for (const file of result.baselined) console.log(`  ${file}\n    (baselined, not yet justified)`)
    console.log(`\n${result.exempted.length} justified, ${result.baselined.length} baselined.\n`)
    process.exit(0)
  }

  if (!result.ok) {
    if (result.offenders.length > 0) {
      console.error('\nFiles opening with more comment than the Rule 1 budget allows:\n')
      for (const { file, preamble, limit } of result.offenders) {
        console.error(`  ${file}  (${preamble} lines of comment before any code, limit ${limit})`)
      }
      console.error(
        '\nA comment that earns its place sits next to the line it protects. A block this' +
        '\nlong at the top of a file is usually rationale -- why the file has the shape it' +
        '\nhas -- which belongs in the directory README or an ADR, not in the source.' +
        '\n\nIf it genuinely cannot be shortened, say why, in the file:' +
        '\n  // orivon:comment-budget -- <why this cannot be shortened>\n'
      )
    }

    if (result.unjustified.length > 0) {
      console.error('\nFiles carrying the exemption pragma with no reason after it:\n')
      for (const { file } of result.unjustified) console.error(`  ${file}`)
      console.error('\nThe reason is the point. Write `-- <why>` after the pragma.\n')
    }

    if (result.stale.length > 0) {
      console.error(`\n${BASELINE_FILE} lists files that no longer need it:\n`)
      for (const file of result.stale) console.error(`  ${file}`)
      console.error('\nDelete these lines. The baseline is allowed to shrink, never to grow.\n')
    }

    if (result.unreadable.length > 0) {
      console.error('\nFiles this guard could not read -- unknown, not compliant:\n')
      for (const { file, error } of result.unreadable) console.error(`  ${file}  (${error})`)
      console.error('')
    }

    process.exit(1)
  }

  const notes = [
    `${result.exempted.length} justified exemption(s)`,
    `${result.baselined.length} baselined`
  ].join(', ')
  console.log(`Every source file opens within the ${PREAMBLE_LIMIT}-line comment budget (${notes}).`)
}
