import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkQuestionNumbers, findHeadingNumbers, QUESTIONS_FILE } from '../check-questions.mjs'

/** A scratch directory holding only docs/open-questions.md, with the given body. */
const fixture = (body: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-questions-'))
  const full = join(root, QUESTIONS_FILE)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  return root
}

describe('checkQuestionNumbers', () => {
  it('passes a file whose entry numbers are all distinct', () => {
    const body = [
      '### A1 -- first question **[STILL OPEN]**',
      '',
      'Body text.',
      '',
      '### A2 — second question, em dash this time',
      '',
      'More body text.',
      ''
    ].join('\n')
    const result = checkQuestionNumbers(fixture(body))
    expect(result.ok).toBe(true)
    expect(result.duplicates).toEqual([])
  })

  it('fails when the same number headings twice, naming every line it appears on', () => {
    const body = [
      '### A115 -- first claim to this number',
      '',
      'Body one.',
      '',
      '### A116 -- an unrelated entry in between',
      '',
      'Body two.',
      '',
      '### A115 — a second, colliding claim to the same number',
      '',
      'Body three.',
      ''
    ].join('\n')
    const result = checkQuestionNumbers(fixture(body))
    expect(result.ok).toBe(false)
    expect(result.duplicates).toEqual([
      { number: '115', lines: [1, 9] }
    ])
  })

  it('reports every duplicated number, not just the first', () => {
    const body = [
      '### A1 -- one',
      '### A2 -- two',
      '### A1 -- one again',
      '### A2 -- two again'
    ].join('\n')
    const result = checkQuestionNumbers(fixture(body))
    expect(result.ok).toBe(false)
    expect(result.duplicates).toEqual([
      { number: '1', lines: [1, 3] },
      { number: '2', lines: [2, 4] }
    ])
  })

  it('does not require entries to be in numeric order -- that is this file\'s real convention, not a defect', () => {
    // Entries are grouped by the session that filed them, so a later-numbered
    // entry legitimately sits before an earlier one (A142 before A140 on
    // main today). A check that demanded sorted numbers would be wrong.
    const body = [
      '### A142 -- filed in a later session, appears first in the file',
      '',
      '### A140 -- filed earlier, but appended after A142 in this file',
      ''
    ].join('\n')
    const result = checkQuestionNumbers(fixture(body))
    expect(result.ok).toBe(true)
    expect(result.duplicates).toEqual([])
  })

  it('matches the file\'s real heading shapes: bare number, "--", an em dash, a status tag, and a word right after the number', () => {
    const body = [
      '### A1',
      '',
      '### A2 -- ascii double hyphen **[RESOLVED 2026-09-01 -- owner decision]**',
      '',
      '### A3 — em dash, no status tag',
      '',
      '### A4 addendum — a word right after the number, no separator',
      ''
    ].join('\n')
    expect(findHeadingNumbers(body)).toEqual([
      { number: '1', line: 1 },
      { number: '2', line: 3 },
      { number: '3', line: 5 },
      { number: '4', line: 7 }
    ])
  })

  it('ignores a heading that starts with "A" but has no number, such as a section titled Advertising', () => {
    const body = '### Advertising priced by trustlessity level\n\nNo number here at all.\n'
    const result = checkQuestionNumbers(fixture(body))
    expect(result.ok).toBe(true)
    expect(result.duplicates).toEqual([])
  })

  it('reports a missing file as an error, not a silent pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-questions-'))
    const result = checkQuestionNumbers(root)
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('passes the real docs/open-questions.md as it stands on main', () => {
    const result = checkQuestionNumbers(process.cwd())
    expect(result.ok).toBe(true)
    expect(result.duplicates).toEqual([])
  })
})
