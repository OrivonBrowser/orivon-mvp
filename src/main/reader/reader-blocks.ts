// The article the reader page shows: a small, closed set of block types made of text. What the page's
// own scripts produced is untrusted, so only this validator's output ever reaches the reader page, which
// draws it as text nodes and a fixed element set. Pure: no Electron, no Node.

export type Inline = string | { t: 'a', i: number, href: string, c: Inline[] } | { t: 'em' | 'strong' | 'code', c: Inline[] }

export type Block =
  | { t: 'p' | 'h2' | 'h3' | 'quote', c: Inline[] }
  | { t: 'pre', text: string }
  | { t: 'list', ordered: boolean, items: Inline[][] }
  | { t: 'img', src: string, alt: string, caption?: string }
  | { t: 'table', rows: string[][] }
  | { t: 'hr' }

export interface Article {
  title: string
  byline: string
  site: string
  url: string
  lang: string
  words: number
  blocks: Block[]
}

export const LIMITS = {
  blocks: 4000,
  textBytes: 2_000_000,
  title: 300,
  byline: 200,
  site: 120,
  images: 40,
  tableRows: 60,
  tableColumns: 12,
  cell: 400,
  listItems: 500,
  inlineDepth: 6,
  alt: 300,
  url: 2048
} as const

/** How far into a too-deeply nested run its text is still gathered; past it the text is dropped. */
const PLAIN_DEPTH = 64
const INLINE_TAGS = new Set(['em', 'strong', 'code'])
const TEXT_BLOCKS = new Set(['p', 'h2', 'h3', 'quote'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Control characters other than a line break and a tab, which no text needs and a terminal-minded reader should not see. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function clean (value: unknown): string {
  return typeof value === 'string' ? value.replace(CONTROL, '') : ''
}

/** An http(s) address with no login in it, resolved against the page; anything else is null. */
export function webUrl (value: unknown, base: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.url) return null
  let url: URL
  try {
    url = new URL(value.trim(), base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  return url.href
}

/** How much text is left to take, shared by every block of one article. */
class Budget {
  left = LIMITS.textBytes
  images = 0
  links = 0

  take (text: string): string {
    if (text.length > this.left) text = text.slice(0, Math.max(0, this.left))
    this.left -= text.length
    return text
  }
}

function plainText (raw: unknown, depth: number): string {
  if (typeof raw === 'string') return clean(raw)
  if (!isRecord(raw) || depth > PLAIN_DEPTH || !Array.isArray(raw['c'])) return ''
  return raw['c'].map((child: unknown) => plainText(child, depth + 1)).join('')
}

function inlines (raw: unknown, base: string, depth: number, budget: Budget): Inline[] {
  if (!Array.isArray(raw)) return []
  const out: Inline[] = []
  const push = (item: Inline): void => {
    const last = out[out.length - 1]
    if (typeof item === 'string' && typeof last === 'string') out[out.length - 1] = last + item
    else out.push(item)
  }
  for (const child of raw) {
    if (budget.left <= 0) break
    if (typeof child === 'string') {
      const text = budget.take(clean(child))
      if (text !== '') push(text)
      continue
    }
    if (!isRecord(child) || typeof child['t'] !== 'string') continue
    const tag = child['t']
    if (tag === 'a') {
      const href = webUrl(child['href'], base)
      // A link the reader cannot follow stays readable: only the address is dropped.
      if (href === null || depth >= LIMITS.inlineDepth) {
        const text = budget.take(plainText(child, depth))
        if (text !== '') push(text)
        continue
      }
      const inner = inlines(child['c'], base, depth + 1, budget)
      if (inner.length > 0) push({ t: 'a', i: budget.links++, href, c: inner })
    } else if (INLINE_TAGS.has(tag)) {
      if (depth >= LIMITS.inlineDepth) {
        const text = budget.take(plainText(child, depth))
        if (text !== '') push(text)
        continue
      }
      const inner = inlines(child['c'], base, depth + 1, budget)
      if (inner.length > 0) push({ t: tag as 'em' | 'strong' | 'code', c: inner })
    }
  }
  return out
}

function hasText (items: readonly Inline[]): boolean {
  return items.some((item) => typeof item === 'string' ? item.trim() !== '' : hasText(item.c))
}

function cell (value: unknown, budget: Budget): string {
  return budget.take(clean(value).replace(/\s+/g, ' ').trim().slice(0, LIMITS.cell))
}

function block (raw: unknown, base: string, budget: Budget): Block | null {
  if (!isRecord(raw) || typeof raw['t'] !== 'string') return null
  const type = raw['t']
  if (TEXT_BLOCKS.has(type)) {
    const c = inlines(raw['c'], base, 0, budget)
    return hasText(c) ? { t: type as 'p' | 'h2' | 'h3' | 'quote', c } : null
  }
  switch (type) {
    case 'pre': {
      const text = budget.take(clean(raw['text']))
      return text.trim() === '' ? null : { t: 'pre', text }
    }
    case 'list': {
      if (!Array.isArray(raw['items'])) return null
      const items = raw['items'].slice(0, LIMITS.listItems).map((item: unknown) => inlines(item, base, 0, budget)).filter(hasText)
      return items.length === 0 ? null : { t: 'list', ordered: raw['ordered'] === true, items }
    }
    case 'img': {
      const src = webUrl(raw['src'], base)
      if (src === null || budget.images >= LIMITS.images) return null
      budget.images += 1
      const caption = cell(raw['caption'], budget)
      return { t: 'img', src, alt: clean(raw['alt']).slice(0, LIMITS.alt), ...(caption === '' ? {} : { caption }) }
    }
    case 'table': {
      if (!Array.isArray(raw['rows'])) return null
      const rows = raw['rows'].slice(0, LIMITS.tableRows)
        .map((row: unknown) => Array.isArray(row) ? row.slice(0, LIMITS.tableColumns).map((value: unknown) => cell(value, budget)) : [])
        .filter((row) => row.some((value) => value !== ''))
      return rows.length === 0 ? null : { t: 'table', rows }
    }
    case 'hr': return { t: 'hr' }
    default: return null
  }
}

function countWords (text: string): number {
  const found = text.match(/\S+/g)
  return found === null ? 0 : found.length
}

function textOf (blocks: readonly Block[]): string {
  const parts: string[] = []
  const walk = (items: readonly Inline[]): void => {
    for (const item of items) {
      if (typeof item === 'string') parts.push(item)
      else walk(item.c)
    }
  }
  for (const entry of blocks) {
    if (entry.t === 'pre') parts.push(entry.text)
    else if ('c' in entry) walk(entry.c)
    else if (entry.t === 'list') for (const item of entry.items) walk(item)
  }
  return parts.join(' ')
}

/** A document title usually ends in the site's name, which the page already shows as the source. */
function withoutSite (title: string, site: string): string {
  if (site === '') return title
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = title.replace(new RegExp(`\\s*[-|\u2013\u2014:\u00b7]\\s*${escaped}$`, 'i'), '').trim()
  return stripped === '' ? title : stripped
}

/** The first paragraph that only says who wrote the piece, which the meta line already shows. */
function repeatsByline (text: string, byline: string): boolean {
  const said = text.replace(/\s+/g, ' ').trim().toLowerCase()
  const wanted = byline.toLowerCase()
  return said === wanted || said === `by ${wanted}`
}

/** Checks an extraction result against the model and returns the article it describes, or null when it is not one
 * (nothing readable, or not even an object). Everything out of shape is dropped, never repaired. */
export function validateArticle (raw: unknown, pageUrl: string): Article | null {
  if (!isRecord(raw) || !Array.isArray(raw['blocks'])) return null
  const base = webUrl(pageUrl, 'http://invalid.invalid/')
  if (base === null) return null
  const budget = new Budget()
  const blocks: Block[] = []
  for (const entry of raw['blocks'].slice(0, LIMITS.blocks)) {
    if (budget.left <= 0) break
    const accepted = block(entry, base, budget)
    if (accepted !== null) blocks.push(accepted)
  }
  if (blocks.length === 0) return null
  const lang = clean(raw['lang'])
  const byline = clean(raw['byline']).replace(/\s+/g, ' ').trim().slice(0, LIMITS.byline)
  const site = clean(raw['site']).replace(/\s+/g, ' ').trim().slice(0, LIMITS.site)
  const first = blocks.findIndex((entry) => entry.t === 'p')
  if (byline !== '' && first >= 0 && blocks.length > 1 && repeatsByline(textOf([blocks[first] as Block]), byline)) blocks.splice(first, 1)
  return {
    title: withoutSite(clean(raw['title']).replace(/\s+/g, ' ').trim(), site).slice(0, LIMITS.title),
    byline,
    site,
    url: base,
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : '',
    words: countWords(textOf(blocks)),
    blocks
  }
}

/** The addresses of an article's links, in the order the page draws them: a link's `i` is its place in this list. */
export function linkTable (article: Pick<Article, 'blocks'>): string[] {
  const links: string[] = []
  const walk = (items: readonly Inline[]): void => {
    for (const item of items) {
      if (typeof item === 'string') continue
      if (item.t === 'a') links[item.i] = item.href
      walk(item.c)
    }
  }
  for (const entry of article.blocks) {
    if ('c' in entry) walk(entry.c)
    else if (entry.t === 'list') for (const item of entry.items) walk(item)
  }
  return links
}

/** The image blocks, in order, with their place among the blocks: what main fetches for the page. */
export function imageSlots (article: Pick<Article, 'blocks'>): Array<{ at: number, src: string }> {
  const slots: Array<{ at: number, src: string }> = []
  article.blocks.forEach((entry, at) => { if (entry.t === 'img') slots.push({ at, src: entry.src }) })
  return slots
}
