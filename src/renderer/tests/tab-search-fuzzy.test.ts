import { describe, expect, it } from 'vitest'
import { fold, matchRow, score, segments } from '../overlay/tab-search/fuzzy.js'

describe('fold', () => {
  it('lowers case and takes accents off', () => {
    expect(fold('Café Überall')).toBe('cafe uberall')
    expect(fold('ŞİMDİ')).toContain('s')
  })
})

describe('score', () => {
  it('ranks the start of a word over a substring over letters in order', () => {
    const word = score('rep', 'Alpha report')
    const inside = score('ort', 'Alpha report')
    const letters = score('alr', 'Alpha report')
    expect(word?.kind).toBe('word')
    expect(inside?.kind).toBe('substring')
    expect(letters?.kind).toBe('subsequence')
    expect(word?.score).toBeGreaterThan(inside?.score ?? Infinity)
    expect(inside?.score).toBeGreaterThan(letters?.score ?? Infinity)
  })

  it('prefers an earlier match within one kind', () => {
    expect((score('alp', 'Alpha beta')?.score ?? 0)).toBeGreaterThan(score('bet', 'Alpha beta')?.score ?? 0)
  })

  it('takes a word start in preference to an earlier match inside a word', () => {
    const found = score('ta', 'Data table')
    expect(found).toMatchObject({ kind: 'word', ranges: [[5, 7]] })
  })

  it('matches without regard to case or accents, and reports positions in the original text', () => {
    expect(score('CAFE', 'un café noir')).toMatchObject({ kind: 'word', ranges: [[3, 7]] })
    expect(score('cafe', 'CAFÉ')?.ranges).toEqual([[0, 4]])
  })

  it('reports the letters of a match in order as merged ranges', () => {
    expect(score('gmm', 'Gamma')?.ranges).toEqual([[0, 1], [2, 4]])
  })

  it('refuses one letter that is not a substring, and accepts it as a substring', () => {
    expect(score('z', 'Alpha report')).toBeNull()
    expect(score('q', 'alpha')).toBeNull()
    expect(score('a', 'beta')?.kind).toBe('substring')
  })

  it('needs at least two letters to match by order alone', () => {
    expect(score('ao', 'alpha report')).not.toBeNull()
    expect(score('xy', 'alpha')).toBeNull()
  })

  it('matches everything, with no ranges, for an empty query', () => {
    expect(score('', 'anything')).toEqual({ score: 0, ranges: [], kind: 'substring' })
  })

  it('does not split a character that folds to several', () => {
    expect(score('i', 'İstanbul')?.ranges).toEqual([[0, 1]])
  })
})

describe('matchRow', () => {
  it('ranks a title word start over a title substring over the address over letters in order', () => {
    const titleWord = matchRow('bet', 'Beta notes', 'one.example')
    const titleInside = matchRow('bet', 'Alphabet', 'one.example')
    const address = matchRow('bet', 'Notes', 'beta.example.com')
    const letters = matchRow('bta', 'Beta', 'other.example')
    const scores = [titleWord, titleInside, address, letters].map((match) => match?.score ?? -1)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(new Set(scores).size).toBe(4)
  })

  it('marks the address when it is the address that matched', () => {
    expect(matchRow('exam', 'Notes', 'my.example.com')).toMatchObject({ titleRanges: [], hostRanges: [[3, 7]] })
  })

  it('never matches the address by letters in order', () => {
    expect(matchRow('mxl', 'Notes', 'my.example.com')).toBeNull()
  })

  it('needs every word of the query to match, in any order', () => {
    expect(matchRow('report alpha', 'Alpha report', '')).not.toBeNull()
    expect(matchRow('alpha gamma', 'Alpha report', '')).toBeNull()
  })

  it('matches everything for a blank query', () => {
    expect(matchRow('  ', 'x', 'y')).toEqual({ score: 0, titleRanges: [], hostRanges: [] })
  })
})

describe('segments', () => {
  it('cuts the text at the ranges and says which pieces are hits', () => {
    expect(segments('Alpha report', [[0, 2], [6, 9]])).toEqual([
      { text: 'Al', hit: true }, { text: 'pha ', hit: false }, { text: 'rep', hit: true }, { text: 'ort', hit: false }
    ])
    expect(segments('plain', [])).toEqual([{ text: 'plain', hit: false }])
  })
})
