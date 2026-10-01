import { describe, expect, it } from 'vitest'
import { asciiOnly, matrixFor, MAX_QR_CHARACTERS, pathData } from '../qr-svg.js'

describe('matrixFor', () => {
  it('encodes an address into a square with the three finder patterns', () => {
    const matrix = matrixFor('https://example.com/a')
    expect(matrix).not.toBeNull()
    const size = matrix?.size ?? 0
    expect(size).toBeGreaterThanOrEqual(21)
    expect((size - 17) % 4).toBe(0)
    for (const [row, column] of [[0, 0], [0, size - 1], [size - 1, 0]] as const) expect(matrix?.isDark(row, column)).toBe(true)
  })

  it('is deterministic', () => {
    const a = matrixFor('https://example.com/a')
    const b = matrixFor('https://example.com/a')
    expect(pathData(a as never)).toBe(pathData(b as never))
  })

  it('takes the longest address the sheet allows, and refuses one more', () => {
    expect(matrixFor(`https://example.com/${'a'.repeat(MAX_QR_CHARACTERS - 20)}`)).not.toBeNull()
    expect(matrixFor('a'.repeat(MAX_QR_CHARACTERS + 1))).toBeNull()
    expect(matrixFor('')).toBeNull()
  })
})

describe('pathData', () => {
  it('draws each row\'s runs of dark modules as rectangles of one module high', () => {
    const grid = ['##.#', '....', '.###', '#...']
    const d = pathData({ size: 4, isDark: (row, column) => grid[row]?.[column] === '#' })
    expect(d).toBe('M0 0h2v1h-2z' + 'M3 0h1v1h-1z' + 'M1 2h3v1h-3z' + 'M0 3h1v1h-1z')
  })

  it('is empty for an empty matrix', () => {
    expect(pathData({ size: 3, isDark: () => false })).toBe('')
  })
})

describe('asciiOnly', () => {
  it('leaves ASCII alone, percent signs included, and escapes the rest', () => {
    expect(asciiOnly('https://example.com/a%20b?x=1')).toBe('https://example.com/a%20b?x=1')
    expect(asciiOnly('https://example.com/é')).toBe('https://example.com/%C3%A9')
  })
})
