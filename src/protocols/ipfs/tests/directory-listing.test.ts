import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { BlockSource } from '../blockstore.js'
import { GatewayPool } from '../../gateways/gateways.js'
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

  it('serves a byte range of the listing', async () => {
    const whole = await listing(tree, '/')
    const file = await openPath(sourceOf(tree), tree.root, '/', { start: 2, end: 9 }, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    expect(file.size).toBe(whole.size)
    expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(whole.html.slice(2, 10))
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

  it('carries no script and no external resource, and forbids both', async () => {
    const { html } = await listing(tree, '/')
    expect(html).not.toMatch(/<(script|link|img|iframe|object|embed|form|base)|url\(|@import/i)
    expect(html).toContain("default-src 'none'")
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

  it('is cut at the row cap without being counted', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 1100; i++) files[`e${String(i).padStart(4, '0')}`] = String(i)
    const d = await buildDag(files, { shardSplitThresholdBytes: 1 })
    const { html } = await listing(d, '/')
    expect(html.match(/<tr class="row">/g)?.length).toBe(1000)
    expect(html).toContain('more entries than are shown')
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
