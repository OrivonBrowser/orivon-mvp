import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { BlockSource } from '../blockstore.js'
import { GatewayPool } from '../../gateways/gateways.js'
import type { Fetch } from '../../gateways/gateways.js'
import { DEFAULT_LIMITS } from '../limits.js'
import { openPath } from '../unixfs.js'
import { formatSize } from '../directory-page.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'
import type { Dag } from './dag.test-helpers.js'

const signal = new AbortController().signal
const BIG = new Uint8Array(700_000).map((_, i) => (i * 31) % 251)
const HOSTILE = '<img src=x onerror=alert(1)>.txt'

const tree = await buildDag({
  'readme.txt': 'hello',
  'a b.txt': 'spaced',
  'javascript:alert(1)': 'colon',
  [HOSTILE]: 'x',
  'big.bin': BIG,
  'sub/inner.txt': 'inner',
  'sub/deeper/leaf.txt': 'leaf',
  'site/index.html': '<h1>site</h1>',
  'site/other.txt': 'other'
})

function sourceOf (d: Dag): BlockSource {
  return new BlockSource(fakeGateways(d.blocks).fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
}

async function listing (d: Dag, path: string): Promise<{ html: string, servedPath: string, contentType: string | undefined, size: number }> {
  const file = await openPath(sourceOf(d), d.root, path, undefined, signal, () => {})
  const parts: Uint8Array[] = []
  for await (const chunk of file.body) parts.push(chunk)
  return { html: new TextDecoder().decode(Buffer.concat(parts)), servedPath: file.servedPath, contentType: file.contentType, size: file.size }
}

async function text (d: Dag, path: string): Promise<string> {
  const file = await openPath(sourceOf(d), d.root, path, undefined, signal, () => {})
  const parts: Uint8Array[] = []
  for await (const chunk of file.body) parts.push(chunk)
  return new TextDecoder().decode(Buffer.concat(parts))
}

describe('a directory with no index.html', () => {
  it('is answered with a listing typed as HTML, sized as its own bytes', async () => {
    const page = await listing(tree, '/')
    expect(page.contentType).toBe('text/html; charset=utf-8')
    expect(page.servedPath).toBe('/')
    expect(page.size).toBe(new TextEncoder().encode(page.html).length)
    expect(page.html).toContain('<h1>Index of /</h1>')
  })

  it('has one row per entry, a folder ending in a slash, names relative and percent-encoded', async () => {
    const { html } = await listing(tree, '/')
    expect(html).toContain('href="sub/"')
    expect(html).toContain('href="site/"')
    expect(html).toContain('href="a%20b.txt"')
    expect(html).toContain('href="readme.txt"')
  })

  it('lists folders first, then files, each by name', async () => {
    const { html } = await listing(tree, '/')
    const order = ['>site/<', '>sub/<', '>a b.txt<', '>big.bin<', '>javascript:alert(1)<', '>readme.txt<'].map((s) => html.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says folder or file for each, and a file size read from the file itself', async () => {
    const { html } = await listing(tree, '/')
    expect(html).toMatch(/<td class="kind">folder<\/td>/)
    expect(html).toMatch(/href="big.bin">big.bin<\/a><\/td><td class="kind">file<\/td><td class="size">700\.0 kB<\/td>/)
  })

  it('gives a raw-leaf file the size its link names, marked approximate', async () => {
    const { html } = await listing(tree, '/')
    expect(html).toMatch(/href="readme.txt">readme.txt<\/a><\/td><td class="kind">file<\/td><td class="size">~5 B<\/td>/)
    expect(html).toContain('approximate')
  })

  it('lists a sub-directory, with a link to its parent and none at the root', async () => {
    const root = await listing(tree, '/')
    expect(root.html).not.toContain('href="../"')
    const sub = await listing(tree, '/sub/')
    expect(sub.servedPath).toBe('/sub/')
    expect(sub.html).toContain('<h1>Index of /sub/</h1>')
    expect(sub.html).toContain('href="../"')
    expect(sub.html).toContain('href="deeper/"')
    expect(sub.html).toContain('href="inner.txt"')
    const deeper = await listing(tree, '/sub/deeper/')
    expect(deeper.html).toContain('<h1>Index of /sub/deeper/</h1>')
  })

  it('names the slash form as the served path for a request without the slash', async () => {
    expect((await listing(tree, '/sub')).servedPath).toBe('/sub/')
  })

  it('still serves index.html for a directory that has one', async () => {
    const file = await openPath(sourceOf(tree), tree.root, '/site/', undefined, signal, () => {})
    expect(file.servedPath).toBe('/site/index.html')
  })

  it('is still not found for a path that does not exist', async () => {
    await expect(openPath(sourceOf(tree), tree.root, '/nope/', undefined, signal, () => {})).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('is flagged as a listing, and a request for the form without the slash is only a redirect that reads no entries', async () => {
    const gw = fakeGateways(tree.blocks)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    const redirect = await openPath(s, tree.root, '/sub', undefined, signal, () => {})
    expect(redirect.listing).toBe(true)
    expect(redirect.servedPath).toBe('/sub/')
    const asked = gw.requests.length
    expect(asked).toBeLessThanOrEqual(3)
    const page = await openPath(sourceOf(tree), tree.root, '/sub/', undefined, signal, () => {})
    expect(page.listing).toBe(true)
  })

  it('answers a range with the whole page: a listing has no ranges', async () => {
    const whole = await listing(tree, '/')
    const file = await openPath(sourceOf(tree), tree.root, '/', { start: 2, end: 9 }, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    expect(file.size).toBe(whole.size)
    expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(whole.html)
  })
})

describe('names are attacker-controlled bytes', () => {
  it('escapes markup in a name, in the text and in the link', async () => {
    const { html } = await listing(tree, '/')
    expect(html).not.toContain('<img')
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;.txt')
    expect(html).toContain('href="%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.txt"')
  })

  it('never writes a name that reads as a scheme into a link', async () => {
    const { html } = await listing(tree, '/')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('href="javascript%3Aalert(1)"')
  })

  it('carries no script, form, frame, embed, handler or external resource', async () => {
    const { html } = await listing(tree, '/')
    expect(html).not.toMatch(/<(script|link|img|iframe|object|embed|form|base|meta http-equiv)|<[^>]*\son\w+\s*=|url\(|@import/i)
  })

  it('shows a bidi override and a control character as code points, never raw', async () => {
    const d = await buildDag({ 'invoice‮gpj.exe': 'x', 'tab\tname': 'y' })
    const { html } = await listing(d, '/')
    expect(html).not.toContain('‮')
    expect(html).toContain('invoice[U+202E]gpj.exe')
    expect(html).toContain('tab[U+0009]name')
  })
})

describe('the row cap', () => {
  it('shows the first thousand rows and says how many more there are', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 1005; i++) files[`f${String(i).padStart(4, '0')}.txt`] = String(i)
    const d = await buildDag(files)
    const { html } = await listing(d, '/')
    expect(html.match(/<tr class="row">/g)?.length).toBe(1000)
    expect(html).toContain('and 5 more')
  })
})

describe('a sharded directory', () => {
  it('is listed, entry by entry, through the same verified reads', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`entry-${String(i).padStart(3, '0')}.txt`] = `body ${String(i)}`
    const d = await buildDag(files, { shardSplitThresholdBytes: 1 })
    const rootBlock = dagPb.decode(d.blocks.get(d.root.toString()) as Uint8Array)
    expect(UnixFS.unmarshal(rootBlock.Data as Uint8Array).type).toBe('hamt-sharded-directory')
    const { html } = await listing(d, '/')
    expect(html.match(/<tr class="row">/g)?.length).toBe(60)
    expect(html).toContain('href="entry-000.txt"')
    expect(html).toContain('href="entry-059.txt"')
  })

  it('lists a very large one as far as the shard-block cap lets it read, and says it is too large', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 1100; i++) files[`e${String(i).padStart(4, '0')}`] = String(i)
    const d = await buildDag(files, { shardSplitThresholdBytes: 1 })
    const { html } = await listing(d, '/')
    expect(html.match(/<tr class="row">/g)?.length).toBeGreaterThan(400)
    expect(html.match(/<tr class="row">/g)?.length).toBeLessThanOrEqual(1000)
    expect(html).toContain('This folder is too large to list in full.')
  })

  it('fails as unverifiable, not as a crash, when a shard block is tampered', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 60; i++) files[`entry-${String(i).padStart(3, '0')}.txt`] = `body ${String(i)}`
    const d = await buildDag(files, { shardSplitThresholdBytes: 1 })
    const gw = fakeGateways(d.blocks)
    for (const [key] of d.blocks) if (key !== d.root.toString() && CID.parse(key).code === 0x70) gw.tamper(key)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    await expect(openPath(s, d.root, '/', undefined, signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})

describe('an entry whose own block cannot be read', () => {
  it('is listed without a kind and with its link size, not failing the folder', async () => {
    const blocks = new Map<string, Uint8Array>()
    const put = async (code: number, bytes: Uint8Array): Promise<CID> => {
      const cid = CID.createV1(code, await sha256.digest(bytes))
      blocks.set(cid.toString(), bytes)
      return cid
    }
    const absent = CID.createV1(0x70, await sha256.digest(new TextEncoder().encode('never published')))
    const root = await put(0x70, dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [{ Hash: absent, Name: 'ghost', Tsize: 4096 }] }))
    const gw = fakeGateways(blocks)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), { ...DEFAULT_LIMITS, blockTimeoutMs: 500 })
    const file = await openPath(s, root, '/', undefined, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    const html = new TextDecoder().decode(Buffer.concat(parts))
    expect(html).toMatch(/href="ghost">ghost<\/a><\/td><td class="kind">file or folder<\/td><td class="size">~4\.1 kB<\/td>/)
  })
})

