/**
 * Keeps the app-behaviour catalogue (`docs/development/app-behaviours.md`) and the specs that prove it
 * in step. Every entry names an e2e spec, that spec has a test titled `[app:<id>]` which CI runs, and no
 * spec names an id the catalogue lacks. With `--base <ref>` it also fails a pull request that changes
 * or removes an entry without a line under `### Changed for apps` in CHANGELOG.md.
 *
 * A row names a spec as a Markdown link, resolved from the catalogue's own directory.
 *
 * Imports `node:*` only: a guard that depended on `src/` could be disabled by the change it catches.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { isInvokedDirectly, relativeToRoot } from './cli.mjs'

export const CATALOGUE = 'docs/development/app-behaviours.md'
export const CHANGELOG = 'CHANGELOG.md'
export const CI_WORKFLOW = '.github/workflows/ci.yml'
/** The CI job that runs the specs gated on an ordinary build. */
export const ORDINARY_JOB = 'e2e-ordinary'
export const CHANGED_HEADING = '### Changed for apps'
/** The one gate a proving test may carry: it needs the ordinary build, and `ORDINARY_JOB` runs it. */
export const ORDINARY_GATE = '.skipIf(!ORDINARY_BUILD)'

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MARKER = /\[app:([^\]\s]*)\]/g
const SCANNED_DIRS = ['test', 'src', 'scripts/tests']
const SCANNED_EXT = /\.(ts|tsx|mjs|js)$/
/** The guard's own test writes marker-shaped text into scratch fixtures. */
const SELF_TEST = 'scripts/tests/check-app-behaviours.test.ts'
const NOT_COVERED = /^not covered:\s*\S/
const E2E_SPEC = /^test\/e2e-[^/]+\.test\.ts$/

/**
 * @typedef {{ id: string, behaviour: string, apps: string, ports: string, provenBy: string,
 *   specs: string[], covered: boolean, line: number }} Entry
 */

/**
 * The entries of the catalogue: every table row whose first cell is a backticked id. Header and
 * separator rows start with anything else and are skipped.
 * @returns {{ entries: Entry[], problems: string[] }}
 */
export function parseCatalogue (text) {
  const entries = []
  const problems = []
  const seen = new Map()
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const row = raw.trim()
    if (!row.startsWith('|')) return
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    const first = /^`([^`]*)`$/.exec(cells[0] ?? '')
    if (first === null) return
    const id = first[1]
    if (cells.length !== 5) {
      problems.push(`${CATALOGUE}:${line}: \`${id}\` has ${cells.length} columns, expected 5 (id, behaviour, apps, ports, proven by)`)
      return
    }
    if (!ID.test(id)) problems.push(`${CATALOGUE}:${line}: \`${id}\` is not a kebab-case id`)
    if (seen.has(id)) problems.push(`${CATALOGUE}:${line}: \`${id}\` is already an entry at line ${seen.get(id)}`)
    seen.set(id, line)
    const [, behaviour, apps, ports, provenBy] = cells
    if (behaviour === '') problems.push(`${CATALOGUE}:${line}: \`${id}\` states no behaviour`)
    const covered = !NOT_COVERED.test(provenBy)
    const specs = [...provenBy.matchAll(/\]\(([^)\s]+\.test\.ts)\)/g)].map((m) => posix.normalize(posix.join(posix.dirname(CATALOGUE), m[1])))
    if (covered && specs.length === 0) problems.push(`${CATALOGUE}:${line}: \`${id}\` names no spec and is not marked "not covered: <reason>"`)
    if (covered && !specs.some((spec) => E2E_SPEC.test(spec))) {
      problems.push(`${CATALOGUE}:${line}: \`${id}\` is proven by no e2e spec; a unit test never proves an app behaviour alone, since it cannot see a broken wiring`)
    }
    entries.push({ id, behaviour, apps, ports, provenBy, specs, covered, line })
  })
  return { entries, problems }
}

/** Which characters of `source` are code: false inside a comment, a string or a template. */
export function codeMask (source) {
  const mask = new Array(source.length).fill(true)
  const blank = (from, to) => { for (let k = from; k < to && k < mask.length; k++) mask[k] = false }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const to = end === -1 ? source.length : end + 2
      blank(i, to)
      i = to
    } else if (c === '/' && next === '/') {
      let to = i
      while (to < source.length && source[to] !== '\n') to++
      blank(i, to)
      i = to
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      blank(i, j + 1)
      i = j + 1
    } else {
      i++
    }
  }
  return mask
}

/**
 * Every `it(` / `test(` call in a spec whose title is a literal, with the modifier chain between the
 * name and the call (`.skipIf(!X)`, `.skip`, ...) and the line the title sits on. A call inside a comment or
 * a string is not a test. `dynamic` is set for a template title that interpolates, which no one can read
 * a fixed id from.
 * @returns {Array<{ title: string, modifiers: string, line: number, dynamic: boolean }>}
 */
