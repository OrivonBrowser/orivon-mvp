import { describe, expect, it } from 'vitest'
import { concat, hexToBytes } from 'viem'
import { openFile, readWhole } from '../joiner.js'
import type { GetChunk, JoinLimits } from '../joiner.js'
import { buildFile, makeChunk, spanBytes } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { ResolutionError } from '../../resolution/records.js'

const LIMITS: JoinLimits = { maxBytes: 1024 * 1024 * 1024, maxTreeDepth: 8 }
const LEAF = 4096

const content = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => (i * 31 + (i >> 8) * 7 + 1) & 255)

function chunksOf (store: Map<string, Uint8Array>): { get: GetChunk, fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    get: async (address) => {
      fetched.push(address)
      const chunk = store.get(address)
      if (chunk === undefined) throw new ResolutionError('unavailable', `no chunk ${address}`)
      return chunk
    }
  }
}

async function collect (generator: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of generator) parts.push(part)
  return concat(parts)
}

/**
 * A tree `depth` levels of `fanout` references over one shared leaf. The
 * joiner never hashes, so the leaf may stand for all of them and the tree
 * costs a handful of chunks whatever it claims to hold.
 */
function fabricatedTree (depth: number, fanout: number): { store: Map<string, Uint8Array>, root: string, size: number, leaf: Uint8Array } {
  const store = new Map<string, Uint8Array>()
  const leaf = content(LEAF)
  let address = '00'.repeat(32)
  store.set(address, makeChunk(spanBytes(LEAF), leaf))
  let size = LEAF
  for (let level = 1; level <= depth; level++) {
    const child = address
    size *= fanout
    address = level.toString(16).padStart(64, '0')
    store.set(address, makeChunk(spanBytes(size), concat(Array.from({ length: fanout }, () => hexToBytes(`0x${child}`)))))
  }
  return { store, root: address, size, leaf }
}