describe('an empty directory', () => {
  it('says it is empty', async () => {
    const blocks = new Map<string, Uint8Array>()
    const bytes = dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [] })
    const root = CID.createV1(0x70, await sha256.digest(bytes))
    blocks.set(root.toString(), bytes)
    expect((await listing({ root, blocks }, '/')).html).toContain('This folder is empty.')
  })
})

describe('formatSize', () => {
  it('writes bytes below a thousand whole and larger sizes with one decimal', () => {
    expect(formatSize(0n)).toBe('0 B')
    expect(formatSize(999n)).toBe('999 B')
    expect(formatSize(1000n)).toBe('1.0 kB')
    expect(formatSize(12_345_678n)).toBe('12.3 MB')
    expect(formatSize(5_000_000_000n)).toBe('5.0 GB')
  })
})

describe('a hostile folder cannot make a huge page', () => {
  it('shows a long name cut to 255 characters with an ellipsis, linked by its whole encoded name', async () => {
    const long = `${'n'.repeat(400)}.txt`
    const d = await buildDag({ [long]: 'x' })
    const { html } = await listing(d, '/')
    expect(html).toContain(`>${'n'.repeat(255)}…</a>`)
    expect(html).not.toContain(`>${'n'.repeat(256)}`)
    expect(html).toContain(`href="${long}"`)
  })

  it('shows a name whose encoded link would pass 8 KiB unlinked', async () => {
    const d = await buildDag({ ['é'.repeat(5000)]: 'x', 'ok.txt': 'y' })
    const { html } = await listing(d, '/')
    expect(html).toContain('href="ok.txt"')
    expect(html).not.toContain('%C3%A9%C3%A9%C3%A9')
    expect(html).toContain('<td class="name">' + 'é'.repeat(255) + '…</td>')
  })

  it('stops adding rows once the page passes a mebibyte, and says how many it left out', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 400; i++) files[`${String(i).padStart(4, '0')}${'x'.repeat(4000)}`] = 'x'
    const d = await buildDag(files)
    const { html } = await listing(d, '/')
    expect(html.length).toBeLessThan(1024 * 1024 + 20_000)
    expect(html.match(/<tr class="row">/g)?.length).toBeLessThan(400)
    expect(html).toMatch(/and \d+ more not shown\./)
  })
})

