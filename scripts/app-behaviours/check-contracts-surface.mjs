/**
 * A committed snapshot of what an app can write against: the code of every file in `src/contracts/`
 * with its comments removed, so exports, capability kinds, error codes and `LIMITS` show and a reworded
 * comment does not. Fails when the snapshot and the source disagree (`--update` rewrites it), and with
 * `--base <ref>` fails a pull request that changes a file's section with no line naming
 * `` `contracts/<file>` `` under `### Changed for apps` in CHANGELOG.md.
 *
 * Reads the contracts as text and imports `node:*` only: a guard that imported them could be switched
 * off by the change it exists to catch.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isInvokedDirectly } from '../cli.mjs'
import { changedSection } from './check-app-behaviours.mjs'

export const CONTRACTS_DIR = 'src/contracts'
export const SNAPSHOT = 'test/app-behaviours/contracts-surface.txt'
export const CHANGELOG = 'CHANGELOG.md'
const SECTION = /^== (.+)$/

/** `source` with its block and line comments removed; quoted text is left alone. */
export function stripComments (source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/** One section per file: a `== <name>` line, then its code with comments, trailing space and blank lines gone. */
export function surfaceOf (files) {
  return files
    .map(({ name, source }) => {
      const lines = stripComments(source).split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line !== '')
      return `== ${name}\n${lines.join('\n')}\n`
    })
    .join('')
}

/** The contracts, in name order: every `.ts` file directly in `src/contracts/`. */
export function readContracts (root) {
  return readdirSync(join(root, CONTRACTS_DIR))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(root, CONTRACTS_DIR, name), 'utf8') }))
}

/** `{ file: text }` of a snapshot. */
export function sectionsOf (snapshot) {
  const sections = new Map()
  let current = null
  for (const line of snapshot.split('\n')) {
    const header = SECTION.exec(line)
    if (header !== null) { current = header[1]; sections.set(current, ''); continue }
    if (current !== null && line !== '') sections.set(current, `${sections.get(current)}${line}\n`)
  }
  return sections
}

/** @returns {{ ok: boolean, expected: string, actual: string | null }} */
export function checkSurface (root) {
  const expected = surfaceOf(readContracts(root))
  let actual = null
  try { actual = readFileSync(join(root, SNAPSHOT), 'utf8') } catch { /* reported as drift */ }
  return { ok: actual === expected, expected, actual }
}

/**
 * The files whose section changed or went away between two snapshots, less those a line added under
 * `### Changed for apps` names as `` `contracts/<file>` ``.
 * @returns {{ file: string, why: 'changed' | 'added' | 'removed' }[]}
 */
export function findUnrecordedSurfaceChanges ({ baseSnapshot, headSnapshot, baseChangelog, headChangelog }) {
  const base = sectionsOf(baseSnapshot)
  const head = sectionsOf(headSnapshot)
  const had = new Set(changedSection(baseChangelog).map((line) => line.trim()))
  const added = changedSection(headChangelog).filter((line) => line.trim() !== '' && !had.has(line.trim())).join('\n')
  const unrecorded = []
  for (const file of new Set([...base.keys(), ...head.keys()])) {
    const before = base.get(file)
    const after = head.get(file)
    const why = before === undefined ? 'added' : after === undefined ? 'removed' : before !== after ? 'changed' : null
    if (why !== null && !added.includes(`\`contracts/${file}\``)) unrecorded.push({ file, why })
  }
  return unrecorded
}

function showAt (root, ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** @returns {{ ok: boolean, unrecorded: { file: string, why: string }[], skipped?: string }} */
export function checkAgainstBase (root, ref) {
  let base
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return { ok: false, unrecorded: [], skipped: `no merge base between HEAD and ${ref}; fetch the base branch with full history` }
  }
  const baseSnapshot = showAt(root, base, SNAPSHOT)
  if (baseSnapshot === null) return { ok: true, unrecorded: [], skipped: `${SNAPSHOT} does not exist at ${ref}: nothing to compare` }
  const unrecorded = findUnrecordedSurfaceChanges({
    baseSnapshot,
    headSnapshot: readFileSync(join(root, SNAPSHOT), 'utf8'),
    baseChangelog: showAt(root, base, CHANGELOG) ?? '',
    headChangelog: readFileSync(join(root, CHANGELOG), 'utf8')
  })
  return { ok: unrecorded.length === 0, unrecorded }
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  if (process.argv.includes('--update')) {
    const { expected } = checkSurface(root)
    mkdirSync(dirname(join(root, SNAPSHOT)), { recursive: true })
    writeFileSync(join(root, SNAPSHOT), expected)
    console.log(`Wrote ${SNAPSHOT}. Add a line naming each changed \`contracts/<file>\` under "### Changed for apps" in ${CHANGELOG}.`)
    process.exit(0)
  }
  const surface = checkSurface(root)
  if (!surface.ok) {
    console.error(`\n${SNAPSHOT} does not match ${CONTRACTS_DIR}/.`)
    console.error('If the change is intended: node scripts/app-behaviours/check-contracts-surface.mjs --update, then record it under "### Changed for apps" in CHANGELOG.md.\n')
    process.exit(1)
  }
  console.log(`${SNAPSHOT} matches ${CONTRACTS_DIR}/.`)

  const at = process.argv.indexOf('--base')
  if (at !== -1) {
    const ref = process.argv[at + 1]
    if (ref === undefined) {
      console.error('--base needs a ref, for example --base origin/main')
      process.exit(1)
    }
    const diff = checkAgainstBase(root, ref)
    if (!diff.ok && diff.skipped !== undefined) {
      console.error(`\n${diff.skipped}\nTreating this as a failed scan, not a clean one.\n`)
      process.exit(1)
    }
    if (!diff.ok) {
      console.error('\nThe public surface of src/contracts/ changed with no line under "### Changed for apps" in CHANGELOG.md:\n')
      for (const { file, why } of diff.unrecorded) console.error(`  \`contracts/${file}\` (${why})`)
      console.error('\nAdd, for each: - **`contracts/<file>`**: what changed. Apps that <do Y> must now <do Z>. Recheck: <ports>.\n')
      process.exit(1)
    }
    console.log(diff.skipped ?? `The surface is unchanged since ${ref}, or its changes are recorded.`)
  }
}
