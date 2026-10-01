// The words on a row: the address without what a person does not need to read, and a title split around the text a
// search matched. Pure.

/** `https://www.example.com/a/` reads as `www.example.com/a`: no scheme for the web's own, none for a trailing slash. */
export function addressLabel (url: string): string {
  const bare = url.replace(/^https?:\/\//i, '')
  return bare.endsWith('/') && bare.indexOf('/') === bare.length - 1 ? bare.slice(0, -1) : bare
}

export interface Piece {
  readonly text: string
  readonly match: boolean
}

/** `text` in pieces, the parts equal to `needle` (case-insensitively, all of them) flagged. No needle: one plain piece. */
export function splitMatches (text: string, needle: string): Piece[] {
  const query = needle.trim().toLowerCase()
  if (query === '' || text === '') return [{ text, match: false }]
  const lower = text.toLowerCase()
  const out: Piece[] = []
  let from = 0
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    if (at > from) out.push({ text: text.slice(from, at), match: false })
    out.push({ text: text.slice(at, at + query.length), match: true })
    from = at + query.length
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false })
  return out.length === 0 ? [{ text, match: false }] : out
}
