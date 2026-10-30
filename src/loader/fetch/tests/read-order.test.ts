// The order a bundle's declared files are read in: the entry first, then the files the pages
// already read lead to, then the rest as the manifest lists them. Content only ever reorders.

import { describe, expect, it } from 'vitest'
import { MAX_SCANNED_BYTES, MAX_SCANNED_FILES, ReadOrder, collectForScan } from '../read-order.js'

const ORIGIN = 'https://app.example.com'
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/** Every index `order` hands out, in the order it hands them out. */
function drain (order: ReadOrder): number[] {
  const taken: number[] = []
  for (let index = order.take(); index !== undefined; index = order.take()) taken.push(index)
  return taken
}

/** The paths `order` hands out next, `count` of them. */
function nextPaths (order: ReadOrder, paths: readonly string[], count: number): string[] {
  return Array.from({ length: count }, () => paths[order.take() as number] as string)
}

/** An order over `paths` whose entry (the first path) has been taken and has said `mention`. */
function orderAfterEntryMentions (paths: readonly string[], mention: string): ReadOrder {
  const order = new ReadOrder(ORIGIN, paths)
  expect(order.take()).toBe(0)
  expect(order.reserveScan(0, mention.length)).toBe(true)
  order.noteMentions(0, text(mention))
  return order
}

describe('ReadOrder: with nothing mentioned', () => {
  it('hands out every path once, in the manifest\'s order, entry first', () => {
    const order = new ReadOrder(ORIGIN, ['index.html', 'b.js', 'a.js', 'c.css'])
    expect(drain(order)).toEqual([0, 1, 2, 3])
    expect(order.take()).toBeUndefined()
  })

  it('hands out nothing for an empty list', () => {
    expect(new ReadOrder(ORIGIN, []).take()).toBeUndefined()
  })
})

describe('ReadOrder: a path a file names comes next', () => {
  const PATHS = ['index.html', '1.js', '2.js', '3.js', 'x.js']

  it.each([
    ['./x.js', '<script src="./x.js"></script>'],
    ['/x.js', '<script src="/x.js"></script>'],
    ['x.js', '<script src="x.js"></script>'],
    ['single quotes', '<script src=\'x.js\'></script>'],
    ['an unquoted attribute', '<script src=x.js></script>'],
    ['a query string', '<script src="x.js?v=3"></script>'],
    ['a document.write string', 'document.write(\'<script defer src="./x.js"></script>\')'],
    ['an import', 'import "./x.js"'],
    ['a stylesheet url()', '@import url(x.js);']
  ])('%s', (_name, mention) => {
    const order = orderAfterEntryMentions(PATHS, mention)
    expect(nextPaths(order, PATHS, 2)).toEqual(['x.js', '1.js'])
  })

  it('a path with a folder, written from the root', () => {
    const paths = ['index.html', '1.js', '2.js', 'orivon/hint/x.js']
    const order = orderAfterEntryMentions(paths, '<script src="orivon/hint/x.js"></script>')
    expect(nextPaths(order, paths, 2)).toEqual(['orivon/hint/x.js', '1.js'])
  })

  it('a percent-encoded name for a file whose manifest path has a space', () => {
    const paths = ['index.html', '1.js', 'my app.js']
    const order = orderAfterEntryMentions(paths, '<script src="my%20app.js"></script>')
    expect(nextPaths(order, paths, 2)).toEqual(['my app.js', '1.js'])
  })

  it('in the order the pages named them, not the manifest\'s', () => {
    const paths = ['index.html', 'a.js', 'b.js', 'c.js', 'd.js']
    const order = orderAfterEntryMentions(paths, '<script src="d.js"></script><script src="b.js"></script><script src="d.js"></script>')
    expect(nextPaths(order, paths, 4)).toEqual(['d.js', 'b.js', 'a.js', 'c.js'])
  })
})

