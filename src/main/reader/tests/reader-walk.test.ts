import { describe, expect, it } from 'vitest'
import { walkReaderContent } from '../reader-walk.js'
import type { WalkNode } from '../reader-walk.js'

type Spec = string | { tag: string, attrs?: Record<string, string>, kids?: Spec[] }

function build (spec: Spec): WalkNode {
  if (typeof spec === 'string') return { nodeType: 3, nodeName: '#text', textContent: spec, childNodes: [], getAttribute: () => null }
  const kids = (spec.kids ?? []).map(build)
  const text = (spec.kids ?? []).map((kid) => typeof kid === 'string' ? kid : '').join('')
  return {
    nodeType: 1,
    nodeName: spec.tag.toUpperCase(),
    textContent: kids.map((kid) => kid.textContent).join('') || text,
    childNodes: kids,
    getAttribute: (name) => spec.attrs?.[name] ?? null
  }
}

const walk = (...kids: Spec[]) => walkReaderContent(build({ tag: 'body', kids }), 4000)

describe('walkReaderContent', () => {
  it('turns paragraphs, headings and inline marks into blocks', () => {
    const blocks = walk(
      { tag: 'h1', kids: ['Title'] },
      { tag: 'p', kids: ['Hello ', { tag: 'b', kids: ['bold'] }, ' and ', { tag: 'a', attrs: { href: '/x' }, kids: ['a link'] }, '.'] },
      { tag: 'h4', kids: ['Small'] }
    )
    expect(blocks).toEqual([
      { t: 'h2', c: ['Title'] },
      { t: 'p', c: ['Hello ', { t: 'strong', c: ['bold'] }, ' and ', { t: 'a', href: '/x', c: ['a link'] }, '.'] },
      { t: 'h3', c: ['Small'] }
    ])
  })

  it('gathers loose text and inline elements between blocks into a paragraph', () => {
    const blocks = walk({ tag: 'div', kids: ['Loose ', { tag: 'em', kids: ['text'] }, { tag: 'p', kids: ['Para'] }, 'after'] })
    expect(blocks.map((block) => block.t)).toEqual(['p', 'p', 'p'])
  })

  it('never reads scripts, styles, forms or frames', () => {
    const blocks = walk(
      { tag: 'script', kids: ['alert(1)'] },
      { tag: 'p', kids: ['ok', { tag: 'script', kids: ['evil()'] }, { tag: 'style', kids: ['p{}'] }] },
      { tag: 'iframe' },
      { tag: 'form', kids: [{ tag: 'p', kids: ['field'] }] }
    )
    expect(JSON.stringify(blocks)).not.toMatch(/alert|evil|field/)
  })

  it('reads a list with a nested list into flat items', () => {
    const blocks = walk({ tag: 'ol', kids: [
      { tag: 'li', kids: ['one', { tag: 'ul', kids: [{ tag: 'li', kids: ['inner'] }] }] },
      { tag: 'li', kids: ['two'] }
    ] })
    expect(blocks).toEqual([{ t: 'list', ordered: true, items: [['one'], ['inner'], ['two']] }])
  })

  it('reads a preformatted block, a quote, a rule, a table and a figure', () => {
    const blocks = walk(
      { tag: 'pre', kids: ['a\n  b'] },
      { tag: 'blockquote', kids: [{ tag: 'p', kids: ['said'] }] },
      { tag: 'hr' },
      { tag: 'table', kids: [{ tag: 'tbody', kids: [{ tag: 'tr', kids: [{ tag: 'th', kids: ['H'] }, { tag: 'td', kids: [' v '] }] }] }] },
      { tag: 'figure', kids: [{ tag: 'img', attrs: { src: 'a.png', alt: 'alt' } }, { tag: 'figcaption', kids: ['A  caption'] }] }
    )
    expect(blocks).toEqual([
      { t: 'pre', text: 'a\n  b' },
      { t: 'quote', c: ['said'] },
      { t: 'hr' },
      { t: 'table', rows: [['H', 'v']] },
      { t: 'img', src: 'a.png', alt: 'alt', caption: 'A caption' }
    ])
  })

  it('stops at the limit', () => {
    const many = Array.from({ length: 50 }, () => ({ tag: 'p', kids: ['x'] }))
    expect(walkReaderContent(build({ tag: 'body', kids: many }), 10)).toHaveLength(10)
  })

  it('stays self-contained, so its source can be sent to a page', () => {
    const source = walkReaderContent.toString()
    expect(source).not.toContain('__name')
    const run = new Function(`return (${source})`)() as typeof walkReaderContent
    expect(run(build({ tag: 'body', kids: [{ tag: 'p', kids: ['hi'] }] }), 5)).toEqual([{ t: 'p', c: ['hi'] }])
  })
})
