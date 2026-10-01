import { describe, expect, it } from 'vitest'
import { LIMITS, imageSlots, linkTable, validateArticle, webUrl } from '../reader-blocks.js'
import type { Article } from '../reader-blocks.js'

const PAGE = 'https://example.com/posts/one'
const article = (blocks: unknown[], extra: Record<string, unknown> = {}): unknown => ({ title: 'T', byline: '', site: '', lang: 'en', blocks, ...extra })
const valid = (blocks: unknown[], extra: Record<string, unknown> = {}): Article => {
  const result = validateArticle(article(blocks, extra), PAGE)
  if (result === null) throw new Error('expected an article')
  return result
}

describe('validateArticle', () => {
  it('keeps the fixed block types and drops what it does not know', () => {
    const result = valid([
      { t: 'p', c: ['Hello ', { t: 'strong', c: ['world'] }] },
      { t: 'script', c: ['alert(1)'] },
      { t: 'h2', c: ['Heading'] },
      { t: 'pre', text: 'let a = 1' },
      { t: 'hr' },
      'not a block',
      null
    ])
    expect(result.blocks.map((block) => block.t)).toEqual(['p', 'h2', 'pre', 'hr'])
  })

  it('refuses what is not an article', () => {
    for (const raw of [null, 'x', 4, [], {}, { blocks: 'x' }, { blocks: [] }, { blocks: [{ t: 'script' }] }]) {
      expect(validateArticle(raw, PAGE)).toBeNull()
    }
    expect(validateArticle(article([{ t: 'p', c: ['x'] }]), 'javascript:alert(1)')).toBeNull()
  })

  it('drops an empty block and a block of blanks', () => {
    expect(valid([{ t: 'p', c: ['  '] }, { t: 'p', c: [] }, { t: 'p', c: ['x'] }]).blocks).toHaveLength(1)
  })

  it('keeps an http link, resolves a relative one against the page, and drops anything else but its text', () => {
    const result = valid([{ t: 'p', c: [
      { t: 'a', href: 'https://a.test/x', c: ['one'] },
      { t: 'a', href: '/two', c: ['two'] },
      { t: 'a', href: 'javascript:alert(1)', c: ['three'] },
      { t: 'a', href: 'data:text/html,hi', c: ['four'] },
      { t: 'a', href: 'https://user:pw@a.test/', c: ['five'] }
    ] }])
    expect(linkTable(result)).toEqual(['https://a.test/x', 'https://example.com/two'])
    expect(JSON.stringify(result)).not.toContain('javascript')
    expect(JSON.stringify(result.blocks[0])).toContain('threefourfive')
  })

  it('numbers links in the order the table lists them, across lists and quotes', () => {
    const result = valid([
      { t: 'quote', c: [{ t: 'a', href: 'https://q.test/', c: ['q'] }] },
      { t: 'list', ordered: true, items: [[{ t: 'a', href: 'https://l1.test/', c: ['l1'] }], [{ t: 'a', href: 'https://l2.test/', c: ['l2'] }]] }
    ])
    expect(linkTable(result)).toEqual(['https://q.test/', 'https://l1.test/', 'https://l2.test/'])
  })

  it('keeps only http(s) pictures, counts them, and caps them', () => {
    const blocks = [
      { t: 'img', src: 'https://i.test/a.png', alt: 'a', caption: 'cap' },
      { t: 'img', src: 'data:image/png;base64,AAAA', alt: '' },
      { t: 'img', src: 'file:///etc/passwd', alt: '' },
      { t: 'img', src: '/b.jpg', alt: 'b' }
    ]
    const result = valid(blocks)
    expect(imageSlots(result)).toEqual([{ at: 0, src: 'https://i.test/a.png' }, { at: 1, src: 'https://example.com/b.jpg' }])
    const many = valid(Array.from({ length: LIMITS.images + 10 }, (_, i) => ({ t: 'img', src: `https://i.test/${String(i)}.png`, alt: '' })))
    expect(many.blocks).toHaveLength(LIMITS.images)
  })

  it('stops at the block cap and at the text budget', () => {
    expect(valid(Array.from({ length: LIMITS.blocks + 50 }, () => ({ t: 'p', c: ['x'] }))).blocks).toHaveLength(LIMITS.blocks)
    const big = 'x'.repeat(900_000)
    const result = valid([{ t: 'p', c: [big] }, { t: 'p', c: [big] }, { t: 'p', c: [big] }, { t: 'p', c: [big] }])
    const total = result.blocks.reduce((sum, block) => sum + (block.t === 'p' ? String(block.c[0]).length : 0), 0)
    expect(total).toBeLessThanOrEqual(LIMITS.textBytes)
  })

  it('shortens a long title and cleans control characters', () => {
    const result = valid([{ t: 'p', c: ['a\u0000b\u001bc'] }], { title: 'x'.repeat(1000), byline: '  By   me ' })
    expect(result.title).toHaveLength(LIMITS.title)
    expect(result.byline).toBe('By me')
    expect(result.blocks[0]).toEqual({ t: 'p', c: ['abc'] })
  })

  it('flattens inline nesting deeper than the cap into text', () => {
    let node: unknown = 'deep'
    for (let i = 0; i < LIMITS.inlineDepth + 4; i++) node = { t: i % 2 === 0 ? 'em' : 'strong', c: [node] }
    const result = valid([{ t: 'p', c: [node] }])
    let depth = 0
    let current: unknown = (result.blocks[0] as { c: unknown[] }).c[0]
    while (typeof current === 'object' && current !== null) {
      depth += 1
      current = (current as { c: unknown[] }).c[0]
    }
    expect(depth).toBeLessThanOrEqual(LIMITS.inlineDepth)
    expect(JSON.stringify(result)).toContain('deep')
  })

  it('caps tables and list items, and keeps only text in a cell', () => {
    const rows = Array.from({ length: 100 }, () => Array.from({ length: 30 }, () => 'cell'))
    const result = valid([{ t: 'table', rows }, { t: 'list', ordered: false, items: Array.from({ length: 900 }, () => ['i']) }])
    const table = result.blocks[0] as { rows: string[][] }
    expect(table.rows).toHaveLength(LIMITS.tableRows)
    expect(table.rows[0]).toHaveLength(LIMITS.tableColumns)
    expect((result.blocks[1] as { items: unknown[] }).items).toHaveLength(LIMITS.listItems)
  })

  it('counts the words of the text it kept', () => {
    expect(valid([{ t: 'p', c: ['one two ', { t: 'em', c: ['three'] }] }, { t: 'pre', text: 'four five' }]).words).toBe(5)
  })

  it('accepts a language tag only in its plain form', () => {
    expect(valid([{ t: 'p', c: ['x'] }], { lang: 'en-GB' }).lang).toBe('en-GB')
    expect(valid([{ t: 'p', c: ['x'] }], { lang: '"><script>' }).lang).toBe('')
  })
})

describe('webUrl', () => {
  it('returns http and https addresses only', () => {
    expect(webUrl('http://a.test/x', PAGE)).toBe('http://a.test/x')
    expect(webUrl('//cdn.test/x.png', PAGE)).toBe('https://cdn.test/x.png')
    expect(webUrl('ftp://a.test/', PAGE)).toBeNull()
    expect(webUrl('', PAGE)).toBeNull()
    expect(webUrl(4, PAGE)).toBeNull()
    expect(webUrl(`https://a.test/${'x'.repeat(3000)}`, PAGE)).toBeNull()
  })
})