describe('ReadOrder: a name is read from the folder of the file that holds it, and from the root', () => {
  /** The entry names `sub/page.html`, which is then read and names `mention`. */
  function afterPageMentions (paths: readonly string[], mention: string): ReadOrder {
    const order = orderAfterEntryMentions(paths, '<a href="sub/page.html">')
    expect(paths[order.take() as number]).toBe('sub/page.html')
    expect(order.reserveScan(1, mention.length)).toBe(true)
    order.noteMentions(1, text(mention))
    return order
  }

  it('../assets/x.png from a subfolder is the root\'s assets/x.png', () => {
    const paths = ['index.html', 'sub/page.html', '1.js', '2.js', 'assets/x.png']
    const order = afterPageMentions(paths, '<img src="../assets/x.png">')
    expect(nextPaths(order, paths, 2)).toEqual(['assets/x.png', '1.js'])
  })

  it('x.js is the subfolder\'s own x.js when the manifest lists that one', () => {
    const paths = ['index.html', 'sub/page.html', '1.js', 'sub/x.js']
    const order = afterPageMentions(paths, '<script src="x.js"></script>')
    expect(nextPaths(order, paths, 2)).toEqual(['sub/x.js', '1.js'])
  })

  it('x.js is the root\'s x.js when only that one is listed', () => {
    const paths = ['index.html', 'sub/page.html', '1.js', 'x.js']
    const order = afterPageMentions(paths, '<script src="x.js"></script>')
    expect(nextPaths(order, paths, 2)).toEqual(['x.js', '1.js'])
  })

  it('/x.js is the root\'s x.js, never the subfolder\'s', () => {
    const paths = ['index.html', 'sub/page.html', '1.js', 'sub/x.js']
    const order = afterPageMentions(paths, '<script src="/x.js"></script>')
    expect(nextPaths(order, paths, 2)).toEqual(['1.js', 'sub/x.js'])
  })
})

describe('ReadOrder: content can only reorder what the manifest lists', () => {
  const PATHS = ['index.html', '1.js', '2.js', 'x.js']

  it.each([
    ['a path the manifest does not list', '<script src="secret.js"></script>'],
    ['a path outside the app', '<script src="../../etc/passwd.js"></script>'],
    ['a file on another site, with the name of a listed one', '<script src="https://evil.example/x.js"></script>'],
    ['a protocol-relative url, with the name of a listed one', '<script src="//evil.example/x.js"></script>'],
    ['a listed name in another folder', '<script src="other/x.js"></script>'],
    ['a name with no extension', '<script src="x"></script>']
  ])('%s is ignored', (_name, mention) => {
    const order = orderAfterEntryMentions(PATHS, mention)
    expect(drain(order)).toEqual([1, 2, 3])
  })

  it('a path the manifest lists is handed out once, however often it is named', () => {
    const order = orderAfterEntryMentions(PATHS, '<script src="x.js"></script>'.repeat(50))
    expect(drain(order)).toEqual([3, 1, 2])
  })

  it('a file already handed out is not handed out again by a later mention', () => {
    const order = new ReadOrder(ORIGIN, PATHS)
    expect(order.take()).toBe(0)
    expect(order.take()).toBe(1)
    expect(order.reserveScan(0, 30)).toBe(true)
    order.noteMentions(0, text('<script src="1.js"></script>'))
    expect(drain(order)).toEqual([2, 3])
  })

  it('a mention costs one pass over the text: a 1 MiB run of one letter before the name is no slower', () => {
    const order = new ReadOrder(ORIGIN, PATHS)
    order.take()
    order.noteMentions(0, text(`${'A'.repeat(MAX_SCANNED_BYTES)} x.js`))
    expect(drain(order)).toEqual([3, 1, 2])
  })
})

