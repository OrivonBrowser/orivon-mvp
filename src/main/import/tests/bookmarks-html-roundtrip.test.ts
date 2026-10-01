import { describe, expect, it } from 'vitest'
import { exportBookmarksHtml } from '../../browsing/bookmarks-html-export.js'
import type { BookmarkTreeInput } from '../../browsing/bookmark-types.js'
import { parseBookmarksHtml } from '../bookmarks-html-import.js'

// What the bookmark manager writes must be what Import reads back, or a person cannot move their bookmarks
// between two Orivon profiles with the two features that exist for it.
const TREE: Record<'bar' | 'other', BookmarkTreeInput[]> = {
  bar: [
    { kind: 'url', title: 'A & B <c>', url: 'https://a.test/?x=1&y=2', added: 1_600_000_001_000 },
    { kind: 'folder', title: 'News "daily"', added: 1_600_000_002_000, children: [
      { kind: 'url', title: 'Deep', url: 'https://n.test/', added: 1_600_000_003_000 },
      { kind: 'folder', title: 'Empty', added: 1_600_000_004_000, children: [] }
    ] }
  ],
  other: [{ kind: 'url', title: 'Other', url: 'https://o.test/', added: 1_600_000_005_000 }]
}

describe('the bookmarks HTML file', () => {
  it('reads back as the tree that was exported', () => {
    const back = parseBookmarksHtml(exportBookmarksHtml(TREE))
    expect(back.bar).toEqual(TREE.bar)
    expect(back.other).toEqual(TREE.other)
  })

  it('reads back when a bookmark carries an icon', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    const back = parseBookmarksHtml(exportBookmarksHtml({ bar: [{ kind: 'url', title: 'Icon', url: 'https://i.test/', added: 1_600_000_006_000, favicon: icon }], other: [] }))
    expect(back.bar).toEqual([expect.objectContaining({ kind: 'url', title: 'Icon', url: 'https://i.test/' })])
  })
})
