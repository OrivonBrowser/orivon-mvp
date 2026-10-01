import { describe, expect, it } from 'vitest'
import { engineLabelFor, menuSafe, queryFrom, searchLabel } from '../context-menu-text.js'

describe('menuSafe', () => {
  it('doubles an ampersand so no mnemonic appears', () => {
    expect(menuSafe('Tom & Jerry')).toBe('Tom && Jerry')
  })

  it('drops control characters and line breaks into single spaces', () => {
    expect(menuSafe('a\u0000b\n\n c\t d')).toBe('a b c d')
  })
})

describe('queryFrom', () => {
  it('collapses whitespace and trims', () => {
    expect(queryFrom('  hello \n  world  ')).toBe('hello world')
  })

  it('is empty for a blank selection', () => {
    expect(queryFrom(' \n\t ')).toBe('')
  })

  it('stops at 1,000 characters', () => {
    expect(queryFrom('x'.repeat(5000))).toHaveLength(1000)
  })
})

describe('searchLabel', () => {
  it('names the engine and quotes the text', () => {
    expect(searchLabel('DuckDuckGo', 'orivon')).toBe('Search DuckDuckGo for “orivon”')
  })

  it('cuts the text at 30 characters and adds an ellipsis', () => {
    const label = searchLabel('DuckDuckGo', 'a'.repeat(45))
    expect(label).toBe(`Search DuckDuckGo for “${'a'.repeat(30)}…”`)
  })

  it('leaves a 30-character text whole', () => {
    expect(searchLabel('Bing', 'b'.repeat(30))).toBe(`Search Bing for “${'b'.repeat(30)}”`)
  })

  it('doubles an ampersand in the text and in the engine name', () => {
    expect(searchLabel('A&B', 'fish & chips')).toBe('Search A&&B for “fish && chips”')
  })
})

describe('engineLabelFor', () => {
  it('uses the engine\'s own name', () => {
    expect(engineLabelFor('brave')).toBe('Brave Search')
  })

  it('says "the Web" for a custom or unknown engine', () => {
    expect(engineLabelFor('custom')).toBe('the Web')
    expect(engineLabelFor('nonsense')).toBe('the Web')
  })
})
