import { describe, expect, it } from 'vitest'
import { linkText, MAX_TEXT_LENGTH } from '../link-status-view.js'

describe('linkText', () => {
  it('is the address as it came', () => {
    expect(linkText('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
  })

  it('cuts an address longer than the limit', () => {
    expect(linkText('x'.repeat(MAX_TEXT_LENGTH + 500))).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('never ends on half of a character that takes two code units', () => {
    const cut = linkText(`${'x'.repeat(MAX_TEXT_LENGTH - 1)}\u{1F600}`)
    expect(cut).toBe('x'.repeat(MAX_TEXT_LENGTH - 1))
  })

  it('keeps a whole character at the limit', () => {
    expect(linkText(`${'x'.repeat(MAX_TEXT_LENGTH - 2)}\u{1F600}`)).toHaveLength(MAX_TEXT_LENGTH)
  })
})
