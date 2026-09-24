import { describe, expect, it } from 'vitest'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { readFileRange } from '../file-reader.js'

const blocks = new Map<string, Uint8Array>()

async function put (code: number, bytes: Uint8Array): Promise<CID> {
  const cid = CID.createV1(code, await sha256.digest(bytes))
  blocks.set(cid.toString(), bytes)
  return cid
}

async function fileNode (data: Uint8Array, links: Array<{ cid: CID, size: number }> = []): Promise<Uint8Array> {
  const unixfs = new UnixFS({ type: 'file', data, blockSizes: links.map((l) => BigInt(l.size)) })
  return dagPb.encode(dagPb.prepare({ Data: unixfs.marshal(), Links: links.map((l) => ({ Hash: l.cid, Tsize: l.size })) }))
}

const get = async (cid: CID): Promise<Uint8Array> => blocks.get(cid.toString())!

describe('readFileRange', () => {
  it('refuses a subtree larger than its parent declared before yielding any of its bytes', async () => {
    const oversized = await put(0x70, await fileNode(new Uint8Array(150).fill(0xaa)))
    const sibling = await put(0x55, new Uint8Array(100).fill(0xbb))
    const root = dagPb.decode(await fileNode(new Uint8Array(), [{ cid: oversized, size: 100 }, { cid: sibling, size: 100 }]))

    const yielded: Uint8Array[] = []
    const read = async (): Promise<void> => { for await (const chunk of readFileRange(root, get, 0, 199, { maxDagDepth: 8 })) yielded.push(chunk) }

    await expect(read()).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/150 bytes where 100 were declared/) })
    expect(yielded).toEqual([])
  })

  it('reads a range spanning a nested node and a leaf, byte for byte', async () => {
    const nested = await put(0x70, await fileNode(new Uint8Array(100).fill(0xaa)))
    const leaf = await put(0x55, new Uint8Array(100).fill(0xbb))
    const root = dagPb.decode(await fileNode(new Uint8Array(), [{ cid: nested, size: 100 }, { cid: leaf, size: 100 }]))

    const chunks: Uint8Array[] = []
    for await (const chunk of readFileRange(root, get, 90, 109, { maxDagDepth: 8 })) chunks.push(chunk)

    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.alloc(10, 0xaa), Buffer.alloc(10, 0xbb)]))
  })

  it('reads a published symlink as unsupported, never as tampering', async () => {
    const link = dagPb.decode(dagPb.encode(dagPb.prepare({ Data: new UnixFS({ type: 'symlink', data: new TextEncoder().encode('/elsewhere') }).marshal(), Links: [] })))
    const read = async (): Promise<void> => { for await (const chunk of readFileRange(link, get, 0, 9, { maxDagDepth: 8 })) void chunk }
    await expect(read()).rejects.toMatchObject({ failure: 'unsupported' })
  })
})
