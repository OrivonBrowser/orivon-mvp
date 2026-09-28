/**
 * Fails when a bullet in the devlog journal or a compiled weekly update runs
 * over 25 words: `.claude/commands/devlog.md` rule C, the ceiling the
 * `/devlog` command's step 5 checks by hand.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

export const WORD_LIMIT = 25
export const JOURNAL = 'devlog/journal.md'
export const UPDATES_DIR = 'devlog/updates'
/** Updates compiled before rule C existed were sent as they are; they are records, not drafts. */
export const FIRST_CHECKED_UPDATE = '2026-09-20.md'

/** A bullet at any indent: `-` or `*`, then a space. */
const BULLET = /^\s*[-*] (.*)$/

/** Words are whitespace-separated tokens with a letter or digit, so a lone `--` or `—` is not one. */
export function countWords (text) {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length
}

/**
 * Every bullet in `text` over `limit` words, skipping fenced code blocks.
 * @returns {Array<{ line: number, words: number }>} `line` is 1-based.
 */
export function findLongBullets (text, limit = WORD_LIMIT) {
  const found = []
  let fenced = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced
    if (fenced) return
    const match = BULLET.exec(line)
    if (!match) return
    const words = countWords(match[1])
    if (words > limit) found.push({ line: i + 1, words })
  })
  return found
}

/**
 * @param {string} root Repository root.
 * @returns {{ ok: boolean, long: Array<{ file: string, line: number, words: number }>,
 *   error?: string }} `error` is set, with `ok` false, when a file cannot be read.
 */
export function checkDevlog (root) {
  let files
  try {
    const updates = readdirSync(join(root, UPDATES_DIR))
      .filter((name) => name.endsWith('.md') && name >= FIRST_CHECKED_UPDATE)
      .sort()
      .map((name) => `${UPDATES_DIR}/${name}`)
    files = [JOURNAL, ...updates]
  } catch (err) {
    return { ok: false, long: [], error: `could not list ${UPDATES_DIR}: ${err.code ?? err.message}` }
  }

  const long = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      return { ok: false, long: [], error: `could not read ${file}: ${err.code ?? err.message}` }
    }
    for (const hit of findLongBullets(text)) long.push({ file, ...hit })
  }
  return { ok: long.length === 0, long }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkDevlog(process.cwd())

  if (result.error) {
    console.error(`\n${result.error}\nTreating this as a failed scan, not a clean one.\n`)
    process.exit(1)
  }
  if (!result.ok) {
    console.error(`\nDevlog bullets over ${WORD_LIMIT} words (.claude/commands/devlog.md rule C):\n`)
    for (const { file, line, words } of result.long) console.error(`  ${file}:${line}  ${words} words`)
    console.error('\nSplit each into two bullets, or cut the mechanism and keep the result.\n')
    process.exit(1)
  }

  console.log(`Every devlog bullet is at most ${WORD_LIMIT} words.`)
}
