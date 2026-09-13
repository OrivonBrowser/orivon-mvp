/**
 * Fails the build if docs/open-questions.md gives the same A-number to two
 * entries.
 *
 * CLAUDE.md tells every branch to take its next number from `main`'s
 * highest, and that rule cannot prevent a collision: two branches opened at
 * the same time both read the same highest number and both take the next
 * one. It happened three times in one evening (PRs #163/#165, #166/#167,
 * #168), each needing a manual renumber at merge time, each moving source
 * comments that cited the number. A number reused after that point is
 * ambiguous forever -- `A115`, `A137`, `A141` and the rest are cited from
 * source as the authority for why code is shaped a certain way.
 *
 * Deliberately does not require entries to be in numeric order -- they are
 * grouped by the session that filed them, so `A140` legitimately sits after
 * `A142` on `main` today. See check-questions.test.ts for the test asserting
 * this is not an oversight.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

/** The file this guard checks, root-relative. */
export const QUESTIONS_FILE = 'docs/open-questions.md'

/**
 * An entry heading: three `#`, a space, then `A` and its number. Everything
 * after the number -- an em dash, `--`, a bare newline, a trailing
 * `**[STATUS]**` tag, or a word like "addendum" -- is irrelevant to this
 * guard, so it is not matched at all: only the number identifies an entry.
 */
const HEADING = /^### A(\d+)/

/**
 * Every `### A<number>` heading in `text`, in file order.
 * @returns {Array<{ number: string, line: number }>} `line` is 1-based.
 */
export function findHeadingNumbers (text) {
  const found = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i])
    if (match) found.push({ number: match[1], line: i + 1 })
  }
  return found
}

/**
 * @param {string} root Repository root.
 * @returns {{ ok: boolean,
 *   duplicates: Array<{ number: string, lines: number[] }>, error?: string }}
 *   `duplicates` lists every number claimed by more than one heading, each
 *   with every line it appears on, sorted numerically by number.
 *   `error` is set, with `duplicates` empty and `ok` false, when the file
 *   itself could not be read -- unknown, not clean.
 */
export function checkQuestionNumbers (root) {
  let text
  try {
    text = readFileSync(join(root, QUESTIONS_FILE), 'utf8')
  } catch (err) {
    return { ok: false, duplicates: [], error: `could not read ${QUESTIONS_FILE}: ${err.code ?? err.message}` }
  }

  const byNumber = new Map()
  for (const { number, line } of findHeadingNumbers(text)) {
    const lines = byNumber.get(number) ?? []
    lines.push(line)
    byNumber.set(number, lines)
  }

  const duplicates = [...byNumber.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([number, lines]) => ({ number, lines }))
    .sort((a, b) => Number(a.number) - Number(b.number))

  return { ok: duplicates.length === 0, duplicates }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkQuestionNumbers(process.cwd())

  if (!result.ok) {
    if (result.error) {
      console.error(`\n${result.error}\nTreating this as a failed scan, not a clean one.\n`)
    }

    if (result.duplicates.length > 0) {
      console.error(`\n${QUESTIONS_FILE} gives the same number to more than one entry:\n`)
      for (const { number, lines } of result.duplicates) {
        console.error(`  A${number}  (lines ${lines.join(', ')})`)
      }
      console.error(
        "\nTwo branches opened at the same time can both read main's highest number and" +
        '\nboth take the next one -- that is the collision this guard exists to catch.' +
        '\nRenumber the entry that merges later, and move any source comment citing it.\n'
      )
    }

    process.exit(1)
  }

  console.log(`${QUESTIONS_FILE} has no duplicate entry numbers.`)
}
