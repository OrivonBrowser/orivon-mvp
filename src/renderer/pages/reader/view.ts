// What the reader page draws, as plain data: the article's blocks become a tree of nodes that render.ts
// turns into elements. Nothing here touches the DOM, and nothing but the fixed set of tags below is ever
// produced, so what an article contains cannot choose an element, an attribute or a style.
import type { Article, Block, Inline } from '../../../main/reader/reader-blocks.js'

export interface VNode {
  readonly tag: string
  readonly text?: string
  readonly attrs?: Readonly<Record<string, string>>
  readonly children?: readonly VNode[]
  /** An article link's place in its own link table: what the page sends main to open it. */
  readonly link?: number
}

export const SIZES = [14, 16, 18, 20, 24, 28] as const
export const WIDTHS = { narrow: 560, medium: 680, wide: 820 } as const
export const WORDS_PER_MINUTE = 220

/** The next size up or down the list, staying at its ends. An unknown size steps from the nearest one. */
export function stepSize (current: number, direction: 1 | -1): number {
  const at = SIZES.findIndex((size) => size >= current)
  const index = at === -1 ? SIZES.length - 1 : at
  const next = Math.min(SIZES.length - 1, Math.max(0, index + direction))
  return SIZES[next] as number
}

export function readingMinutes (words: number): number {
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE))
}

export function hostOf (url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The line under the title: who wrote it, where it is from, and how long it takes. The host is always there, because it is the one fact a page cannot dress up. */
export function metaParts (article: Pick<Article, 'byline' | 'url' | 'words'>): string[] {
  const parts: string[] = []
  if (article.byline !== '') parts.push(article.byline)
  const host = hostOf(article.url)
  if (host !== '') parts.push(host)
  parts.push(`${String(readingMinutes(article.words))} min read`)
  return parts
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/

const text = (value: string): VNode => ({ tag: '#text', text: value })

function inlineNodes (items: readonly Inline[]): VNode[] {
  return items.map((item): VNode => {
    if (typeof item === 'string') return text(item)
    const children = inlineNodes(item.c)
    if (item.t === 'a') return { tag: 'a', attrs: { role: 'link', tabindex: '0', title: item.href }, link: item.i, children }
    return { tag: item.t, children }
  })
}

/** The nodes for one block, or none: a picture main has not copied yet is not drawn. */
function blockNode (block: Block, at: number, images: ReadonlyMap<number, string>): VNode[] {
  const mark = { 'data-block': String(at) }
  switch (block.t) {
    case 'p': return [{ tag: 'p', attrs: mark, children: inlineNodes(block.c) }]
    case 'h2': case 'h3': return [{ tag: block.t, attrs: mark, children: inlineNodes(block.c) }]
    case 'quote': return [{ tag: 'blockquote', attrs: mark, children: inlineNodes(block.c) }]
    case 'pre': return [{ tag: 'pre', attrs: { ...mark, tabindex: '0' }, children: [{ tag: 'code', children: [text(block.text)] }] }]
    case 'list': return [{
      tag: block.ordered ? 'ol' : 'ul',
      attrs: mark,
      children: block.items.map((item): VNode => ({ tag: 'li', children: inlineNodes(item) }))
    }]
    case 'img': {
      const src = images.get(at)
      if (src === undefined || !DATA_IMAGE.test(src)) return []
      const caption = block.caption ?? ''
      return [{
        tag: 'figure',
        attrs: mark,
        children: [
          { tag: 'img', attrs: { src, alt: block.alt } },
          ...(caption === '' ? [] : [{ tag: 'figcaption', children: [text(caption)] }])
        ]
      }]
    }
    case 'table': return [{
      tag: 'div',
      attrs: { ...mark, class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table' },
      children: [{
        tag: 'table',
        children: [{ tag: 'tbody', children: block.rows.map((row): VNode => ({ tag: 'tr', children: row.map((cell): VNode => ({ tag: 'td', children: [text(cell)] })) })) }]
      }]
    }]
    case 'hr': return [{ tag: 'hr', attrs: mark }]
  }
}

export function blockNodes (blocks: readonly Block[], images: ReadonlyMap<number, string>): VNode[] {
  return blocks.flatMap((block, at) => blockNode(block, at, images))
}

function plain (items: readonly Inline[]): string {
  return items.map((item) => typeof item === 'string' ? item : plain(item.c)).join('')
}

export interface SpeechUnit {
  /** The block this text is from, to mark and scroll to while it is read. */
  readonly at: number
  readonly text: string
}

/** What read aloud says, one unit per paragraph-like block: headings, paragraphs, quotes and each list item. */
export function speechUnits (blocks: readonly Block[]): SpeechUnit[] {
  const units: SpeechUnit[] = []
  blocks.forEach((block, at) => {
    switch (block.t) {
      case 'p': case 'h2': case 'h3': case 'quote': units.push({ at, text: plain(block.c) }); break
      case 'list': for (const item of block.items) units.push({ at, text: plain(item) }); break
      default: break
    }
  })
  return units.map((unit) => ({ at: unit.at, text: unit.text.replace(/\s+/g, ' ').trim() })).filter((unit) => unit.text !== '')
}
