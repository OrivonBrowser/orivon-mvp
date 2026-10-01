import { describe, expect, it } from 'vitest'
import type { BookmarkTreeInput } from '../bookmark-types.js'
import { exportBookmarksHtml } from '../bookmarks-html-export.js'

const empty = { bar: [], other: [] }

describe('exportBookmarksHtml', () => {
  it('writes the Netscape file: doctype, charset, title, and the bar marked as the toolbar folder', () => {
    const html = exportBookmarksHtml(empty)

    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(html).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
    expect(html).toContain('<TITLE>Bookmarks</TITLE>')
    expect(html).toContain('<H1>Bookmarks</H1>')
    expect(html).toContain('<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>')
    expect(html).toContain('<DT><H3>Other bookmarks</H3>')
    expect(html.indexOf('Bookmarks bar')).toBeLessThan(html.indexOf('Other bookmarks'))
  })

  it('nests folders, keeps the order, and writes dates in whole seconds', () => {
    const bar: BookmarkTreeInput[] = [
      { kind: 'url', title: 'First', url: 'https://first.example/', added: 1_700_000_000_999 },
      { kind: 'folder', title: 'Work', added: 1_600_000_000_000, children: [
        { kind: 'folder', title: 'Deep', children: [{ kind: 'url', title: 'Inside', url: 'https://deep.example/' }] },
        { kind: 'url', title: 'Second', url: 'https://second.example/' }
      ] }
    ]
    const html = exportBookmarksHtml({ bar, other: [] })
    const lines = html.split('\n')

    expect(html).toContain('<DT><A HREF="https://first.example/" ADD_DATE="1700000000">First</A>')
    expect(html).toContain('<DT><H3 ADD_DATE="1600000000">Work</H3>')
    expect(html).toContain('<DT><A HREF="https://deep.example/">Inside</A>')
    const open = lines.filter((line) => line.includes('<DL><p>')).length
    const close = lines.filter((line) => line.includes('</DL><p>')).length
    expect(open).toBe(close)
    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Work'))
    expect(html.indexOf('Deep')).toBeLessThan(html.indexOf('Second'))
    const deep = lines.find((line) => line.includes('Inside')) as string
    const work = lines.find((line) => line.includes('>Work<')) as string
    expect(deep.length - deep.trimStart().length).toBeGreaterThan(work.length - work.trimStart().length)
  })

  it('writes an empty folder as an empty list', () => {
    const html = exportBookmarksHtml({ bar: [{ kind: 'folder', title: 'Nothing', children: [] }], other: [] })

    expect(html).toMatch(/<H3>Nothing<\/H3>\n\s*<DL><p>\n\s*<\/DL><p>/)
  })

  it('escapes every title and attribute, so a hostile title stays text', () => {
    const html = exportBookmarksHtml({
      bar: [
        { kind: 'url', title: '</A><script>alert(1)</script>', url: 'https://a.example/?q="x"&r=\'y\'<z>' },
        { kind: 'folder', title: 'A & B "quoted" <tag>', children: [] }
      ],
      other: []
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;/A&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('HREF="https://a.example/?q=&quot;x&quot;&amp;r=&#39;y&#39;&lt;z&gt;"')
    expect(html).toContain('A &amp; B &quot;quoted&quot; &lt;tag&gt;')
  })

  it('carries an icon only when there is one, and only as a data URL', () => {
    const html = exportBookmarksHtml({
      bar: [
        { kind: 'url', title: 'With', url: 'https://w.example/', favicon: 'data:image/png;base64,AAAA' },
        { kind: 'url', title: 'Without', url: 'https://n.example/', favicon: null },
        { kind: 'url', title: 'Odd', url: 'https://o.example/', favicon: 'https://tracker.example/i.png' }
      ],
      other: []
    })

    expect(html).toContain('ICON="data:image/png;base64,AAAA"')
    expect(html.match(/ICON=/g)).toHaveLength(1)
  })
})
