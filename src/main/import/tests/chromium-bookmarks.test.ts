import { describe, expect, it } from 'vitest'
import { parseChromiumBookmarks, webkitToUnixMs } from '../chromium-bookmarks.js'
import { ImportError } from '../import-types.js'

const folder = (name: string, children: unknown[]): unknown => ({ type: 'folder', name, children })
const page = (name: string, url: string, date = '13300000000000000'): unknown => ({ type: 'url', name, url, date_added: date })
const file = (roots: Record<string, unknown>): string => JSON.stringify({ roots, version: 1 })

describe('webkitToUnixMs', () => {
  it('converts microseconds since 1601 to milliseconds since 1970', () => {
    // 2020-01-01T00:00:00Z in WebKit time.
    expect(webkitToUnixMs('13222310400000000')).toBe(Date.UTC(2020, 0, 1))
  })

  it('answers nothing for a value that is not a time', () => {
    expect(webkitToUnixMs('0')).toBeUndefined()
    expect(webkitToUnixMs('abc')).toBeUndefined()
    expect(webkitToUnixMs(undefined)).toBeUndefined()
  })
})

describe('parseChromiumBookmarks', () => {
  it('reads the bar, Other bookmarks and Mobile bookmarks, keeping folders in order', () => {
    const parsed = parseChromiumBookmarks(file({
      bookmark_bar: folder('Bookmarks bar', [page('A', 'https://a.test/'), folder('News', [page('B', 'https://b.test/')])]),
      other: folder('Other bookmarks', [page('C', 'https://c.test/')]),
      synced: folder('Mobile bookmarks', [page('D', 'https://d.test/')])
    }))
    expect(parsed.bar).toMatchObject([
      { kind: 'url', title: 'A', url: 'https://a.test/' },
      { kind: 'folder', title: 'News', children: [{ kind: 'url', title: 'B', url: 'https://b.test/' }] }
    ])
    expect(parsed.bar[0]?.added).toBe(webkitToUnixMs('13300000000000000'))
    expect(parsed.other.map((node) => node.title)).toEqual(['C', 'Mobile bookmarks'])
    expect(parsed.other[1]?.children?.[0]?.url).toBe('https://d.test/')
  })

  it('keeps a page whose address the store will refuse, so the store can count it as skipped', () => {
    const parsed = parseChromiumBookmarks(file({ bookmark_bar: folder('b', [page('x', 'javascript:alert(1)')]), other: folder('o', []) }))
    expect(parsed.bar).toHaveLength(1)
    expect(parsed.bar[0]?.url).toBe('javascript:alert(1)')
  })

  it('refuses text that is not JSON and JSON that is not a bookmarks file', () => {
    for (const text of ['{oops', '[]', '{"roots":5}', 'null', '']) {
      expect(() => parseChromiumBookmarks(text), text).toThrow(ImportError)
    }
    expect(() => parseChromiumBookmarks('{oops')).toThrowError(expect.objectContaining({ reason: 'format' }))
  })

  it('ignores fields of the wrong type', () => {
    const parsed = parseChromiumBookmarks(file({ bookmark_bar: { children: [{ type: 'url', name: 7, url: 9 }, 'text', null, page('ok', 'https://ok.test/')] } }))
    expect(parsed.bar.map((node) => node.title)).toEqual(['', 'ok'])
    expect(parsed.bar[0]?.url).toBe('')
  })

  it('flattens folders nested past the limit into the deepest folder, without recursing through a hostile depth', () => {
    const open = '{"type":"folder","name":"f","children":['
    const deep = `${open.repeat(5000)}{"type":"url","name":"bottom","url":"https://bottom.test/"}${']}'.repeat(5000)}`
    const parsed = parseChromiumBookmarks(`{"roots":{"bookmark_bar":{"children":[${deep}]}}}`)
    let depth = 0
    let node = parsed.bar[0]
    while (node?.kind === 'folder' && node.children?.[0] !== undefined) { depth += 1; node = node.children[0] }
    expect(depth).toBeLessThanOrEqual(10)
    expect(node?.url).toBe('https://bottom.test/')
  })

  it('stops at the node budget', () => {
    const pages = Array.from({ length: 20_005 }, (_, index) => page(`p${String(index)}`, `https://p${String(index)}.test/`))
    expect(parseChromiumBookmarks(file({ bookmark_bar: { children: pages } })).bar).toHaveLength(20_000)
  })

  it('cuts a title to 512 characters', () => {
    const parsed = parseChromiumBookmarks(file({ bookmark_bar: folder('b', [page('x'.repeat(2000), 'https://a.test/')]) }))
    expect(parsed.bar[0]?.title).toHaveLength(512)
  })
})
