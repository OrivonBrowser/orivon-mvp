import { describe, expect, it } from 'vitest'
import { fitAddress } from '../fit-address.js'

/** A measure where every character is one pixel wide. */
const within = (room: number) => (candidate: string): boolean => candidate.length <= room

const PAYPAL_HOST = 'www.paypal.com.account-verification-secure.evil.example'
const PAYPAL_ORIGIN = `https://${PAYPAL_HOST}`
const PAYPAL = `${PAYPAL_ORIGIN}/login`

describe('fitAddress: an address that fits', () => {
  it('is left whole', () => {
    expect(fitAddress('https://example.com/a?b#c', within(40))).toBe('https://example.com/a?b#c')
    expect(fitAddress('https://example.com/', within(20))).toBe('https://example.com/')
  })
})

describe('fitAddress: the path goes first', () => {
  it('keeps the whole host and as much of the path as there is room for, then an ellipsis', () => {
    const fitted = fitAddress(`https://example.com/${'p'.repeat(200)}`, within(40))
    expect(fitted).toBe(`https://example.com/${'p'.repeat(19)}…`)
    expect(fitted).toHaveLength(40)
  })

  it('keeps the host and a lone slash before it gives up any of the host', () => {
    const fitted = fitAddress('https://example.com/some/long/path', within(21))
    expect(fitted).toBe('https://example.com/…')
  })

  it('cuts a query as it does a path', () => {
    expect(fitAddress(`https://example.com?q=${'x'.repeat(100)}`, within(30))).toHaveLength(30)
    expect(fitAddress(`https://example.com?q=${'x'.repeat(100)}`, within(30)).startsWith('https://example.com?q=')).toBe(true)
  })
})

describe('fitAddress: then the middle of the host, never its end', () => {
  it('drops the whole path, with no mark that could be taken for a cut host, when only the host fits', () => {
    expect(fitAddress(PAYPAL, within(PAYPAL_ORIGIN.length))).toBe(PAYPAL_ORIGIN)
  })

  it('shows the end of a host that is cut, where the page is that the address is for', () => {
    const fitted = fitAddress(PAYPAL, within(50))
    expect(fitted.length).toBeLessThanOrEqual(50)
    expect(fitted.startsWith('https://www.paypal')).toBe(true)
    expect(fitted).toContain('…')
    expect(fitted.endsWith('evil.example')).toBe(true)
    expect(fitted).not.toContain('/login')
  })

  it.each(Array.from({ length: 57 }, (_, room) => room + 6))('ends on the end of the host with room for %i characters', (room) => {
    const fitted = fitAddress(PAYPAL, within(room))
    const tail = fitted.slice(fitted.lastIndexOf('…') + 1)
    expect(tail.length).toBeGreaterThan(0)
    expect(PAYPAL_HOST.endsWith(tail)).toBe(true)
    if (room >= 30) expect(fitted.endsWith('evil.example')).toBe(true)
  })

  it('uses the room it has: the longest cut that fits', () => {
    const fitted = fitAddress(PAYPAL, within(40))
    expect(fitted).toHaveLength(40)
  })

  it('keeps a port with the end of the host', () => {
    const fitted = fitAddress(`https://${'a'.repeat(80)}.evil.example:8443/x`, within(40))
    expect(fitted.endsWith('evil.example:8443')).toBe(true)
  })

  it('drops the scheme when not even it and the end of the host fit, and still ends on the host', () => {
    const fitted = fitAddress(PAYPAL, within(9))
    expect(fitted.startsWith('https://')).toBe(false)
    expect(fitted.startsWith('…')).toBe(true)
    expect(fitted.endsWith('example')).toBe(true)
    expect(fitted.length).toBeLessThanOrEqual(9)
  })

  it('shows at least the last character of the host in no room at all', () => {
    expect(fitAddress(PAYPAL, within(0))).toBe('…e')
  })

  it('reads a blob address by the host it holds', () => {
    const fitted = fitAddress(`blob:https://${'a'.repeat(60)}.evil.example/0b1f`, within(40))
    expect(fitted.endsWith('evil.example')).toBe(true)
  })

  it('reads an address of a name served from IPFS as it is: its name is the host', () => {
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const fitted = fitAddress(`ipfs://${cid}/docs/a.html`, within(30))
    expect(fitted.startsWith('ipfs://')).toBe(true)
    expect(fitted.endsWith(cid.slice(-6))).toBe(true)
  })
})

describe('fitAddress: an address with no host', () => {
  it('cuts its end', () => {
    expect(fitAddress(`data:text/plain;base64,${'A'.repeat(100)}`, within(30))).toBe(`data:text/plain;base64,${'A'.repeat(6)}…`)
  })

  it('cuts the path of a file address, which has no host to keep', () => {
    expect(fitAddress(`file:///home/${'x'.repeat(100)}`, within(20))).toBe(`file:///home/${'x'.repeat(6)}…`)
  })

  it('never ends on half of a character that takes two code units', () => {
    const fitted = fitAddress(`data:${'\u{1F600}'.repeat(50)}`, within(9))
    expect(fitted).toBe('data:\u{1F600}\u2026')
  })
})
