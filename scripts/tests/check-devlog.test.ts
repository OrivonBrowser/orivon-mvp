import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDevlog, countWords, findLongBullets, JOURNAL, UPDATES_DIR } from '../check-devlog.mjs'

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

/** A scratch repository holding a journal and the given compiled updates. */
const fixture = (journal: string, updates: Record<string, string> = {}): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-devlog-'))
  mkdirSync(join(root, UPDATES_DIR), { recursive: true })
  writeFileSync(join(root, JOURNAL), journal)
  for (const [name, body] of Object.entries(updates)) writeFileSync(join(root, UPDATES_DIR, name), body)
  return root
}

describe('countWords', () => {
  it('does not count a bare dash or bold markers as words', () => {
    expect(countWords('**Short hook** — one sentence -- here')).toBe(5)
  })
})

describe('findLongBullets', () => {
  it('passes a bullet of exactly 25 words and flags one of 26, at its line', () => {
    const text = ['# Week', '', `- ${words(25)}`, `- ${words(26)}`].join('\n')
    expect(findLongBullets(text)).toEqual([{ line: 4, words: 26 }])
  })

  it('checks indented and starred bullets, and skips fenced code', () => {
    const text = [`  * ${words(30)}`, '```', `- ${words(30)}`, '```'].join('\n')
    expect(findLongBullets(text)).toEqual([{ line: 1, words: 30 }])
  })

  it('ignores prose paragraphs, which are not bullets', () => {
    expect(findLongBullets(words(60))).toEqual([])
  })
})

describe('checkDevlog', () => {
  it('passes a journal and updates whose bullets are all short', () => {
    const result = checkDevlog(fixture(`- ${words(10)}\n`, { '2026-09-27.md': `- ${words(20)}\n` }))
    expect(result).toEqual({ ok: true, long: [] })
  })

  it('names the file and line of every long bullet', () => {
    const root = fixture(`- ok\n- ${words(40)}\n`, { '2026-09-27.md': `- ${words(26)}\n` })
    expect(checkDevlog(root)).toEqual({
      ok: false,
      long: [
        { file: JOURNAL, line: 2, words: 40 },
        { file: `${UPDATES_DIR}/2026-09-27.md`, line: 1, words: 26 }
      ]
    })
  })

  it('leaves updates compiled before rule C alone', () => {
    const result = checkDevlog(fixture('', { '2026-09-13.md': `- ${words(80)}\n` }))
    expect(result.ok).toBe(true)
  })

  it('fails, rather than passing clean, when the journal is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-devlog-'))
    mkdirSync(join(root, UPDATES_DIR), { recursive: true })
    const result = checkDevlog(root)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not read devlog\/journal\.md/)
  })
})
