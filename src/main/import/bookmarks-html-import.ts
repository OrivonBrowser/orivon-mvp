// A bookmarks file in the Netscape format, which every browser exports: `<DT><H3>` opens a folder, its `<DL>`
// holds the contents, `<DT><A HREF>` is a page. Pure: the text in, the tree out. The format is not valid
// HTML (tags are never closed), so this reads the tags in order rather than building a document, and never
// runs or fetches anything in the file.
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'
import { ImportError, MAX_IMPORT_BYTES } from './import-types.js'
import type { SourceBookmarks } from './import-types.js'
import { clipTitle, NodeBudget, tooDeep } from './source-tree.js'

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Decodes the entities a bookmarks file uses; one it does not know stays as written. */
export function decodeEntities (text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
// A tag's attributes stop at the next `<` unless quoted, so a file of unclosed tags is read in one pass.
const TAG = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g

function attributesOf (source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(ATTRIBUTE)) found.set((match[1] ?? '').toUpperCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''))
  return found
}

/** ADD_DATE is in seconds. */
function addedOf (attributes: Map<string, string>): number | undefined {
  const seconds = Number(attributes.get('ADD_DATE'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

const textOf = (html: string): string => clipTitle(decodeEntities(html.replace(/<[^>]*>/g, '').trim()))

type Role = 'plain' | 'bar' | 'unfiled' | 'folder'

interface Frame {
  readonly role: Role
  readonly title: string
  readonly added: number | undefined
  /** Where the level's contents go: its own list, or, for a level that is not a folder of its own, the list above. */
  readonly items: BookmarkTreeInput[]
  /** Whether the level is a folder of its own, which counts towards the depth limit. */
  readonly built: boolean
}

/** The bar's items, and everything else. Throws `format` for text with no bookmarks in it. */
export function parseBookmarksHtml (text: string): SourceBookmarks {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError('format')
  const lower = text.toLowerCase()
  const budget = new NodeBudget()
  const other: BookmarkTreeInput[] = []
  const bar: BookmarkTreeInput[] = []
  const stack: Frame[] = [{ role: 'plain', title: '', added: undefined, items: other, built: false }]
  let pending: { title: string, role: Role, added: number | undefined } | null = null
  let pages = 0
  // Once a closing tag is not found, none is found further on either: searching again would make a file of unclosed tags quadratic.
  let headingsClose = true
  let linksClose = true

  const top = (): Frame => stack[stack.length - 1] as Frame

  const closeLevel = (): void => {
    const frame = stack.pop() as Frame
    const into = top()
    if (frame.role === 'bar') bar.push(...frame.items)
    else if (frame.role === 'unfiled' || (frame.role === 'folder' && frame.built && stack.every((level) => level.role === 'plain') && frame.title === 'Other bookmarks')) into.items.push(...frame.items)
    else if (frame.role === 'folder' && frame.built && budget.take()) {
      into.items.push({ kind: 'folder', title: frame.title, ...(frame.added === undefined ? {} : { added: frame.added }), children: frame.items })
    }
  }

  TAG.lastIndex = 0
  for (let match = TAG.exec(text); match !== null; match = TAG.exec(text)) {
    const closing = match[1] === '/'
    const name = (match[2] ?? '').toLowerCase()
    const after = TAG.lastIndex
    if (name === 'dl' && closing) {
      if (stack.length > 1) closeLevel()
    } else if (name === 'dl') {
      if (pending === null) {
        stack.push({ role: 'plain', title: '', added: undefined, items: top().items, built: false })
      } else {
        const builtAbove = stack.filter((frame) => frame.built).length
        const own = pending.role !== 'folder' || !tooDeep(builtAbove + 1)
        stack.push({ role: pending.role, title: pending.title, added: pending.added, items: own ? [] : top().items, built: pending.role === 'folder' && own })
      }
      pending = null
    } else if (name === 'dt' && !closing) {
      pending = null
    } else if (name === 'h3' && !closing) {
      const end = headingsClose ? lower.indexOf('</h3', after) : -1
      if (end === -1) headingsClose = false
      const attributes = attributesOf(match[3] ?? '')
      const role: Role = attributes.get('PERSONAL_TOOLBAR_FOLDER') === 'true' ? 'bar' : attributes.get('UNFILED_BOOKMARKS_FOLDER') === 'true' ? 'unfiled' : 'folder'
      pending = { title: textOf(text.slice(after, end === -1 ? after : end)), role, added: addedOf(attributes) }
      if (end !== -1) TAG.lastIndex = end
    } else if (name === 'a' && !closing) {
      const end = linksClose ? lower.indexOf('</a', after) : -1
      if (end === -1) linksClose = false
      const attributes = attributesOf(match[3] ?? '')
      const href = attributes.get('HREF')
      if (href !== undefined) {
        pages += 1
        if (budget.take()) {
          const added = addedOf(attributes)
          top().items.push({ kind: 'url', title: textOf(text.slice(after, end === -1 ? after : end)), url: href, ...(added === undefined ? {} : { added }) })
        }
      }
      if (end !== -1) TAG.lastIndex = end
    }
  }
  while (stack.length > 1) closeLevel()
  if (pages === 0 && !lower.includes('netscape-bookmark-file')) throw new ImportError('format')
  return { bar, other }
}
