import { describe, expect, it } from 'vitest'
import { IPFS_NODE_IDENTITY } from '../../../protocols/ipfs-node/protocol.js'
import type { LocalNodeManifest } from '../local-node-artifact.js'
import { createLocalNodeSubsystem } from '../local-node-subsystem.js'

const MANIFEST: LocalNodeManifest = { name: 'ipfs-node', version: '0', files: [] } as unknown as LocalNodeManifest

describe('a local node subsystem with a stand-in', () => {
  it('is ready at the stand-in\'s endpoint at once, and starts nothing', async () => {
    const node = createLocalNodeSubsystem({ kind: IPFS_NODE_IDENTITY, manifest: MANIFEST, standIn: () => ({ endpoint: 'http://127.0.0.1:9999' }) })
    expect(await node.ensure()).toMatchObject({ state: 'ready' })
    expect(node.state()).toMatchObject({ state: 'ready' })
    expect(node.endpoint()).toBe('http://127.0.0.1:9999')
  })

  it('is the ordinary node while the stand-in is absent: off until something asks, at its own port', () => {
    const node = createLocalNodeSubsystem({ kind: IPFS_NODE_IDENTITY, manifest: MANIFEST, standIn: () => undefined })
    expect(node.state()).toEqual({ state: 'off' })
    expect(node.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
