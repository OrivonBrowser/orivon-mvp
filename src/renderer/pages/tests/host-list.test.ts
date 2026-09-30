import { describe, expect, it } from 'vitest'
import { addHost, joinHosts, MAX_HOSTS, normaliseHost, parseHostList, removeHost, splitHosts } from '../settings/controls/host-list-model.js'

describe('normaliseHost', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['https://www.Example.com/path?q=1#top', 'www.example.com'],
    ['example.com:8080/x', 'example.com'],
    ['localhost', 'localhost'],
    ['sub.domain.example.co.uk', 'sub.domain.example.co.uk'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['ftp://files.example/', 'files.example']
  ])('reads %j as %j', (text, expected) => {
    expect(normaliseHost(text)).toBe(expected)
  })

  it.each([
    [''], ['   '], ['two words'], ['a..b'], ['-a.example'], ['a.example-'], ['exa_mple.com'], ['http://'], ['a b.example'], ['x'.repeat(260)], ['https://user@']
  ])('refuses %j', (text) => {
    expect(normaliseHost(text)).toBeNull()
  })
})

describe('the list as text', () => {
  it('reads one site a line, skipping blanks and trimming', () => {
    expect(splitHosts('a.example\n\n  b.example  \n')).toEqual(['a.example', 'b.example'])
    expect(splitHosts('')).toEqual([])
    expect(splitHosts(undefined)).toEqual([])
    expect(splitHosts(3)).toEqual([])
  })

  it('writes it back the same way', () => {
    expect(joinHosts(['a.example', 'b.example'])).toBe('a.example\nb.example')
    expect(joinHosts([])).toBe('')
  })
})

describe('parseHostList', () => {
  it('reads sites separated by spaces, commas, semicolons or line breaks, each once', () => {
    expect(parseHostList('a.example, b.example;c.example\nA.example  d.example')).toEqual(['a.example', 'b.example', 'c.example', 'd.example'])
  })

  it('is empty for nothing, and for text with any part that is not a site name', () => {
    expect(parseHostList('')).toEqual([])
    expect(parseHostList('  ,  ')).toEqual([])
    expect(parseHostList('a.example nope!')).toEqual([])
  })
})

describe('addHost', () => {
  it('appends new sites, in the order typed', () => {
    expect(addHost(['a.example'], 'https://B.example/x c.example')).toEqual({ kind: 'added', hosts: ['a.example', 'b.example', 'c.example'] })
  })

  it('adds only what is not listed', () => {
    expect(addHost(['a.example'], 'a.example b.example')).toEqual({ kind: 'added', hosts: ['a.example', 'b.example'] })
  })

  it('says nothing and changes nothing for a site already listed, even when the list is full', () => {
    const full = Array.from({ length: MAX_HOSTS }, (_, n) => `h${String(n)}.example`)

    expect(addHost(['a.example'], 'A.example')).toEqual({ kind: 'duplicate' })
    expect(addHost(full, 'h7.example')).toEqual({ kind: 'duplicate' })
  })

  it('refuses text that is not a site name', () => {
    expect(addHost([], 'not a site!')).toEqual({ kind: 'invalid' })
    expect(addHost(['a.example'], '')).toEqual({ kind: 'invalid' })
  })

  it('refuses what would pass the most sites the setting holds', () => {
    const almost = Array.from({ length: MAX_HOSTS - 1 }, (_, n) => `h${String(n)}.example`)

    expect(addHost(almost, 'x.example')).toMatchObject({ kind: 'added' })
    expect(addHost(almost, 'x.example y.example')).toEqual({ kind: 'full' })
  })
})

describe('removeHost', () => {
  it('drops the site at a position and keeps the order of the rest', () => {
    expect(removeHost(['a.example', 'b.example', 'c.example'], 1)).toEqual(['a.example', 'c.example'])
  })
})
