import { describe, expect, it } from 'vitest'
import { addPage, focusAfterRemove, joinPages, MAX_PAGES, removePage, shorten, splitPages } from '../settings/controls/page-list-model.js'

describe('the list as text', () => {
  it('reads one address a line, skipping blanks and trimming', () => {
    expect(splitPages('https://a.example/\n\n  https://b.example/  \n')).toEqual(['https://a.example/', 'https://b.example/'])
    expect(splitPages('')).toEqual([])
    expect(splitPages(undefined)).toEqual([])
    expect(splitPages(7)).toEqual([])
  })

  it('writes it back the same way', () => {
    expect(joinPages(['https://a.example/', 'https://b.example/'])).toBe('https://a.example/\nhttps://b.example/')
    expect(joinPages([])).toBe('')
  })
})

describe('addPage', () => {
  it('appends a new address', () => {
    expect(addPage(['https://a.example/'], 'https://b.example/')).toEqual({ kind: 'added', pages: ['https://a.example/', 'https://b.example/'] })
  })

  it('ignores one already listed, even when the list is full', () => {
    const full = Array.from({ length: MAX_PAGES }, (_, n) => `https://${String(n)}.example/`)
    expect(addPage(['https://a.example/'], 'https://a.example/')).toEqual({ kind: 'duplicate' })
    expect(addPage(full, 'https://3.example/')).toEqual({ kind: 'duplicate' })
  })

  it('refuses a ninth', () => {
    const full = Array.from({ length: MAX_PAGES }, (_, n) => `https://${String(n)}.example/`)
    expect(addPage(full, 'https://new.example/')).toEqual({ kind: 'full' })
    expect(addPage(full.slice(1), 'https://new.example/').kind).toBe('added')
  })
})

describe('removePage', () => {
  it('drops the row at the position and leaves the order of the rest', () => {
    expect(removePage(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(removePage(['a'], 0)).toEqual([])
    expect(removePage(['a', 'b'], 5)).toEqual(['a', 'b'])
  })
})

describe('focusAfterRemove', () => {
  it('moves to the button that took the row\'s place, else the last, else the field', () => {
    expect(focusAfterRemove(2, 0)).toEqual({ kind: 'remove', index: 0 })
    expect(focusAfterRemove(2, 2)).toEqual({ kind: 'remove', index: 1 })
    expect(focusAfterRemove(0, 0)).toEqual({ kind: 'field' })
  })
})

describe('shorten', () => {
  it('leaves a short address alone', () => {
    expect(shorten('https://example.com/')).toBe('https://example.com/')
  })

  it('cuts a long one in the middle, keeping both ends and the limit', () => {
    const long = `https://example.com/${'path/'.repeat(30)}end.html`
    const cut = shorten(long)
    expect(cut).toHaveLength(56)
    expect(cut.startsWith('https://example.com/')).toBe(true)
    expect(cut.endsWith('end.html')).toBe(true)
    expect(cut).toContain('…')
  })
})