describe('reading a folder is bounded', () => {
  /** A sharded directory whose every shard links to one more shard and to nothing else, `depth` deep. */
  async function shardChain (depth: number): Promise<Dag> {
    const blocks = new Map<string, Uint8Array>()
    let next: CID | undefined
    for (let i = 0; i < depth; i++) {
      const data = new UnixFS({ type: 'hamt-sharded-directory', data: new Uint8Array([1]), fanout: 256n, hashType: 0x22n }).marshal()
      const bytes = dagPb.encode({ Data: data, Links: next === undefined ? [] : [{ Hash: next, Name: '00', Tsize: 1 }] })
      const cid = CID.createV1(0x70, await sha256.digest(bytes))
      blocks.set(cid.toString(), bytes)
      next = cid
    }
    return { root: next as CID, blocks }
  }

  it('lists what a chain of shards reached and says the folder is too large, after at most 200 blocks', async () => {
    const d = await shardChain(500)
    const gw = fakeGateways(d.blocks)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    const file = await openPath(s, d.root, '/', undefined, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    const html = new TextDecoder().decode(Buffer.concat(parts))
    expect(html).toContain('This folder is too large to list in full.')
    expect(html).not.toContain('This folder is empty.')
    expect(new Set(gw.requests).size).toBeLessThanOrEqual(205)
  })

  it('types only the first hundred dag-pb entries, and lists the rest without a kind', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 130; i++) files[`f${String(i).padStart(3, '0')}`] = `body ${String(i)}`
    const d = await buildDag(files, { rawLeaves: false })
    const gw = fakeGateways(d.blocks)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    const file = await openPath(s, d.root, '/', undefined, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    const html = new TextDecoder().decode(Buffer.concat(parts))
    expect(html.match(/class="kind">file</g)?.length).toBe(100)
    expect(html.match(/class="kind">file or folder</g)?.length).toBe(30)
    expect(new Set(gw.requests).size).toBe(101)
  })

  it('sends the page with what it has once the time budget passes, while an entry never answers', async () => {
    const d = await buildDag({ 'slow.bin': 'slow', 'quick.txt': 'quick' }, { rawLeaves: false })
    const rootBlock = dagPb.decode(d.blocks.get(d.root.toString()) as Uint8Array)
    const slow = rootBlock.Links.find((l) => l.Name === 'slow.bin')?.Hash.toString() as string
    const base = fakeGateways(d.blocks)
    const fetch: Fetch = async (url, init) => {
      if (!url.includes(slow)) return await base.fetch(url, init)
      return await new Promise<Response>((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) })
    }
    const s = new BlockSource(fetch, new GatewayPool(['https://a.gateway'], 4), { ...DEFAULT_LIMITS, listingBudgetMs: 300 })
    const began = Date.now()
    const file = await openPath(s, d.root, '/', undefined, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    const html = new TextDecoder().decode(Buffer.concat(parts))
    expect(Date.now() - began).toBeLessThan(5000)
    expect(html).toMatch(/href="slow.bin">slow.bin<\/a><\/td><td class="kind">file or folder</)
    expect(html).toMatch(/href="quick.txt">quick.txt<\/a><\/td><td class="kind">file</)
  })

  it('still fails the request when the client has gone', async () => {
    const d = await shardChain(500)
    const gone = new AbortController()
    gone.abort(new Error('gone'))
    await expect(openPath(sourceOf(d), d.root, '/', undefined, gone.signal, () => {})).rejects.toBeDefined()
  })
})

describe('a link in a listing opens the file it names', () => {
  it('round-trips names with #, ?, %, a space and non-ASCII characters', async () => {
    const names = ['a#b.txt', 'what?.txt', '100%.txt', 'two words.txt', 'café ☃.txt', 'x%2Fy.txt', '+plus&amp.txt']
    const d = await buildDag(Object.fromEntries(names.map((n) => [n, `content of ${n}`])))
    const { html } = await listing(d, '/')
    for (const name of names) {
      const hrefs = [...html.matchAll(/<a href="([^"]*)">/g)].map((m) => (m[1] as string).replaceAll('&#38;', '&'))
      const href = hrefs.find((h) => decodeURIComponent(h) === name)
      expect(href, name).toBeDefined()
      // The browser resolves the relative link against the listing's own address and asks for the path of the result.
      const pathname = new URL(href as string, 'https://listing.example/').pathname
      expect(await text(d, pathname)).toBe(`content of ${name}`)
    }
  })
})