export function findTests (source) {
  const found = []
  const mask = codeMask(source)
  const head = /\b(?:it|test)((?:\.\w+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?)*)\(\s*([\'"`])((?:(?!\2)[^\\]|\\.)*)\2/g
  for (const match of source.matchAll(head)) {
    if (!mask[match.index]) continue
    const titleAt = match.index + match[0].length - match[3].length - 1
    found.push({ title: match[3], modifiers: match[1], line: source.slice(0, titleAt).split('\n').length, dynamic: match[2] === '`' && match[3].includes('${') })
  }
  return found
}

/** A suite-level skip, todo or only turns off tests this guard cannot see one by one. */
export function findSuiteSwitches (source) {
  return [...source.matchAll(/\bdescribe\.(skip|todo|only|runIf|skipIf)\b/g)].map((m) => m[0])
}

/** Ids a title carries, in order. */
function markersOf (title) {
  return [...title.matchAll(MARKER)].map((m) => m[1])
}

/** The text of the `ORDINARY_JOB` job in a workflow with its comments removed, or '' when it has none. */
export function jobText (workflow, job = ORDINARY_JOB) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${job}:`)
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[\w-]+:/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).map((line) => line.replace(/(^|\s)#.*$/, '$1')).join('\n')
}

function walk (root, rel, out) {
  let names
  try { names = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
  for (const entry of names) {
    if (entry.name === 'node_modules' || (entry.name === 'apps' && rel === 'test')) continue
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) walk(root, child, out)
    else if (SCANNED_EXT.test(entry.name)) out.push(child)
  }
}

/**
 * @param {string} root Repository root.
 * @returns {{ ok: boolean, problems: string[], entries: Entry[] }}
 */
export function checkCatalogue (root) {
  let text
  try {
    text = readFileSync(join(root, CATALOGUE), 'utf8')
  } catch (err) {
    return { ok: false, problems: [`could not read ${CATALOGUE}: ${err.code ?? err.message}`], entries: [] }
  }
  const { entries, problems } = parseCatalogue(text)
  if (entries.length === 0) problems.push(`${CATALOGUE} holds no entry`)
  const known = new Set(entries.map((entry) => entry.id))

  let workflow = ''
  try { workflow = readFileSync(join(root, CI_WORKFLOW), 'utf8') } catch { /* reported below, when a spec needs it */ }
  const ordinaryJob = jobText(workflow)

  const sources = new Map()
  const sourceOf = (spec) => {
    if (!sources.has(spec)) {
      try { sources.set(spec, readFileSync(join(root, spec), 'utf8')) } catch { sources.set(spec, null) }
    }
    return sources.get(spec)
  }

  for (const entry of entries) {
    if (!entry.covered) continue
    for (const spec of entry.specs) {
      const source = sourceOf(spec)
      if (source === null) {
        problems.push(`${CATALOGUE}:${entry.line}: \`${entry.id}\` names ${spec}, which does not exist`)
        continue
      }
      // A unit test listed beside the e2e spec is context for a reader, not proof, and carries no marker.
      if (!E2E_SPEC.test(spec)) continue
      for (const word of findSuiteSwitches(source)) {
        problems.push(`${spec}: ${word} switches off tests CI would otherwise run; \`${entry.id}\` cannot rest on it`)
      }
      const proving = findTests(source).filter((test) => markersOf(test.title).includes(entry.id))
      if (proving.length === 0) {
        problems.push(`${spec}: no test is titled with [app:${entry.id}]; ${CATALOGUE}:${entry.line} says this spec proves it`)
        continue
      }
      for (const test of proving) {
        if (test.dynamic) {
          problems.push(`${spec}:${test.line}: the test for \`${entry.id}\` has a title that interpolates; give the proving test a plain string title, so dropping it cannot go unseen`)
          continue
        }
        if (test.modifiers === '') continue
        if (test.modifiers === ORDINARY_GATE) {
          if (!ordinaryJob.includes(spec)) {
            problems.push(`${spec}:${test.line}: the test for \`${entry.id}\` needs an ordinary build, and ${CI_WORKFLOW} job ${ORDINARY_JOB} does not run ${spec}`)
          }
        } else {
          problems.push(`${spec}:${test.line}: the test for \`${entry.id}\` carries the modifier ${test.modifiers}; a test CI skips or narrows proves nothing`)
        }
      }
    }
  }

  const files = []
  for (const dir of SCANNED_DIRS) walk(root, dir, files)
  for (const file of files) {
    if (file === SELF_TEST) continue
    let source
    try { source = readFileSync(join(root, file), 'utf8') } catch { continue }
    if (!source.includes('[app:')) continue
    source.split('\n').forEach((line, i) => {
      for (const marker of line.matchAll(MARKER)) {
        if (!known.has(marker[1])) problems.push(`${relativeToRoot(root, join(root, file))}:${i + 1}: [app:${marker[1]}] is not an entry in ${CATALOGUE}`)
      }
    })
  }

  return { ok: problems.length === 0, problems, entries }
}

