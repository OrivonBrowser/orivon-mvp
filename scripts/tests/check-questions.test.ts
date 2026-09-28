import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkQuestionNumbers, findHeadingNumbers, findLongEntries, MAX_ENTRY_LINES, QUESTIONS_FILE, RESOLVED_FILE
} from '../check-questions.mjs'

const TABLE = '| ID | Question | Resolution | Record |\n|---|---|---|---|\n'

/** A scratch repository holding both question files, with the given bodies. */
const fixture = (open: string, resolved = TABLE): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-questions-'))
  for (const [file, body] of [[QUESTIONS_FILE, open], [RESOLVED_FILE, resolved]] as const) {
    const full = join(root, file)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

/** An entry `lines` long, heading included. */
const entry = (id: string, lines: number): string =>
  [`### ${id}: a question **[AI-REC]**`, ...Array.from({ length: lines - 1 }, (_, i) => `- line ${i}`)].join('\n')

describe('checkQuestionNumbers', () => {
  it('passes when every number is used once across both files', () => {
    const result = checkQuestionNumbers(fixture(`${entry('A2', 3)}\n`, `${TABLE}| A1 | q | r | - |\n`))
    expect(result).toEqual({ ok: true, duplicates: [], long: [] })
  })

  it('fails when an open entry reuses a resolved number, naming both places', () => {
    const result = checkQuestionNumbers(fixture(`${entry('A7', 3)}\n`, `${TABLE}| A7 | q | r | - |\n`))
    expect(result.ok).toBe(false)
    expect(result.duplicates).toEqual([
      { number: '7', places: [`${QUESTIONS_FILE}:1`, `${RESOLVED_FILE}:3`] }
    ])
  })

  it('reports every duplicated number, within one file too, sorted by number', () => {
    const open = [entry('A12', 2), entry('A3', 2), entry('A12', 2), entry('A3', 2)].join('\n\n')
    expect(checkQuestionNumbers(fixture(open)).duplicates.map((d) => d.number)).toEqual(['3', '12'])
  })

  it('does not require numeric order: two branches merging can interleave their entries', () => {
    const open = [entry('A142', 2), entry('A140', 2)].join('\n\n')
    expect(checkQuestionNumbers(fixture(open)).ok).toBe(true)
  })

  it('ignores an example inside a fenced block, such as the shape shown in the header', () => {
    const open = ['```', '### A123: <title>', '```', '', entry('A123', 2)].join('\n')
    expect(checkQuestionNumbers(fixture(open)).ok).toBe(true)
  })

  it('fails an open entry over the line ceiling', () => {
    const result = checkQuestionNumbers(fixture(`${entry('A9', MAX_ENTRY_LINES + 1)}\n`))
    expect(result.ok).toBe(false)
    expect(result.long).toEqual([{ id: 'A9', line: 1, lines: MAX_ENTRY_LINES + 1 }])
  })

  it('reports a missing file as an error, not a silent pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-questions-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, QUESTIONS_FILE), '')
    const result = checkQuestionNumbers(root)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/resolved-questions\.md/)
  })

  it('passes the real files as they stand', () => {
    expect(checkQuestionNumbers(process.cwd())).toEqual({ ok: true, duplicates: [], long: [] })
  })
})

describe('findHeadingNumbers', () => {
  it('reads the number from every heading shape, and ignores a heading with no number', () => {
    const body = [
      '### A1',
      '### A2: colon **[OWNER]**',
      '### A3 -- double hyphen',
      '### A4a letter suffix',
      '### Advertising priced by level'
    ].join('\n')
    expect(findHeadingNumbers(body).map((h: { number: string }) => h.number)).toEqual(['1', '2', '3', '4a'])
  })
})

describe('findLongEntries', () => {
  it('passes an entry of exactly the ceiling, ignoring trailing blank lines', () => {
    expect(findLongEntries(`${entry('A1', MAX_ENTRY_LINES)}\n\n\n`)).toEqual([])
  })

  it('ends an entry at the next entry of any series, or at a section heading', () => {
    const body = [entry('A1', 10), entry('B4', 10), '## Section', 'prose '.repeat(3), entry('C2', 13)].join('\n')
    expect(findLongEntries(body)).toEqual([{ id: 'C2', line: 23, lines: 13 }])
  })
})
