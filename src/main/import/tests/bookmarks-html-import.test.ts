import { describe, expect, it } from 'vitest'
import { decodeEntities, parseBookmarksHtml } from '../bookmarks-html-import.js'
import { ImportError } from '../import-types.js'

const HEAD = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n'

const EXPORT = `${HEAD}<DL><p>
    <DT><H3 ADD_DATE="1600000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://a.test/" ADD_DATE="1600000001">A &amp; B</A>
        <DT><H3 ADD_DATE="1600000002">News</H3>
        <DL><p>
            <DT><A HREF="https://n.test/?x=1&amp;y=2" ADD_DATE="1600000003">Daily &lt;news&gt;</A>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://o.test/">Other</A>
    </DL><p>
</DL><p>`

describe('parseBookmarksHtml', () => {
  it('reads the shape the bookmark manager exports: the toolbar folder is the bar, the rest is Other bookmarks', () => {
    const { bar, other } = parseBookmarksHtml(EXPORT)
    expect(bar).toEqual([
      { kind: 'url', title: 'A & B', url: 'https://a.test/', added: 1_600_000_001_000 },
      { kind: 'folder', title: 'News', added: 1_600_000_002_000, children: [{ kind: 'url', title: 'Daily <news>', url: 'https://n.test/?x=1&y=2', added: 1_600_000_003_000 }] }
    ])
    expect(other).toEqual([{ kind: 'url', title: 'Other', url: 'https://o.test/' }])
  })

  it('keeps a folder of Other bookmarks that is not the place for what is unfiled', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><H3>Recipes</H3><DL><p><DT><A HREF="https://r.test/">R</A></DL><p></DL>`)
    expect(other).toEqual([{ kind: 'folder', title: 'Recipes', children: [{ kind: 'url', title: 'R', url: 'https://r.test/' }] }])
  })

  it('reads Firefox\'s unfiled folder as Other bookmarks', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3><DL><p><DT><A HREF="https://u.test/">U</A></DL><p></DL>`)
    expect(other).toEqual([{ kind: 'url', title: 'U', url: 'https://u.test/' }])
  })

  it('decodes entities, including numeric ones, and leaves an unknown one as written', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&#x41;&#65;&bogus;')).toBe('&<>"\'AA&bogus;')
    expect(decodeEntities('&#1114112;&#xD800;')).toBe('&#1114112;&#xD800;')
  })

  it('reads a file whose tags are never closed and whose case varies', () => {
    const { other } = parseBookmarksHtml('<!doctype netscape-bookmark-file-1><dl><dt><a href="https://x.test/">X<dt><a href=https://y.test/>Y</dl>')
    expect(other.map((node) => node.url)).toEqual(['https://x.test/', 'https://y.test/'])
  })

  it('does not let a page with no closing tag swallow the page after it', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><A HREF="https://x.test/">One\n<DT><A HREF="https://y.test/">Two</A>\n<DT><A HREF="https://z.test/">Three</A></DL>`)
    expect(other.map((node) => [node.title, node.url])).toEqual([['One', 'https://x.test/'], ['Two', 'https://y.test/'], ['Three', 'https://z.test/']])
  })

  it('does not let a folder heading with no closing tag swallow the entries after it', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><H3>Folder\n<DL><DT><A HREF="https://x.test/">In</A></DL></DL>`)
    expect(other).toMatchObject([{ kind: 'folder', title: 'Folder', children: [{ title: 'In', url: 'https://x.test/' }] }])
  })

  it('takes a closing tag only if it is the link\'s own, not one that merely starts with the same letters', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><A HREF="https://x.test/">Big <abbr>ABC</abbr> and <address>x</address> name</A></DL>`)
    expect(other[0]?.title).toBe('Big ABC and x name')
  })

  it('keeps a page whose address the store will refuse, so it is counted as skipped there', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><A HREF="javascript:alert(1)">bad</A></DL>`)
    expect(other[0]?.url).toBe('javascript:alert(1)')
  })

  it('reads a title holding markup as text', () => {
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p><DT><A HREF="https://t.test/">&lt;/A&gt;&lt;script&gt;x&lt;/script&gt;</A></DL>`)
    expect(other[0]?.title).toBe('</A><script>x</script>')
  })

  it('refuses a file with no bookmarks and no bookmarks header', () => {
    for (const text of ['', '<html><body><p>hello</p></body></html>', 'just text', '{"roots":{}}']) {
      expect(() => parseBookmarksHtml(text), text).toThrowError(expect.objectContaining({ reason: 'format' }))
    }
    expect(() => parseBookmarksHtml('x'.repeat(21 * 1024 * 1024))).toThrow(ImportError)
  })

  it('accepts an empty file that says what it is', () => {
    expect(parseBookmarksHtml(`${HEAD}<DL><p></DL><p>`)).toEqual({ bar: [], other: [] })
  })

  it('stops at 20,000 nodes', () => {
    const pages = Array.from({ length: 20_001 }, (_, index) => `<DT><A HREF="https://p${String(index)}.test/">p</A>`).join('\n')
    expect(parseBookmarksHtml(`${HEAD}<DL><p>${pages}</DL>`).other).toHaveLength(20_000)
  })

  it('flattens folders nested past the limit into the deepest one', () => {
    const open = Array.from({ length: 40 }, (_, index) => `<DT><H3>f${String(index)}</H3><DL><p>`).join('')
    const { other } = parseBookmarksHtml(`${HEAD}<DL><p>${open}<DT><A HREF="https://deep.test/">deep</A>${'</DL><p>'.repeat(40)}</DL>`)
    let depth = 0
    let node = other[0]
    while (node?.kind === 'folder' && node.children?.[0] !== undefined) { depth += 1; node = node.children[0] }
    expect(depth).toBeLessThanOrEqual(10)
    expect(node?.url).toBe('https://deep.test/')
  })

  it('reads a file of unclosed tags in linear time', () => {
    const started = Date.now()
    parseBookmarksHtml(`${HEAD}${'<A HREF="https://x.test/">'.repeat(40_000)}${'<H3>'.repeat(40_000)}${'<a <a <a '.repeat(40_000)}`)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