/** The lines under `### Changed for apps` in the first (unreleased) release section of a changelog. */
export function changedSection (changelog) {
  const lines = changelog.split('\n')
  const releases = lines.map((line, i) => (/^## /.test(line) ? i : -1)).filter((i) => i !== -1)
  const end = releases.length > 1 ? releases[1] : lines.length
  const from = lines.findIndex((line, i) => i < end && line.trim() === CHANGED_HEADING)
  if (from === -1) return []
  const body = []
  for (let i = from + 1; i < end && !/^#{2,3} /.test(lines[i]); i++) body.push(lines[i])
  return body
}

/**
 * The entries a pull request changed or removed without a record: an id whose behaviour sentence differs
 * from the base, or that is gone, and that no line added under `### Changed for apps` names in backticks.
 * A row that was proven and is now `not covered` needs one too. A new entry, or a change to who relies on
 * it or to which spec proves it, needs none.
 * @returns {{ id: string, why: 'changed' | 'removed' | 'no longer proven' }[]}
 */
export function findUnrecordedChanges ({ baseCatalogue, headCatalogue, baseChangelog, headChangelog }) {
  const base = parseCatalogue(baseCatalogue).entries
  const head = new Map(parseCatalogue(headCatalogue).entries.map((entry) => [entry.id, entry]))
  const had = new Set(changedSection(baseChangelog).map((line) => line.trim()))
  const added = changedSection(headChangelog).filter((line) => line.trim() !== '' && !had.has(line.trim())).join('\n')
  const unrecorded = []
  for (const before of base) {
    const after = head.get(before.id)
    const why = after === undefined
      ? 'removed'
      : after.behaviour.replace(/\s+/g, ' ') !== before.behaviour.replace(/\s+/g, ' ')
        ? 'changed'
        : before.covered && !after.covered ? 'no longer proven' : null
    if (why !== null && !added.includes(`\`${before.id}\``)) unrecorded.push({ id: before.id, why })
  }
  return unrecorded
}

/** `git show <ref>:<path>`, or null when the file is not there at that ref. */
function showAt (root, ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * Compares the working tree with the merge base of HEAD and `ref`.
 * @returns {{ ok: boolean, unrecorded: { id: string, why: string }[], skipped?: string }}
 */
export function checkAgainstBase (root, ref) {
  let base
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return { ok: false, unrecorded: [], skipped: `no merge base between HEAD and ${ref}; fetch the base branch with full history` }
  }
  const baseCatalogue = showAt(root, base, CATALOGUE)
  if (baseCatalogue === null) return { ok: true, unrecorded: [], skipped: `${CATALOGUE} does not exist at ${ref}: nothing to compare` }
  const headCatalogue = existsSync(join(root, CATALOGUE)) ? readFileSync(join(root, CATALOGUE), 'utf8') : ''
  const unrecorded = findUnrecordedChanges({
    baseCatalogue,
    headCatalogue,
    baseChangelog: showAt(root, base, CHANGELOG) ?? '',
    headChangelog: readFileSync(join(root, CHANGELOG), 'utf8')
  })
  return { ok: unrecorded.length === 0, unrecorded }
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const result = checkCatalogue(root)
  if (!result.ok) {
    console.error('\nApp-behaviour catalogue and specs disagree (docs/development/testing.md §App behaviours):\n')
    for (const problem of result.problems) console.error(`  ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(`${String(result.entries.length)} app behaviours; each is proven by a spec CI runs, or marked not covered.`)

  const at = process.argv.indexOf('--base')
  if (at !== -1) {
    const ref = process.argv[at + 1]
    if (ref === undefined) {
      console.error('--base needs a ref, for example --base origin/main')
      process.exit(1)
    }
    const diff = checkAgainstBase(root, ref)
    if (diff.skipped !== undefined && !diff.ok) {
      console.error(`\n${diff.skipped}\nTreating this as a failed scan, not a clean one.\n`)
      process.exit(1)
    }
    if (!diff.ok) {
      console.error(`\nA behaviour changed or was removed with no line under "${CHANGED_HEADING}" in ${CHANGELOG}:\n`)
      for (const { id, why } of diff.unrecorded) console.error(`  \`${id}\` (${why})`)
      console.error(`\nAdd, for each: - **\`<id>\`**: what changed. Apps that <do Y> must now <do Z>. Recheck: <ports>.\n`)
      process.exit(1)
    }
    console.log(diff.skipped ?? `No behaviour changed since ${ref} without a record.`)
  }
}
