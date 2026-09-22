// bundleTreeFromLeaves is the root over leaves digested elsewhere (the
// loader's streaming hasher). It must agree with bundleTree on every input
// and refuse exactly what bundleTree refuses -- the frozen vectors in
// bundle-hash.test.ts pin bundleTree itself.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, bundleTree, bundleTreeFromLeaves, leafPrefix } from '../bundle-hash.js'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

const ENTRIES = [
  { path: '/.well-known/orivon.json', content: utf8('{"orivonApiVersion":0}') },
  { path: '/index.html', content: utf8('<h1>hi</h1>') },
  { path: '/app.js', content: utf8('console.log(1)') }
]

function independentLeaf (path: string, content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(leafPrefix(path, content.length)).update(content).digest('hex')}`
}

describe('bundleTreeFromLeaves', () => {
  it('computes the same tree as bundleTree from leaves digested by a different SHA-256 implementation', async () => {
    const expected = await bundleTree(ENTRIES)
    const leaves = ENTRIES.map((entry) => ({ path: entry.path, byteLength: entry.content.length, leaf: independentLeaf(entry.path, entry.content) }))

    expect(await bundleTreeFromLeaves(leaves)).toEqual(expected)
  })

  it('refuses an over-cap byteLength without any content to hash', async () => {
    const leaves = ENTRIES.map((entry) => ({ path: entry.path, byteLength: entry.content.length, leaf: independentLeaf(entry.path, entry.content) }))
    const oversized = [...leaves, { path: '/big.wasm', byteLength: MAX_ASSET_BYTES + 1, leaf: `sha256:${'0'.repeat(64)}` }]

    await expect(bundleTreeFromLeaves(oversized)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses a leaf that is not a lowercase sha256 digest', async () => {
    const leaves = ENTRIES.map((entry) => ({ path: entry.path, byteLength: entry.content.length, leaf: `sha256:${'A'.repeat(64)}` }))

    await expect(bundleTreeFromLeaves(leaves)).rejects.toMatchObject({ code: 'invalid' })
  })
})
