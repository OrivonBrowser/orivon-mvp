import { describe, expect, it } from 'vitest'
import { addressLabel, splitMatches } from '../row-text.js'

describe('addressLabel', () => {
  it('drops the web schemes and a lone trailing slash', () => {
    expect(addressLabel('https://www.example.com/')).toBe('www.example.com')
    expect(addressLabel('http://example.com/a/b')).toBe('example.com/a/b')
    expect(addressLabel('https://example.com/a/')).toBe('example.com/a/')
    expect(addressLabel('ipfs://bafy/')).toBe('ipfs://bafy/')
    expect(addressLabel('HTTPS://EXAMPLE.com')).toBe('EXAMPLE.com')
  })
})

describe('splitMatches', () => {
  it('flags each match, whatever its case, and keeps the text as it was', () => {
    expect(splitMatches('Design notes: designs', 'DESIGN')).toEqual([
      { text: 'Design', match: true }, { text: ' notes: ', match: false }, { text: 'design', match: true }, { text: 's', match: false }
    ])
  })

  it('returns one plain piece with no needle or no match', () => {
    expect(splitMatches('abc', '')).toEqual([{ text: 'abc', match: false }])
    expect(splitMatches('abc', '  ')).toEqual([{ text: 'abc', match: false }])
    expect(splitMatches('abc', 'z')).toEqual([{ text: 'abc', match: false }])
    expect(splitMatches('', 'a')).toEqual([{ text: '', match: false }])
  })

  it('never splits inside what it was given as a whole', () => {
    expect(splitMatches('aaa', 'aa').map((piece) => piece.text).join('')).toBe('aaa')
  })
})
