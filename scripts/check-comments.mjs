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
 * Duplicated from scripts/check-size.mjs, which is unmerged on another branch
 * as this is written; consolidating the two is tracked as A48.
 */
function isTestFile (file) {
  return file.endsWith('.test.ts') || file === 'scripts/smoke.mjs' || file.startsWith('test/')
}

/**
 * How many lines of comment a file opens with.
 *
 * Counts from the first line (after a shebang, which is not a comment and is
 * not optional) through the LAST comment line before any code. A blank line
 * between two comment paragraphs counts -- the reader pays for it -- but the
 * blank lines between the block and the code do not.
 *
 * @returns {number} 0 when the file does not open with a comment at all.
 */
export function measurePreamble (text) {
  const lines = text.split('\n')
  const start = lines[0]?.startsWith('#!') ? 1 : 0

  let lastComment = -1
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    if (!line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*')) break
    lastComment = i
  }

  return lastComment < start ? 0 : lastComment - start + 1
}

/** The pragma's reason, or null when there is no pragma or it carries none. */
function exemptionReason (text, preambleLines) {
  const head = text.split('\n').slice(0, preambleLines + 1)
  for (const line of head) {
    if (!PRAGMA.test(line)) continue
    return line.match(PRAGMA_WITH_REASON)?.[1] ?? null
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

    const preamble = measurePreamble(text)
    if (preamble <= limit) continue

    const reason = exemptionReason(text, preamble)
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

    offenders.push({ file, preamble, limit })
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
