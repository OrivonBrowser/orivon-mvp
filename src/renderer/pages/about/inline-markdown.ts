// The little markdown a CHANGELOG line uses: **bold**, `code` and [text](address). Cut into segments the
// view turns into elements, so no text is ever read as HTML. A link keeps its words and drops its address:
// an address in a changelog is relative to the repository, and the page has nothing to open it with.

export interface Segment {
  readonly kind: 'text' | 'bold' | 'code'
  readonly text: string
}

const TOKEN = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g

export function inlineSegments (source: string): Segment[] {
  const segments: Segment[] = []
  let from = 0
  for (const match of source.matchAll(TOKEN)) {
    if (match.index > from) segments.push({ kind: 'text', text: source.slice(from, match.index) })
    if (match[1] !== undefined) segments.push({ kind: 'bold', text: match[1] })
    else if (match[2] !== undefined) segments.push({ kind: 'code', text: match[2] })
    else segments.push({ kind: 'text', text: match[3] ?? '' })
    from = match.index + match[0].length
  }
  if (from < source.length) segments.push({ kind: 'text', text: source.slice(from) })
  return segments
}
