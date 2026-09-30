import { describe, expect, it } from 'vitest'
import { shortenMiddle } from '../address.js'

describe('shortening an address in the middle', () => {
  it('leaves a short address whole', () => {
    expect(shortenMiddle('https://a.test/x', 52)).toBe('https://a.test/x')
    expect(shortenMiddle('x'.repeat(52), 52)).toBe('x'.repeat(52))
  })

  it('cuts the middle and keeps both ends within the limit', () => {
    const address = `https://example.com/${'p/'.repeat(60)}end.html`
    const short = shortenMiddle(address, 52)
    expect(short).toHaveLength(52)
    expect(short.startsWith('https://example.com/')).toBe(true)
    expect(short.endsWith('end.html')).toBe(true)
    expect(short).toContain('…')
  })

  it('never splits a character made of two code units', () => {
    const short = shortenMiddle('\u{1F600}'.repeat(100), 10)
    expect([...short]).toHaveLength(10)
  })
})
