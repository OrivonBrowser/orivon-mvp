/**
 * Fails the build if an A-number is used twice across docs/open-questions.md
 * and docs/decisions/resolved-questions.md, or if an open entry runs past
 * 12 lines.
 *
 * Numbers are cited from source as the authority for why code is shaped a
 * certain way, so a reused one is ambiguous forever. Two branches opened at
 * the same time both read main's highest number and both take the next one;
 * this is what catches that at merge. The line ceiling is what keeps the open
 * file readable in one sitting.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

/** The two files this guard checks, root-relative. */
export const QUESTIONS_FILE = 'docs/open-questions.md'
export const RESOLVED_FILE = 'docs/decisions/resolved-questions.md'
export const MAX_ENTRY_LINES = 12

/** An open entry heading: `### A` and its number, with whatever follows ignored. */
const HEADING = /^### A(\d+[a-z]?)/
/** Any entry heading, A-numbered or not (`### B4`): each one ends the entry above it. */
const ANY_ENTRY = /^### [A-Z]{1,2}\d/
/** A resolved row: the first cell is the ID. */
const ROW = /^\|\s*A(\d+[a-z]?)\s*\|/

/**
 * Every `### A<number>` heading in `text`, in file order.
 * @returns {Array<{ number: string, line: number }>} `line` is 1-based.
 */
export function findHeadingNumbers (text) {
  return findMatches(text, HEADING)
}

/** Every `| A<number> |` table row in `text`, in file order. */
export function findRowNumbers (text) {
  return findMatches(text, ROW)
}

function findMatches (text, pattern) {
  const found = []
  outsideFences(text).forEach((line, i) => {
    const match = pattern.exec(line)
    if (match) found.push({ number: match[1], line: i + 1 })
  })
  return found
}

/** `text`'s lines, with every line inside a fenced code block blanked: an example is not an entry. */
function outsideFences (text) {
  let fenced = false
  return text.split('\n').map((line) => {
    const fence = /^\s*```/.test(line)
    if (fence) fenced = !fenced
    return fenced || fence ? '' : line
  })
}

/**
 * Every entry in `text` longer than `max` lines, counted from its heading to
 * its last non-blank line, stopping at the next entry or `##` section.
 * @returns {Array<{ id: string, line: number, lines: number }>}
 */
export function findLongEntries (text, max = MAX_ENTRY_LINES) {
  const lines = outsideFences(text)
  const long = []
  let current = null
  const close = (end) => {
    if (current === null) return
    let last = end - 1
    while (last > current.start && lines[last].trim() === '') last--
    const count = last - current.start + 1
    if (count > max) long.push({ id: current.id, line: current.start + 1, lines: count })
    current = null
  }
  lines.forEach((line, i) => {
    const entry = ANY_ENTRY.test(line)
    if (entry || /^#{1,2} /.test(line)) close(i)
    if (entry) current = { id: line.slice(4).split(/[:\s]/)[0], start: i }
  })
  close(lines.length)
  return long
}

/**
 * @param {string} root Repository root.
 * @returns {{ ok: boolean,
 *   duplicates: Array<{ number: string, places: string[] }>,
 *   long: Array<{ id: string, line: number, lines: number }>, error?: string }}
 *   `places` are `file:line`, and `duplicates` is sorted by number. `error`
 *   is set, with `ok` false, when either file could not be read: unknown,
 *   not clean.
 */
export function checkQuestionNumbers (root) {
  let open, resolved
  try {
    open = readFileSync(join(root, QUESTIONS_FILE), 'utf8')
    resolved = readFileSync(join(root, RESOLVED_FILE), 'utf8')
  } catch (err) {
    return { ok: false, duplicates: [], long: [], error: `could not read ${err.path ?? 'a questions file'}: ${err.code ?? err.message}` }
  }

  const byNumber = new Map()
  const note = (file) => ({ number, line }) => {
    const places = byNumber.get(number) ?? []
    places.push(`${file}:${line}`)
    byNumber.set(number, places)
  }
  findHeadingNumbers(open).forEach(note(QUESTIONS_FILE))
  findRowNumbers(resolved).forEach(note(RESOLVED_FILE))

  const duplicates = [...byNumber.entries()]
    .filter(([, places]) => places.length > 1)
    .map(([number, places]) => ({ number, places }))
    .sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10))
  const long = findLongEntries(open)

  return { ok: duplicates.length === 0 && long.length === 0, duplicates, long }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkQuestionNumbers(process.cwd())

  if (!result.ok) {
    if (result.error) {
      console.error(`\n${result.error}\nTreating this as a failed scan, not a clean one.\n`)
    }

    if (result.duplicates.length > 0) {
      console.error('\nThe same A-number is used more than once:\n')
      for (const { number, places } of result.duplicates) {
        console.error(`  A${number}  (${places.join(', ')})`)
      }
      console.error(
        "\nRenumber the entry that merges later from main's highest, and move any source" +
        '\ncomment citing it.\n'
      )
    }

    if (result.long.length > 0) {
      console.error(`\nOpen entries over ${MAX_ENTRY_LINES} lines in ${QUESTIONS_FILE}:\n`)
      for (const { id, line, lines } of result.long) console.error(`  ${id}  (line ${line}, ${lines} lines)`)
      console.error('\nKeep the fixed shape: Question, Why it matters, Options, Who decides, Blocks.\n')
    }

    process.exit(1)
  }

  console.log(`No A-number is used twice, and every open entry fits in ${MAX_ENTRY_LINES} lines.`)
}
