import { describe, expect, it } from 'vitest'
import { formatAddress } from '../chrome/address-format.js'

const plain = (url: string, full = false): string[] => formatAddress(url, { full }).map((part) => `${part.tone === 'strong' ? '*' : '.'}${part.text}`)

describe('formatAddress', () => {
  it.each([
    ['https://github.com/orivon/x?tab=1', ['*github.com', './orivon/x?tab=1']],
    ['https://www.github.com/orivon', ['*github.com', './orivon']],
    ['http://example.org/', ['*example.org']],
    ['https://docs.example.co.uk/a', ['.docs.', '*example.co.uk', './a']],
    ['https://a.b.example.com/', ['.a.b.', '*example.com']],
    ['http://localhost:5173/app', ['*localhost', '.:5173/app']],
    ['http://127.0.0.1:8080/x', ['*127.0.0.1', '.:8080/x']],
    ['http://[::1]:3000/', ['*[::1]', '.:3000']],
    ['https://example.com/#top', ['*example.com', './#top']],
    ['https://example.com?q=1', ['*example.com', '.?q=1']]
  ])('hides https, www and a bare slash: %s', (url, expected) => {
    expect(plain(url)).toEqual(expected)
  })

  it('does not treat every short second label as a country suffix', () => {
    expect(plain('https://shop.co.example/')).toEqual(['.shop.', '*co.example'])
    expect(plain('https://x.com.au/')).toEqual(['*x.com.au'])
  })

  it('keeps the scheme of a protocol address and makes its name the strong part', () => {
    expect(plain('ipfs://bafybeigdyrzt/docs/a.md')).toEqual(['.ipfs://', '*bafybeigdyrzt', './docs/a.md'])
    expect(plain('ipns://vitalik.eth/')).toEqual(['.ipns://', '*vitalik.eth', './'])
    expect(plain('orivon://settings/search')).toEqual(['.orivon://', '*settings', './search'])
  })

  it('shows a name served at its own https origin as that name', () => {
    expect(plain('https://vitalik.eth/')).toEqual(['*vitalik.eth'])
  })

  it('shows an address that has no scheme separator whole', () => {
    expect(plain('about:blank')).toEqual(['*about:blank'])
    expect(plain('view-source:https://example.com/')).toEqual(['*view-source:https://example.com/'])
  })

  it('shows a host-less address with its path as the strong part', () => {
    expect(plain('file:///home/me/a.html')).toEqual(['.file://', '*/home/me/a.html'])
  })

  it('is empty for nothing', () => {
    expect(formatAddress('', { full: false })).toEqual([])
  })

  it('shows the literal address in full mode, with the same tones', () => {
    expect(plain('https://www.github.com/', true)).toEqual(['.https://www.', '*github.com', './'])
    expect(plain('http://docs.example.co.uk:81/a', true)).toEqual(['.http://docs.', '*example.co.uk', '.:81/a'])
  })

  it('cuts a very long address so the page never builds a huge element', () => {
    const parts = formatAddress(`https://example.com/${'a'.repeat(300)}`, { full: false })
    expect(parts.map((part) => part.text).join('')).toBe(`example.com/${'a'.repeat(300)}`)
    const huge = formatAddress(`https://example.com/${'a'.repeat(100000)}`, { full: false })
    expect(huge.map((part) => part.text).join('').length).toBeLessThanOrEqual(512)
    expect(huge[0]).toEqual({ text: 'example.com', tone: 'strong', fixed: true })
  })

  it('never merges the two tones', () => {
    for (const url of ['https://a.example.co.uk/x', 'http://localhost/x', 'ipfs://x/y']) {
      const parts = formatAddress(url, { full: false })
      parts.forEach((part, index) => { if (index > 0) expect(part.tone).not.toBe(parts[index - 1]?.tone) })
    }
  })
})

describe('the part of an address a long run of labels or text must not push out of view', () => {
  it('marks the site\'s own name as the one fixed part, however long what comes before and after it is', () => {
    const subdomain = `accounts.google.com.${'verify-session-0000.'.repeat(8)}`
    const parts = formatAddress(`https://${subdomain}evil.example/${'p'.repeat(300)}`, { full: false })
    expect(parts.map((part) => part.fixed === true)).toEqual([false, true, false])
    expect(parts[1]).toEqual({ text: 'evil.example', tone: 'strong', fixed: true })
    expect(parts[0]?.text.startsWith('accounts.google.com.')).toBe(true)
  })

  it('marks nothing as fixed for an address with no host of its own', () => {
    for (const url of ['file:///home/me/a.html', 'about:blank']) expect(formatAddress(url, { full: false }).some((part) => part.fixed === true)).toBe(false)
  })

  it('keeps the host in the cut when a scheme and userinfo are very long', () => {
    const parts = formatAddress(`https://${'u'.repeat(900)}@evil.example/`, { full: true })
    expect(parts.some((part) => part.fixed === true && part.text === 'evil.example')).toBe(true)
  })
})