describe('openFile', () => {
  for (const size of [0, 1, 4095, LEAF, LEAF + 1, 128 * LEAF, 128 * LEAF + 1, 129 * LEAF, 130 * LEAF + 17]) {
    it(`joins a file of ${String(size)} bytes, knowing its size from the root chunk alone`, async () => {
      const store = new Map<string, Uint8Array>()
      const bytes = content(size)
      const { ref } = buildFile(bytes, store)
      const { get, fetched } = chunksOf(store)
      const file = await openFile(get, ref, LIMITS)
      expect(file.size).toBe(size)
      expect(fetched).toEqual([ref])
      expect(await collect(file.read())).toEqual(bytes)
    })
  }

  it('joins a tree several levels deep, one shared leaf standing for every leaf', async () => {
    const { store, root, size, leaf } = fabricatedTree(3, 3)
    const file = await openFile(chunksOf(store).get, root, LIMITS)
    expect(file.size).toBe(size)
    expect(await collect(file.read())).toEqual(concat(Array.from({ length: 27 }, () => leaf)))
  })

  it('reads a range, fetching only the chunks it needs and the first child of each level on the way', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(40 * LEAF)
    const { ref } = buildFile(bytes, store)
    const { get, fetched } = chunksOf(store)
    const file = await openFile(get, ref, LIMITS)
    const range = { start: 20 * LEAF + 100, end: 22 * LEAF + 9 }
    expect(await collect(file.read(range))).toEqual(bytes.subarray(range.start, range.end + 1))
    expect(fetched).toHaveLength(1 + 1 + 3)
  })

  it('reads ranges across a level boundary, the last byte and a single byte', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(129 * LEAF + 11)
    const { ref } = buildFile(bytes, store)
    const file = await openFile(chunksOf(store).get, ref, LIMITS)
    for (const range of [{ start: 128 * LEAF - 3, end: 128 * LEAF + 3 }, { start: bytes.length - 1, end: bytes.length - 1 }, { start: 0, end: 0 }, { start: 5, end: 10 * LEAF }, { start: 100, end: 1e12 }]) {
      expect(await collect(file.read(range))).toEqual(bytes.subarray(range.start, Math.min(range.end, bytes.length - 1) + 1))
    }
    expect(await collect(file.read({ start: 9, end: 3 }))).toEqual(new Uint8Array())
  })

  it('reads an erasure-coded file from its data references and never fetches a parity reference', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(20 * LEAF + 30)
    const { ref } = buildFile(bytes, store, { level: 1, parity: 5 })
    const { get, fetched } = chunksOf(store)
    const file = await openFile(get, ref, LIMITS)
    expect(file.size).toBe(bytes.length)
    expect(await collect(file.read())).toEqual(bytes)
    expect(new Set(fetched).size).toBe(store.size)
  })

  it('reads a deeper erasure-coded file, parity references at every level', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(125 * LEAF + 99)
    const { ref } = buildFile(bytes, store, { level: 3, parity: 9 })
    const { get } = chunksOf(store)
    expect(await collect((await openFile(get, ref, LIMITS)).read())).toEqual(bytes)
  })

  it('refuses a parent whose references are more than its children and carries no level', async () => {
    const store = new Map<string, Uint8Array>()
    const a = buildFile(content(LEAF), store)
    const b = buildFile(content(LEAF), store)
    const extra = buildFile(content(LEAF), store)
    const root = makeChunk(spanBytes(2 * LEAF), concat([a, b, extra].map((x) => hexToBytes(`0x${x.ref}`))))
    store.set('r', root)
    const file = await openFile(chunksOf(store).get, 'r', LIMITS)
    await expect(collect(file.read())).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('refuses a child whose own span is not what the parent says it covers', async () => {
    const store = new Map<string, Uint8Array>()
    const a = buildFile(content(LEAF), store)
    const b = buildFile(content(100), store)
    // The parent claims 2 x LEAF bytes, but its second child is a leaf of 100.
    const root = makeChunk(spanBytes(2 * LEAF), concat([a, b].map((x) => hexToBytes(`0x${x.ref}`))))
    store.set('r', root)
    const file = await openFile(chunksOf(store).get, 'r', LIMITS)
    await expect(collect(file.read())).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/100 bytes where 4096/) })
  })

  it('refuses a leaf whose payload is not its span, a ragged reference list and a childless parent', async () => {
    const store = new Map<string, Uint8Array>()
    store.set('leaf', makeChunk(spanBytes(10), new Uint8Array(9)))
    await expect(collect((await openFile(chunksOf(store).get, 'leaf', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable' })
    store.set('ragged', makeChunk(spanBytes(2 * LEAF), new Uint8Array(33)))
    await expect(collect((await openFile(chunksOf(store).get, 'ragged', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable' })
    store.set('empty', makeChunk(spanBytes(2 * LEAF), new Uint8Array()))
    await expect(collect((await openFile(chunksOf(store).get, 'empty', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('refuses a first child with no content under a parent that has some', async () => {
    const store = new Map<string, Uint8Array>()
    const zero = buildFile(new Uint8Array(), store)
    store.set('r', makeChunk(spanBytes(2 * LEAF), hexToBytes(`0x${zero.ref}`)))
    await expect(collect((await openFile(chunksOf(store).get, 'r', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('refuses a tree deeper than the limit', async () => {
    const { store, root } = fabricatedTree(9, 2)
    const file = await openFile(chunksOf(store).get, root, LIMITS)
    await expect(collect(file.read())).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/deeper than 8/) })
    const shallow = fabricatedTree(8, 2)
    expect((await collect((await openFile(chunksOf(shallow.store).get, shallow.root, LIMITS)).read())).length).toBe(shallow.size)
  })

  it('refuses a file over the byte limit before reading any of it', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(content(5 * LEAF), store)
    const { get, fetched } = chunksOf(store)
    await expect(openFile(get, ref, { ...LIMITS, maxBytes: 5 * LEAF - 1 })).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(fetched).toEqual([ref])
  })

  it('passes a failed fetch on as the error of the read that needed it', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(content(10 * LEAF), store)
    const missing = [...store.keys()].find((address) => address !== ref && store.get(address)!.length === 8 + LEAF)!
    store.delete(missing)
    const file = await openFile(chunksOf(store).get, ref, LIMITS)
    await expect(collect(file.read())).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('reads a whole file only up to a cap', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(3 * LEAF)
    const { ref } = buildFile(bytes, store)
    const file = await openFile(chunksOf(store).get, ref, LIMITS)
    expect(await readWhole(file, 3 * LEAF)).toEqual(bytes)
    await expect(readWhole(file, 3 * LEAF - 1)).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})
