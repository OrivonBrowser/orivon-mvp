import { describe, expect, it } from 'vitest'
import { concat, hexToBytes, keccak256, toBytes } from 'viem'
import { openFile, readWhole } from '../joiner.js'
import { decodeNode, lookup } from '../mantaray.js'
import type { LoadNode, ManifestNode } from '../mantaray.js'
import { buildManifest } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { SWARM_ETH } from './live-vectors.js'

const LIMITS = { maxBytes: 1024 * 1024, maxTreeDepth: 8 }
const VERSION_02 = keccak256(toBytes('mantaray:0.2'), 'bytes').subarray(0, 31)
const FILE = 'ab'.repeat(32)

/** Loads a node the way the gatherer does: its file, whole, then decoded. */
function loaderOver (chunks: ReadonlyMap<string, Uint8Array>): LoadNode & { loaded: string[] } {
  const loaded: string[] = []
  const load = async (reference: string): Promise<ManifestNode> => {
    loaded.push(reference)
    const file = await openFile(async (address) => {
      const chunk = chunks.get(address)
      if (chunk === undefined) throw new Error(`no chunk ${address}`)
      return chunk
    }, reference, LIMITS)
    return decodeNode(await readWhole(file, LIMITS.maxBytes))
  }
  return Object.assign(load, { loaded })
}

const live = new Map(Object.entries(SWARM_ETH.chunks).map(([address, data]) => [address, hexToBytes(`0x${data}`)]))

interface RawFork { readonly type: number, readonly prefix: Uint8Array, readonly prefixLength?: number, readonly metadata?: Uint8Array, readonly key?: number }

/** A node written byte by byte, for the shapes the encoder never produces. */
function rawNode (forks: RawFork[], options: { readonly version?: Uint8Array, readonly referenceBytes?: number, readonly obfuscationKey?: Uint8Array } = {}): Uint8Array {
  const bitmap = new Uint8Array(32)
  const parts: Uint8Array[] = []
  for (const fork of forks) {
    const key = fork.key ?? fork.prefix[0]!
    bitmap[key >> 3] = bitmap[key >> 3]! | (1 << (key & 7))
    const padded = new Uint8Array(30)
    padded.set(fork.prefix.subarray(0, 30))
    parts.push(Uint8Array.of(fork.type, fork.prefixLength ?? fork.prefix.length), padded, hexToBytes(`0x${FILE}`))
    if (fork.metadata !== undefined) parts.push(Uint8Array.of(fork.metadata.length >> 8, fork.metadata.length & 255), fork.metadata)
  }
  const body = concat([options.version ?? VERSION_02, Uint8Array.of(options.referenceBytes ?? 32), new Uint8Array(32), bitmap, ...parts])
  const key = options.obfuscationKey ?? new Uint8Array(32)
  return concat([key, body.map((byte, i) => byte ^ key[i % 32]!)])
}

describe('decodeNode, on the nodes of swarm.eth', () => {
  it('reads the feed manifest: one fork on "/" whose metadata names the feed', async () => {
    const node = await loaderOver(live)(SWARM_ETH.feedManifestRoot)
    const fork = node.forks.get('/'.charCodeAt(0))
    expect(new TextDecoder().decode(fork?.prefix)).toBe('/')
    expect(fork?.metadata).toEqual({
      'swarm-feed-owner': SWARM_ETH.feedOwner,
      'swarm-feed-topic': SWARM_ETH.feedTopic,
      'swarm-feed-type': 'Sequence'
    })
  })

  it('finds the index document on "/" of the site the feed points at, and its entry', async () => {
    const load = loaderOver(live)
    const root = await lookup(SWARM_ETH.siteRoot, '/', load, 256)
    expect(root?.metadata?.['website-index-document']).toBe('index.html')
    const index = await lookup(SWARM_ETH.siteRoot, 'index.html', load, 256)
    expect(index?.entry).toBe(SWARM_ETH.indexHtml.reference)
    expect(index?.metadata?.['Content-Type']).toMatch(/^text\/html/)
  })

  it('answers undefined for a path no fork continues', async () => {
    expect(await lookup(SWARM_ETH.siteRoot, 'nothing-here', loaderOver(live), 256)).toBeUndefined()
  })

  it('reads the metadata on the way without loading the last node', async () => {
    const load = loaderOver(live)
    const root = await lookup(SWARM_ETH.siteRoot, '/', load, 256, false)
    expect(root?.metadata?.['website-index-document']).toBe('index.html')
    expect(load.loaded).toEqual([SWARM_ETH.siteRoot])
  })
})

