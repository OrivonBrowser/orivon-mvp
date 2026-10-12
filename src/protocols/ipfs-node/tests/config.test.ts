import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeArguments, prepareDataDir, routingModeOf } from '../config.js'
import { IPFS_NODE } from '../kind.js'
import { routingOptions } from '../protocol.js'

let directory: string

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ipfs-node-config-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('routingOptions', () => {
  it('asks a lookup service and the network together when the service is allowed, and the network alone when not', () => {
    expect(routingOptions(true)).toEqual({ routingMode: 'auto' })
    expect(routingOptions(false)).toEqual({ routingMode: 'light-dht' })
  })
})

describe('routingModeOf', () => {
  it('reads the two modes, and anything else as the one that tells no service anything', () => {
    expect(routingModeOf({ routingMode: 'auto' })).toBe('auto')
    expect(routingModeOf({ routingMode: 'light-dht' })).toBe('light-dht')
    expect(routingModeOf({ routingMode: 'delegated' })).toBe('light-dht')
    expect(routingModeOf({})).toBe('light-dht')
    expect(routingModeOf(undefined)).toBe('light-dht')
  })
})

describe('nodeArguments', () => {
  it('serves on loopback at the given port, online, with the chosen routing (the two lookup services only when allowed), one database in its data directory, and quiet logs', () => {
    expect(nodeArguments({ apiPort: 24_242, options: routingOptions(true) })).toEqual([
      'ipfs-node', '--addr', '127.0.0.1:24242', '--online', '--routing-mode', 'auto',
      '--delegated-router', 'https://delegated-ipfs.dev/routing/v1,https://cid.contact/routing/v1',
      '--db', '/data/blocks.db', '--trace-filter', 'warn'
    ])
    expect(nodeArguments({ apiPort: 24_242, options: routingOptions(false) })).toEqual([
      'ipfs-node', '--addr', '127.0.0.1:24242', '--online', '--routing-mode', 'light-dht', '--db', '/data/blocks.db', '--trace-filter', 'warn'
    ])
  })

  it.each([0, -1, 65_536, 1.5, Number.NaN])('refuses the port %s', (apiPort) => {
    expect(() => nodeArguments({ apiPort })).toThrow(RangeError)
  })
})

describe('prepareDataDir', () => {
  it('makes the data directory, once or again', async () => {
    const data = join(directory, 'profile', 'ipfs-node')
    await prepareDataDir(data)
    await prepareDataDir(data)
    expect((await stat(data)).isDirectory()).toBe(true)
  })
})

describe('the kind', () => {
  it('is named for its folder and manifest, and builds its arguments from the config it is handed', () => {
    expect(IPFS_NODE).toMatchObject({ name: 'ipfs-node', noun: 'IPFS node' })
    const config = { kind: 'ipfs-node', apiPort: 20_001, dataDir: '/d', componentDir: '/c', componentName: 'ipfs-node', files: [], options: routingOptions(true) }
    expect(IPFS_NODE.arguments(config)).toEqual(nodeArguments(config))
  })
})
