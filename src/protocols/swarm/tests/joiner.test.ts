import { describe, expect, it, vi } from 'vitest'
import { bytesToHex, concat, hexToBytes } from 'viem'
import { AHEAD, openFile, readWhole } from '../joiner.js'
import type { GetChunk, GetLeaves, JoinLimits } from '../joiner.js'
import { buildFile, makeChunk, spanBytes } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { ResolutionError } from '../../resolution/records.js'
import { cacAddress, readSpan, verifyCac } from '../chunk.js'

const LIMITS: JoinLimits = { maxBytes: 1024 * 1024 * 1024, maxTreeDepth: 8 }
const LEAF = 4096
const MAX_CHUNK = 8 + LEAF

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

  it('asks for the leaves of each intermediate chunk together, and only for those a range covers', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(200 * LEAF + 5)
    const { ref } = buildFile(bytes, store)
    const asked: Array<{ parent: string, leaves: number, first: number }> = []
    const getLeaves: GetLeaves = (parent, leaves) => {
      asked.push({ parent, leaves: leaves.length, first: leaves[0]!.offset })
      return leaves.map(async (leaf) => store.get(leaf.address)!)
    }
    const file = await openFile(chunksOf(store).get, ref, LIMITS, getLeaves)
    expect(await readWhole(file, file.size)).toEqual(bytes)
    expect(asked.map((call) => call.leaves)).toEqual([128, 73])
    asked.length = 0
    expect(await collect(file.read({ start: 130 * LEAF + 1, end: 132 * LEAF }))).toEqual(bytes.subarray(130 * LEAF + 1, 132 * LEAF + 1))
    expect(asked).toEqual([{ parent: bytesToHex(store.get(ref)!.subarray(8 + 32, 8 + 64)).slice(2), leaves: 3, first: 2 * LEAF }])
  })

  it('checks a leaf asked for together against the size its parent declares, as any other', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(content(3 * LEAF), store)
    const file = await openFile(chunksOf(store).get, ref, LIMITS, (_parent, leaves) => leaves.map(async () => makeChunk(spanBytes(LEAF - 1), content(LEAF - 1))))
    await expect(collect(file.read())).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('keeps leaves in flight past the end of one intermediate chunk, never more than AHEAD of the byte read', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(200 * LEAF)
    // `content` repeats every 16 leaves; numbered leaves are 200 addresses.
    for (let i = 0; i < 200; i++) bytes[i * LEAF] = i
    const { ref } = buildFile(bytes, store)
    const leafAt =(i: number): string => Buffer.from(cacAddress(makeChunk(spanBytes(LEAF), bytes.subarray(i * LEAF, (i + 1) * LEAF)))).toString('hex')
    // The first child of each intermediate chunk is what tells the joiner its children's size: never held.
    const firsts = new Set([leafAt(0), leafAt(128)])
    const asked = new Set<string>()
    const held: Array<() => void> = []
    let holding = true
    const get: GetChunk = async (address) => {
      const chunk = store.get(address)!
      if (readSpan(chunk).size <= LEAF) {
        asked.add(address)
        if (holding && !firsts.has(address)) await new Promise<void>((resolve) => { held.push(resolve) })
      }
      return chunk
    }
    const file = await openFile(get, ref, LIMITS)
    const reading = collect(file.read({ start: 120 * LEAF, end: bytes.length - 1 }))
    await vi.waitFor(() => { expect(asked.has(leafAt(150))).toBe(true) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked.size).toBeLessThanOrEqual(AHEAD + 2)
    expect(asked.has(leafAt(199))).toBe(false)
    holding = false
    for (const release of held) release()
    expect(await reading).toEqual(bytes.subarray(120 * LEAF))
  })

  it('yields every byte before a malformed chunk further ahead, then refuses', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(200 * LEAF)
    const { ref } = buildFile(bytes, store)
    const second = Buffer.from(store.get(ref)!.subarray(8 + 32, 8 + 64)).toString('hex')
    const lying = new Uint8Array(store.get(second)!)
    lying.set(spanBytes(72 * LEAF - 1), 0)
    store.set(second, lying)
    const parts: Uint8Array[] = []
    const file = await openFile(chunksOf(store).get, ref, LIMITS)
    await expect((async () => { for await (const part of file.read()) parts.push(part) })()).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(concat(parts)).toEqual(bytes.subarray(0, 128 * LEAF))
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

describe('openFile, over zero-padded chunks', () => {
  const padTo4096 = (payload: Uint8Array): Uint8Array => concat([payload, new Uint8Array(LEAF - payload.length)])
  const hex = (chunk: Uint8Array): string => Buffer.from(cacAddress(chunk)).toString('hex')

  it('gives a payload and the same payload followed by zeros one address', () => {
    const plain = makeChunk(spanBytes(960), content(960))
    const padded = makeChunk(spanBytes(960), padTo4096(content(960)))
    expect(hex(padded)).toBe(hex(plain))
    expect(verifyCac(hex(plain), padded)).toBe(true)
  })

  it('reads a leaf stored padded to 4096 bytes as the bytes its span declares', async () => {
    const bytes = content(960)
    const chunk = makeChunk(spanBytes(960), padTo4096(bytes))
    const store = new Map([[hex(chunk), chunk]])
    const file = await openFile(chunksOf(store).get, hex(chunk), LIMITS)
    expect(file.size).toBe(960)
    expect(await readWhole(file, 960)).toEqual(bytes)
    expect(await collect(file.read({ start: 100, end: 2000 }))).toEqual(bytes.subarray(100))
  })

  it('refuses a leaf with a non-zero byte past its span', async () => {
    const padded = padTo4096(content(960))
    padded[4000] = 1
    const store = new Map([['leaf', makeChunk(spanBytes(960), padded)]])
    await expect(collect((await openFile(chunksOf(store).get, 'leaf', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/4096 bytes where 960/) })
  })

  it('reads an intermediate chunk whose reference list is followed by zeros', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(LEAF + 512)
    const a = buildFile(bytes.subarray(0, LEAF), store)
    const b = buildFile(bytes.subarray(LEAF), store)
    const list = concat([a, b].map((x) => hexToBytes(`0x${x.ref}`)))
    const root = makeChunk(spanBytes(bytes.length), padTo4096(list))
    store.set(hex(root), root)
    expect(hex(root)).toBe(hex(makeChunk(spanBytes(bytes.length), list)))
    expect(await readWhole(await openFile(chunksOf(store).get, hex(root), LIMITS), bytes.length)).toEqual(bytes)
  })

  it('refuses an intermediate chunk with a non-zero byte after its references', async () => {
    const store = new Map<string, Uint8Array>()
    const a = buildFile(content(LEAF), store)
    const b = buildFile(content(100), store)
    const dirty = padTo4096(concat([a, b].map((x) => hexToBytes(`0x${x.ref}`))))
    dirty[LEAF - 1] = 1
    store.set('dirty', makeChunk(spanBytes(LEAF + 100), dirty))
    await expect(collect((await openFile(chunksOf(store).get, 'dirty', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('refuses a padded intermediate chunk that lists fewer references than it has children, without fetching the empty one', async () => {
    const store = new Map<string, Uint8Array>()
    const a = buildFile(content(LEAF), store)
    const b = buildFile(content(LEAF).map((byte) => byte ^ 1), store)
    const list = concat([a, b].map((x) => hexToBytes(`0x${x.ref}`)))
    store.set('short', makeChunk(spanBytes(3 * LEAF), padTo4096(list)))
    const { get, fetched } = chunksOf(store)
    await expect(collect((await openFile(get, 'short', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/128 references for 3 children/) })
    expect(fetched).not.toContain('00'.repeat(32))
  })

  it('refuses a padded intermediate chunk whose references are all zero', async () => {
    const store = new Map<string, Uint8Array>()
    store.set('00'.repeat(32), makeChunk(spanBytes(LEAF), content(LEAF)))
    store.set('empty', makeChunk(spanBytes(2 * LEAF), new Uint8Array(LEAF)))
    await expect(collect((await openFile(chunksOf(store).get, 'empty', LIMITS)).read())).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/128 references for 2 children/) })
  })

  it('still reads an erasure-coded file whose intermediate chunks are padded to 4096 bytes', async () => {
    const store = new Map<string, Uint8Array>()
    const bytes = content(20 * LEAF + 30)
    const { ref } = buildFile(bytes, store, { level: 1, parity: 5 })
    for (const [address, chunk] of store) {
      if (chunk[7]! > 128) store.set(address, concat([chunk, new Uint8Array(MAX_CHUNK - chunk.length)]))
    }
    expect([...store.values()].some((chunk) => chunk[7]! > 128 && chunk.length === MAX_CHUNK)).toBe(true)
    expect(await readWhole(await openFile(chunksOf(store).get, ref, LIMITS), bytes.length)).toEqual(bytes)
  })
})