describe('decodeNode', () => {
  it('reads a node with a non-zero obfuscation key and two forks, one with padded metadata', () => {
    const node = decodeNode(rawNode([
      { type: 2 | 16, prefix: toBytes('a'), metadata: toBytes('{"Content-Type":"text/css","n":7}\n\n\n\n') },
      { type: 2, prefix: toBytes('b/c') }
    ], { obfuscationKey: Uint8Array.from({ length: 32 }, (_, i) => 200 + i) }))
    expect([...node.forks.keys()]).toEqual([97, 98])
    expect(node.forks.get(97)?.metadata).toEqual({ 'Content-Type': 'text/css' })
    expect(new TextDecoder().decode(node.forks.get(98)?.prefix)).toBe('b/c')
    expect(node.forks.get(98)?.reference).toBe(FILE)
    expect(node.entry).toBeUndefined()
  })

  it('reads prefixes of 1 and of 30 bytes', () => {
    const node = decodeNode(rawNode([{ type: 2, prefix: toBytes('x') }, { type: 2, prefix: toBytes('y'.repeat(30)) }]))
    expect(node.forks.get(120)?.prefix).toHaveLength(1)
    expect(node.forks.get(121)?.prefix).toHaveLength(30)
  })

  it('refuses a prefix length of 0 or 31, and a fork filed under the wrong byte', () => {
    expect(() => decodeNode(rawNode([{ type: 2, prefix: toBytes('a'), prefixLength: 0 }]))).toThrow(/prefix of 0 bytes/)
    expect(() => decodeNode(rawNode([{ type: 2, prefix: toBytes('a'), prefixLength: 31 }]))).toThrow(/prefix of 31 bytes/)
    expect(() => decodeNode(rawNode([{ type: 2, prefix: toBytes('a'), key: 98 }]))).toThrow(/another byte/)
  })

  it('refuses a node cut short anywhere', () => {
    const whole = rawNode([{ type: 2 | 16, prefix: toBytes('a'), metadata: toBytes('{"k":"v"}') }, { type: 2, prefix: toBytes('b') }])
    for (const length of [0, 10, 63, 90, 127, 128, 130, 160, 166, 170, whole.length - 70, whole.length - 1]) {
      if (length >= whole.length) continue
      expect(() => decodeNode(whole.subarray(0, length)), String(length)).toThrow(expect.objectContaining({ failure: expect.stringMatching(/unverifiable|unsupported/) }))
    }
    expect(() => decodeNode(whole.subarray(0, whole.length - 1))).toThrow(/cut short/)
  })

  it('refuses metadata that is not a JSON object, and keeps only its string values', () => {
    expect(() => decodeNode(rawNode([{ type: 2 | 16, prefix: toBytes('a'), metadata: toBytes('not json') }]))).toThrow(/not JSON/)
    expect(() => decodeNode(rawNode([{ type: 2 | 16, prefix: toBytes('a'), metadata: toBytes('["x"]') }]))).toThrow(/not an object/)
    const node = decodeNode(rawNode([{ type: 2 | 16, prefix: toBytes('a'), metadata: toBytes('{"a":"1","b":2,"c":null}') }]))
    expect(node.forks.get(97)?.metadata).toEqual({ a: '1' })
  })

  it('says which formats it does not read', () => {
    const v01 = keccak256(toBytes('mantaray:0.1'), 'bytes').subarray(0, 31)
    expect(() => decodeNode(rawNode([], { version: v01 }))).toThrow(expect.objectContaining({ failure: 'unsupported', message: expect.stringMatching(/0\.1/) }))
    expect(() => decodeNode(rawNode([], { referenceBytes: 64 }))).toThrow(expect.objectContaining({ failure: 'unsupported', message: expect.stringMatching(/encrypted/) }))
    expect(() => decodeNode(rawNode([], { version: new Uint8Array(31).fill(9) }))).toThrow(expect.objectContaining({ failure: 'unsupported' }))
    expect(() => decodeNode(rawNode([], { referenceBytes: 7 }))).toThrow(expect.objectContaining({ failure: 'unverifiable' }))
  })
})

describe('lookup, over manifests the encoder wrote', () => {
  const entries = [
    { path: '/', metadata: { 'website-index-document': 'home.html' } },
    { path: 'home.html', entry: 'a1'.repeat(32), metadata: { 'Content-Type': 'text/html; charset=utf-8' } },
    { path: 'docs/index.html', entry: 'a2'.repeat(32) },
    { path: 'docs/guide.html', entry: 'a3'.repeat(32) },
    { path: 'a/very/long/path/that/goes/well/past/thirty/bytes/file.txt', entry: 'a4'.repeat(32) },
    { path: 'a/very/long/path/that/goes/well/past/thirty/bytes/file.txt.map', entry: 'a5'.repeat(32) }
  ]

  for (const obfuscationKey of [undefined, Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255)]) {
    it(`finds every entry, whatever shares a prefix${obfuscationKey === undefined ? '' : ', under a non-zero obfuscation key'}`, async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildManifest(entries, store, obfuscationKey === undefined ? {} : { obfuscationKey })
      const load = loaderOver(store)
      for (const entry of entries.filter((e) => e.entry !== undefined)) expect((await lookup(root, entry.path, load, 256))?.entry, entry.path).toBe(entry.entry)
      expect((await lookup(root, '/', load, 256))?.metadata).toEqual({ 'website-index-document': 'home.html' })
      expect((await lookup(root, 'home.html', load, 256))?.metadata?.['Content-Type']).toBe('text/html; charset=utf-8')
    })
  }

  it('names a directory without an entry of its own, and refuses paths that only partly match a prefix', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildManifest(entries, store)
    const load = loaderOver(store)
    expect((await lookup(root, 'docs/', load, 256))?.entry).toBeUndefined()
    expect(await lookup(root, 'docs/missing.html', load, 256)).toBeUndefined()
    expect(await lookup(root, 'doc', load, 256)).toBeUndefined()
    expect(await lookup(root, 'home.htmlx', load, 256)).toBeUndefined()
  })

  it('refuses a path needing more nodes than the limit', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildManifest(entries, store)
    await expect(lookup(root, 'a/very/long/path/that/goes/well/past/thirty/bytes/file.txt', loaderOver(store), 2)).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('reads a long path through the chain of 30-byte prefixes it was split into', async () => {
    const store = new Map<string, Uint8Array>()
    const long = 'p'.repeat(95)
    const root = buildManifest([{ path: long, entry: 'a6'.repeat(32) }], store)
    expect((await lookup(root, long, loaderOver(store), 256))?.entry).toBe('a6'.repeat(32))
  })
})