describe('ReadOrder: which files are read for mentions', () => {
  const PATHS = ['index.html', 'a.html', 'b.htm', 'c.js', 'd.mjs', 'e.css', 'f.png', 'g.wasm', 'h.json', 'i.map', 'j.woff2', 'unnamed']

  /** An order in which the entry has named every other path, so each is reached from the entry. */
  function everythingReached (paths: readonly string[] = PATHS): ReadOrder {
    const order = new ReadOrder(ORIGIN, paths)
    order.take()
    order.noteMentions(0, text(paths.slice(1).map((path) => `<a href="${path}">`).join('')))
    return order
  }

  it.each([[1], [2], [3], [4], [5]])('a reached html, js, mjs or css file (index %i) is read', (index) => {
    expect(everythingReached().reserveScan(index, 100)).toBe(true)
  })

  it.each([[6], [7], [8], [9], [10], [11]])('a reached file with a binary or unknown name (index %i) is not', (index) => {
    expect(everythingReached().reserveScan(index, 100)).toBe(false)
  })

  it('an extension is judged without regard to case', () => {
    const paths = ['index.html', 'Page.HTML', 'App.JS']
    const order = everythingReached(paths)
    expect(order.reserveScan(1, 10)).toBe(true)
    expect(order.reserveScan(2, 10)).toBe(true)
  })

  it('the entry is read whatever else is true of it, if its name allows', () => {
    expect(new ReadOrder(ORIGIN, PATHS).reserveScan(0, 100)).toBe(true)
  })

  it('a file nobody named is not read, however it is called', () => {
    const order = new ReadOrder(ORIGIN, PATHS)
    order.take()
    expect(order.reserveScan(3, 100)).toBe(false)
  })

  it('a file handed out before anyone named it is not read either', () => {
    const order = new ReadOrder(ORIGIN, PATHS)
    order.take()
    order.take()
    order.noteMentions(0, text('<script src="a.html"></script>'))
    expect(order.reserveScan(1, 100)).toBe(false)
  })

  it('a file of exactly the limit is read, one byte more is not', () => {
    const order = everythingReached()
    expect(order.reserveScan(3, MAX_SCANNED_BYTES)).toBe(true)
    expect(order.reserveScan(4, MAX_SCANNED_BYTES + 1)).toBe(false)
  })

  it('a file turned away for its size does not count against the file limit', () => {
    const paths = ['index.html', ...Array.from({ length: MAX_SCANNED_FILES + 2 }, (_, i) => `p${String(i)}.js`)]
    const order = everythingReached(paths)
    for (let index = 1; index <= 5; index += 1) expect(order.reserveScan(index, MAX_SCANNED_BYTES + 1)).toBe(false)
    const accepted = Array.from({ length: paths.length - 1 }, (_, i) => order.reserveScan(i + 1, 10)).filter(Boolean).length
    expect(accepted).toBe(MAX_SCANNED_FILES)
  })

  it(`at most ${String(MAX_SCANNED_FILES)} files are read in all, the entry included`, () => {
    const paths = ['index.html', ...Array.from({ length: MAX_SCANNED_FILES * 2 }, (_, i) => `p${String(i)}.js`)]
    const order = everythingReached(paths)
    const accepted = paths.map((_, index) => order.reserveScan(index, 10)).filter(Boolean).length
    expect(accepted).toBe(MAX_SCANNED_FILES)
  })

  it('a file read for mentions passes the order on: what it names comes next', () => {
    const paths = ['index.html', 'a.js', '1.js', '2.js', 'deep.css']
    const order = orderAfterEntryMentions(paths, '<script src="a.js"></script>')
    expect(paths[order.take() as number]).toBe('a.js')
    expect(order.reserveScan(1, 40)).toBe(true)
    order.noteMentions(1, text('@import "deep.css"'))
    expect(nextPaths(order, paths, 3)).toEqual(['deep.css', '1.js', '2.js'])
  })

  it('a file only a later file named is behind the earlier ones that were named', () => {
    const paths = ['index.html', 'a.js', 'b.js', '1.js', 'deep.css']
    const order = orderAfterEntryMentions(paths, '<script src="a.js"></script><script src="b.js"></script>')
    expect(paths[order.take() as number]).toBe('a.js')
    order.reserveScan(1, 10)
    order.noteMentions(1, text('"deep.css"'))
    expect(nextPaths(order, paths, 3)).toEqual(['b.js', 'deep.css', '1.js'])
  })
})

describe('ReadOrder: nothing is lost or repeated', () => {
  it('every path comes out exactly once whatever the files say', () => {
    const paths = ['index.html', ...Array.from({ length: 60 }, (_, i) => `${String(i % 2 === 0 ? 'f' : 'g')}${String(i)}.${i % 3 === 0 ? 'js' : 'css'}`)]
    const order = new ReadOrder(ORIGIN, paths)
    const taken: number[] = []
    let seed = 7
    const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let index = order.take(); index !== undefined; index = order.take()) {
      taken.push(index)
      if (order.reserveScan(index, 50)) {
        const mentions = Array.from({ length: 5 }, () => paths[Math.floor(random() * (paths.length + 10))] ?? 'unlisted.js')
        order.noteMentions(index, text(mentions.map((path) => `<script src="${path}">`).join(' ')))
      }
    }
    expect(taken).toHaveLength(paths.length)
    expect(new Set(taken).size).toBe(paths.length)
    expect([...taken].sort((a, b) => a - b)).toEqual(paths.map((_, index) => index))
  })
})

describe('collectForScan', () => {
  async function * chunks (sizes: readonly number[], pulled: number[]): AsyncGenerator<Uint8Array> {
    for (const size of sizes) {
      pulled.push(size)
      yield new Uint8Array(size).fill(7)
    }
  }

  it('joins the chunks of a file within the limit', async () => {
    const bytes = await collectForScan(chunks([3, 4, 5], []), 100)
    expect(bytes).toHaveLength(12)
  })

  it('keeps no more than the limit, and stops reading once it has it', async () => {
    const pulled: number[] = []
    const bytes = await collectForScan(chunks([60, 60, 60, 60], pulled), 100)
    expect(bytes).toHaveLength(100)
    expect(pulled).toEqual([60, 60])
  })
})
