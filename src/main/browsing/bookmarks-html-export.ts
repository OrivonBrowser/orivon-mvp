// The bookmarks as the Netscape bookmark file, the HTML every browser imports. Pure: the caller reads the tree and
// writes the file. Other programs parse the result as HTML, so every title and attribute is escaped.
import type { BookmarkTreeInput } from './bookmark-types.js'

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** The file's dates are whole seconds; a node with no date leaves the attribute out. */
function dateAttribute (added: number | undefined): string {
  return added !== undefined && Number.isFinite(added) && added > 0 ? ` ADD_DATE="${String(Math.floor(added / 1000))}"` : ''
}

function writeItems (items: readonly BookmarkTreeInput[], depth: number, out: string[]): void {
  const pad = '    '.repeat(depth)
  for (const item of items) {
    if (item.kind === 'folder') {
      out.push(`${pad}<DT><H3${dateAttribute(item.added)}>${escape(item.title)}</H3>`, `${pad}<DL><p>`)
      writeItems(item.children ?? [], depth + 1, out)
      out.push(`${pad}</DL><p>`)
    } else if (item.url !== undefined) {
      const icon = typeof item.favicon === 'string' && item.favicon.startsWith('data:') ? ` ICON="${escape(item.favicon)}"` : ''
      out.push(`${pad}<DT><A HREF="${escape(item.url)}"${dateAttribute(item.added)}${icon}>${escape(item.title)}</A>`)
    }
  }
}

/** The bar is marked as the toolbar folder, which is how a browser that reads the file knows where it goes. */
export function exportBookmarksHtml (tree: Readonly<Record<'bar' | 'other', readonly BookmarkTreeInput[]>>): string {
  const out = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    '    <DL><p>'
  ]
  writeItems(tree.bar, 2, out)
  out.push('    </DL><p>', '    <DT><H3>Other bookmarks</H3>', '    <DL><p>')
  writeItems(tree.other, 2, out)
  out.push('    </DL><p>', '</DL><p>', '')
  return out.join('\n')
}
