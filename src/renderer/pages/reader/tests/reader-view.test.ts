import { describe, expect, it } from 'vitest'
import type { Block } from '../../../../main/reader/reader-blocks.js'
import { SIZES, WIDTHS, blockNodes, hostOf, metaParts, readingMinutes, speechUnits, stepSize } from '../view.js'
import type { VNode } from '../view.js'

const tags = (nodes: readonly VNode[]): string[] => nodes.map((node) => node.tag)

describe('reading time and the meta line', () => {
  it('rounds up at 220 words a minute and never says less than one', () => {
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(220)).toBe(1)
    expect(readingMinutes(221)).toBe(2)
    expect(readingMinutes(1760)).toBe(8)
  })

  it('always names the source host, and the byline when there is one', () => {
    expect(metaParts({ byline: 'Ada', url: 'https://www.example.com/x', words: 1760 })).toEqual(['Ada', 'example.com', '8 min read'])
    expect(metaParts({ byline: '', url: 'https://blog.example.org/x', words: 10 })).toEqual(['blog.example.org', '1 min read'])
    expect(hostOf('nonsense')).toBe('')
  })
})

describe('size steps', () => {
  it('moves through the six sizes and stays at the ends', () => {
    expect(SIZES).toEqual([14, 16, 18, 20, 24, 28])
    expect(stepSize(18, 1)).toBe(20)
    expect(stepSize(18, -1)).toBe(16)
    expect(stepSize(14, -1)).toBe(14)
    expect(stepSize(28, 1)).toBe(28)
    expect(stepSize(22, 1)).toBe(28)
    expect(stepSize(99, -1)).toBe(24)
  })

  it('has the three widths', () => {
    expect(WIDTHS).toEqual({ narrow: 30, medium: 36, wide: 44 })
  })
})

describe('blockNodes', () => {
  const blocks: Block[] = [
    { t: 'h2', c: ['Head'] },
    { t: 'p', c: ['Text ', { t: 'em', c: ['em'] }, ' ', { t: 'a', i: 4, href: 'https://a.test/x', c: ['link'] }] },
    { t: 'quote', c: ['Said'] },
    { t: 'pre', text: 'code' },
    { t: 'list', ordered: true, items: [['one'], ['two']] },
    { t: 'img', src: 'https://i.test/a.png', alt: 'Alt', caption: 'Cap' },
    { t: 'table', rows: [['a', 'b']] },
    { t: 'hr' }
  ]

  it('maps each block to one fixed element, in order, and marks it with its place', () => {
    const nodes = blockNodes(blocks, new Map())
    expect(tags(nodes)).toEqual(['h2', 'p', 'blockquote', 'pre', 'ol', 'div', 'hr'])
    expect(nodes.map((node) => node.attrs?.['data-block'])).toEqual(['0', '1', '2', '3', '4', '6', '7'])
  })

  it('draws a link as an element with no address: its destination is a tooltip and its place a number', () => {
    const link = blockNodes(blocks, new Map())[1]?.children?.find((child) => child.tag === 'a')
    expect(link).toMatchObject({ tag: 'a', link: 4, attrs: { role: 'link', tabindex: '0', title: 'https://a.test/x' } })
    expect(link?.attrs).not.toHaveProperty('href')
  })

  it('draws a picture only once main has copied it, and only from a data URL', () => {
    const data = 'data:image/png;base64,AAAA'
    const drawn = blockNodes(blocks, new Map([[5, data]]))
    expect(tags(drawn)).toContain('figure')
    const figure = drawn.find((node) => node.tag === 'figure')
    expect(figure?.children?.[0]).toEqual({ tag: 'img', attrs: { src: data, alt: 'Alt' } })
    expect(figure?.children?.[1]?.tag).toBe('figcaption')
    for (const bad of ['https://i.test/a.png', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/png,AAAA']) {
      expect(tags(blockNodes(blocks, new Map([[5, bad]])))).not.toContain('figure')
    }
  })

  it('produces only the fixed tags and the fixed attributes, whatever the text says', () => {
    const hostile: Block[] = [
      { t: 'p', c: ['<img src=x onerror=alert(1)>', { t: 'strong', c: ['<script>x</script>'] }] },
      { t: 'pre', text: '<iframe src="javascript:alert(1)"></iframe>' }
    ]
    const seen = new Set<string>()
    const attrs = new Set<string>()
    const visit = (node: VNode): void => {
      seen.add(node.tag)
      for (const name of Object.keys(node.attrs ?? {})) attrs.add(name)
      node.children?.forEach(visit)
    }
    blockNodes(hostile, new Map()).forEach(visit)
    expect([...seen].sort()).toEqual(['#text', 'code', 'p', 'pre', 'strong'])
    expect([...attrs].sort()).toEqual(['data-block', 'tabindex'])
  })
})

describe('speechUnits', () => {
  it('gives one unit per paragraph, heading, quote and list item, with the block each is in', () => {
    const units = speechUnits([
      { t: 'h2', c: ['Head'] },
      { t: 'pre', text: 'skipped' },
      { t: 'p', c: ['One  ', { t: 'em', c: ['two'] }] },
      { t: 'list', ordered: false, items: [['a'], ['b']] },
      { t: 'img', src: 'https://i.test/a.png', alt: '' },
      { t: 'quote', c: ['  '] }
    ])
    expect(units).toEqual([{ at: 0, text: 'Head' }, { at: 2, text: 'One two' }, { at: 3, text: 'a' }, { at: 3, text: 'b' }])
  })
})
