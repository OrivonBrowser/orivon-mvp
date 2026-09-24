import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import type { Refusal } from '../../resolution/providers.js'
import { BlockSource } from '../blockstore.js'
import { GatewayPool } from '../gateways.js'
import { DEFAULT_LIMITS } from '../limits.js'
import type { IpfsLimits } from '../limits.js'
import { openPath, pathSegments } from '../unixfs.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { balanced } from 'ipfs-unixfs-importer/layout'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { sha256 } from 'multiformats/hashes/sha2'

const BIG = new Uint8Array(700_000).map((_, i) => (i * 31) % 251)
const dag = await buildDag({
  'index.html': '<h1>home</h1>',
  'docs/index.html': '<h1>docs</h1>',
  'docs/a b.txt': 'spaced',
  'big.bin': BIG
})

const signal = new AbortController().signal

function source (limits: Partial<IpfsLimits> = {}): { s: BlockSource, gw: ReturnType<typeof fakeGateways> } {
  const gw = fakeGateways(dag.blocks)
  return { s: new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway', 'https://b.gateway'], 4), { ...DEFAULT_LIMITS, ...limits }), gw }
}

async function text (s: BlockSource, path: string, onRefusal: (r: Refusal) => void = () => {}): Promise<string> {
  const file = await openPath(s, dag.root, path, undefined, signal, onRefusal)
  const parts: Uint8Array[] = []
  for await (const chunk of file.body) parts.push(chunk)
  return new TextDecoder().decode(Buffer.concat(parts))
}

async function bytes (s: BlockSource, path: string, range?: { start: number, end: number }): Promise<Buffer> {
  const file = await openPath(s, dag.root, path, range, signal, () => {})
  const parts: Uint8Array[] = []
  for await (const chunk of file.body) parts.push(chunk)
  return Buffer.concat(parts)
}

/** Buffer.equals, not toEqual: an element-by-element diff of 700 KB takes seconds. */
function same (a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

describe('openPath', () => {
  it('serves the root index.html for /', async () => {
    expect(await text(source().s, '/')).toBe('<h1>home</h1>')
  })

  it('serves a directory as its index.html, with or without the trailing slash, and says so', async () => {
    expect(await text(source().s, '/docs/')).toBe('<h1>docs</h1>')
    expect(await text(source().s, '/docs')).toBe('<h1>docs</h1>')
    expect((await openPath(source().s, dag.root, '/docs', undefined, signal, () => {})).servedPath).toBe('/docs/index.html')
    expect((await openPath(source().s, dag.root, '/', undefined, signal, () => {})).servedPath).toBe('/index.html')
    expect((await openPath(source().s, dag.root, '/docs/a%20b.txt', undefined, signal, () => {})).servedPath).toBe('/docs/a b.txt')
  })

  it('percent-decodes a path segment', async () => {
    expect(await text(source().s, '/docs/a%20b.txt')).toBe('spaced')
  })

  it('reads a multi-block file whole, and reports its size', async () => {
    const file = await openPath(source().s, dag.root, '/big.bin', undefined, signal, () => {})
    expect(file.size).toBe(BIG.length)
    expect(same(await bytes(source().s, '/big.bin'), BIG)).toBe(true)
  })

  it('reads an inclusive byte range across block boundaries', async () => {
    const range = { start: 262_000, end: 300_000 }
    expect(same(await bytes(source().s, '/big.bin', range), BIG.slice(range.start, range.end + 1))).toBe(true)
  })

  it('is not found for a missing path, and for a directory without index.html', async () => {
    await expect(openPath(source().s, dag.root, '/missing.js', undefined, signal, () => {})).rejects.toMatchObject({ failure: 'not-found' })
    const bare = await buildDag({ 'sub/file.txt': 'x' })
    const gw = fakeGateways(bare.blocks)
    const s = new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    await expect(openPath(s, bare.root, '/sub/', undefined, signal, () => {})).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('fails a file whose block was tampered on every gateway, and serves none of that block', async () => {
    const { s, gw } = source()
    const leafKeys = [...dag.blocks.keys()].filter((k) => CID.parse(k).code === 0x55)
    for (const key of leafKeys) gw.tamper(key)
    // A one-block file's block is read to open it at all, so the refusal may come before any body exists.
    const read = async (): Promise<void> => {
      const file = await openPath(s, dag.root, '/index.html', undefined, signal, () => {})
      for await (const _ of file.body) { void _ }
    }
    await expect(read()).rejects.toMatchObject({ failure: 'unverifiable' })
    await expect(bytes(s, '/big.bin')).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('reports a refusal and still serves the verified bytes from another gateway', async () => {
    const { s, gw } = source()
    for (const key of dag.blocks.keys()) gw.tamper(key, ['https://a.gateway'])
    const refused: Refusal[] = []
    expect(await text(s, '/index.html', (r) => { refused.push(r) })).toBe('<h1>home</h1>')
    expect(refused.length).toBeGreaterThan(0)
    expect(refused.every((r) => r.source === 'https://a.gateway')).toBe(true)
  })

  it('stops a walk that needs more blocks than one request may use', async () => {
    const { s } = source({ maxBlocksPerOpen: 2 })
    await expect(bytes(s, '/big.bin')).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})

describe('a file several levels deep', async () => {
  const DEEP = new Uint8Array(40_000).map((_, i) => (i * 7) % 251)
  const deep = await buildDag({ 'deep.bin': DEEP }, { chunker: fixedSize({ chunkSize: 100 }), layout: balanced({ maxChildrenPerNode: 4 }) })
  const deepSource = (limits: Partial<IpfsLimits> = {}): { s: BlockSource, gw: ReturnType<typeof fakeGateways> } => {
    const gw = fakeGateways(deep.blocks)
    return { s: new BlockSource(gw.fetch, new GatewayPool(['https://a.gateway'], 4), { ...DEFAULT_LIMITS, ...limits }), gw }
  }
  const read = async (s: BlockSource, range?: { start: number, end: number }): Promise<Buffer> => {
    const file = await openPath(s, deep.root, '/deep.bin', range, signal, () => {})
    const parts: Uint8Array[] = []
    for await (const chunk of file.body) parts.push(chunk)
    return Buffer.concat(parts)
  }

  it('reads whole, and by any range, across every level', async () => {
    expect(same(await read(deepSource().s), DEEP)).toBe(true)
    for (const range of [{ start: 0, end: 0 }, { start: 99, end: 100 }, { start: 12_345, end: 23_456 }, { start: 39_999, end: 39_999 }]) {
      expect(same(await read(deepSource().s, range), DEEP.slice(range.start, range.end + 1))).toBe(true)
    }
  })

  it('fails a tampered leaf deep in the DAG as unverifiable, and nothing escapes unhandled', async () => {
    const { s, gw } = deepSource()
    for (const key of deep.blocks.keys()) if (CID.parse(key).code === 0x55) gw.tamper(key)
    await expect(read(s)).rejects.toMatchObject({ failure: 'unverifiable' })
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  it('refuses a DAG deeper than the limit', async () => {
    await expect(read(deepSource({ maxDagDepth: 2 }).s)).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/deeper than 2/) })
  })
})

describe('a file whose sizes lie', () => {
  it('fails rather than shift or pad the bytes it serves', async () => {
    const blocks = new Map<string, Uint8Array>()
    const put = async (code: number, bytes: Uint8Array): Promise<CID> => {
      const cid = CID.createV1(code, await sha256.digest(bytes))
      blocks.set(cid.toString(), bytes)
      return cid
    }
    const leaf = await put(0x55, new TextEncoder().encode('abc'))
    const file = await put(0x70, dagPb.encode({ Data: new UnixFS({ type: 'file', blockSizes: [5n] }).marshal(), Links: [{ Hash: leaf, Tsize: 3 }] }))
    const root = await put(0x70, dagPb.encode({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: [{ Hash: file, Name: 'x', Tsize: 10 }] }))
    const s = new BlockSource(fakeGateways(blocks).fetch, new GatewayPool(['https://a.gateway'], 4), DEFAULT_LIMITS)
    const opened = await openPath(s, root, '/x', undefined, signal, () => {})
    await expect((async () => { for await (const _ of opened.body) { void _ } })()).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/malformed/) })
  })
})

describe('pathSegments', () => {
  it('splits and decodes', () => {
    expect(pathSegments('/')).toEqual([])
    expect(pathSegments('/a/b%2Ec')).toEqual(['a', 'b.c'])
    expect(pathSegments('/a/')).toEqual(['a'])
  })

  it('refuses anything that could leave the root or name nothing', () => {
    for (const p of ['a', '/../x', '/a/../b', '/./a', '/a//b', '/a%2Fb', '/a%00', '/%E0%A4%A']) {
      expect(pathSegments(p)).toBeUndefined()
    }
  })
})
