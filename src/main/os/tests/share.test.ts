import { describe, expect, it } from 'vitest'
import { MAX_SUBJECT, mailtoFor, shareAddressFor, subjectFrom } from '../share.js'

const tab = (displayUrl: string, over: { isNewTab?: boolean, isInternal?: boolean } = {}): Parameters<typeof shareAddressFor>[0] => ({ isNewTab: false, isInternal: false, displayUrl, ...over })

describe('shareAddressFor', () => {
  it('is the address the person sees, for a page that has one', () => {
    expect(shareAddressFor(tab('https://example.com/a?b=c'))).toBe('https://example.com/a?b=c')
    expect(shareAddressFor(tab('http://127.0.0.1:8080/'))).toBe('http://127.0.0.1:8080/')
  })

  it('is the protocol address, not the https URL that serves it', () => {
    expect(shareAddressFor(tab('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'))).toBe('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/')
  })

  it('refuses the new-tab page, a shell page, and anything the address bar would not load', () => {
    expect(shareAddressFor(undefined)).toBeUndefined()
    expect(shareAddressFor(tab('https://example.com/', { isNewTab: true }))).toBeUndefined()
    expect(shareAddressFor(tab('orivon://settings', { isInternal: true }))).toBeUndefined()
    for (const url of ['', 'orivon://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'file:///etc/passwd', 'view-source:https://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'about:blank']) {
      expect(shareAddressFor(tab(url)), url).toBeUndefined()
    }
  })
})

describe('mailtoFor', () => {
  const parse = (mailto: string): { to: string, subject: string | null, body: string | null, keys: string[] } => {
    const url = new URL(mailto)
    return { to: url.pathname, subject: url.searchParams.get('subject'), body: url.searchParams.get('body'), keys: [...url.searchParams.keys()] }
  }

  it('puts the title in the subject and the address in the body', () => {
    expect(parse(mailtoFor('Example Domain', 'https://example.com/a?b=c&d=e'))).toEqual({ to: '', subject: 'Example Domain', body: 'https://example.com/a?b=c&d=e', keys: ['subject', 'body'] })
  })

  it('encodes every part, so a title cannot add a recipient, a header or a parameter', () => {
    const mailto = mailtoFor('Hi&cc=evil@example.com\r\nBcc: evil@example.com&body=x', 'https://example.com/?a=1&subject=2')
    expect(mailto.startsWith('mailto:?subject=')).toBe(true)
    expect(mailto).not.toMatch(/[\r\n ]/)
    const parsed = parse(mailto)
    expect(parsed.keys).toEqual(['subject', 'body'])
    expect(parsed.subject).toBe('Hi&cc=evil@example.com Bcc: evil@example.com&body=x')
    expect(parsed.body).toBe('https://example.com/?a=1&subject=2')
  })

  it('uses the address when the page has no title', () => {
    expect(parse(mailtoFor('  \n ', 'https://example.com/')).subject).toBe('https://example.com/')
  })
})

describe('subjectFrom', () => {
  it('reads as one line of plain text', () => {
    expect(subjectFrom('a\u0000b\tc\u2028d   e', 'x')).toBe('a b c d e')
  })

  it('is cut at a length a mail program shows, by characters and not by code units', () => {
    const long = '😀'.repeat(MAX_SUBJECT + 50)
    expect(Array.from(subjectFrom(long, 'x'))).toHaveLength(MAX_SUBJECT)
  })
})
