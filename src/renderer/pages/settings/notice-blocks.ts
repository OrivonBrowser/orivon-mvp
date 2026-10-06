// The privacy notice as a list of plain blocks, so the page draws it with text nodes and never inserts
// the Markdown file as HTML. Only the few forms the notice uses are read: headings, paragraphs, bullet
// lists and tables. Emphasis marks, code ticks and link addresses are dropped; the words stay.
export type NoticeBlock =
  | { readonly kind: 'heading', readonly level: 1 | 2 | 3, readonly text: string }
  | { readonly kind: 'paragraph', readonly text: string }
  | { readonly kind: 'list', readonly items: readonly string[] }
  | { readonly kind: 'table', readonly header: readonly string[], readonly rows: ReadonlyArray<readonly string[]> }

function plain (text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:])/g, '$1$2')
    .trim()
}

function cells (line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => plain(cell))
}

const isRule = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim())

export function noticeBlocks (markdown: string): NoticeBlock[] {
  const blocks: NoticeBlock[] = []
  const lines = markdown.split('\n')
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: plain(paragraph.join(' ')) })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length as 1 | 2 | 3, text: plain(heading[2] ?? '') })
    } else if (line.trimStart().startsWith('|')) {
      flush()
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
        if (!isRule(lines[index] ?? '')) rows.push(cells(lines[index] ?? ''))
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'table', header: rows[0] ?? [], rows: rows.slice(1) })
    } else if (/^\s*[-*]\s+/.test(line)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push(plain((lines[index] ?? '').replace(/^\s*[-*]\s+/, '')))
        index += 1
      }
      index -= 1
      blocks.push({ kind: 'list', items })
    } else if (line.trim() === '') {
      flush()
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return blocks
}
