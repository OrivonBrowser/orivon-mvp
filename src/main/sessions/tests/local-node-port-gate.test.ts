import { describe, expect, it, vi } from 'vitest'
import { LOOPBACK_URL_PATTERNS, reachesLocalNode } from '../local-node-ports.js'

const registered = vi.hoisted(() => ({ runs: [] as Array<{ filter: { urls: string[] }, run: (details: { url: string }, current: object) => Promise<object> }> }))

vi.mock('electron', () => ({ app: { on: vi.fn() }, session: { defaultSession: {} } }))
vi.mock('../../../loader/electron/serve.js', () => ({ forEachAppSession: vi.fn() }))
vi.mock('../web-request-owner.js', () => ({
  webRequestOwnerFor: () => ({
    onBeforeRequest: (_order: number, filter: { urls: string[] }, _matches: unknown, run: (details: { url: string }, current: object) => Promise<object>) => { registered.runs.push({ filter, run }); return { remove: vi.fn() } }
  })
}))

const PORTS: ReadonlySet<number> = new Set([20_123, 20_456])

describe('reachesLocalNode', () => {
  it.each([
    'http://127.0.0.1:20123/ipfs/bafy?format=raw',
    'https://127.0.0.1:20123/',
    'ws://127.0.0.1:20456/',
    'http://localhost:20123/health',
    'http://LOCALHOST:20123/',
    'http://localhost.:20123/',
    'http://node.localhost:20123/',
    'http://[::1]:20123/',
    'http://[::ffff:7f00:1]:20456/',
    'http://0.0.0.0:20123/',
    'http://127.1:20123/',
    'http://2130706433:20123/'
  ])('is true for %s', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:20124/',
    'http://127.0.0.1/',
    'http://example.com:20123/',
    'https://ipfs.orbitor.dev/ipfs/bafy',
    'http://127.0.0.2:20123/',
    'not a url',
    ''
  ])('is false for %s', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(false)
  })

  it('is false for everything while no node holds a port', () => {
    expect(reachesLocalNode('http://127.0.0.1:20123/', new Set())).toBe(false)
  })

  it('has a pattern for each loopback spelling under each scheme, so each is looked at', () => {
    expect(LOOPBACK_URL_PATTERNS).toContain('http://127.0.0.1/*')
    expect(LOOPBACK_URL_PATTERNS).toContain('wss://[::1]/*')
    expect(LOOPBACK_URL_PATTERNS).toContain('https://*.localhost/*')
    expect(LOOPBACK_URL_PATTERNS).toHaveLength(24)
  })
})

describe('the local node port gate', () => {
  it('cancels a request to a held port, lets every other loopback request through, and registers once per session', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    const target = {} as never
    installLocalNodePortGate(target, () => PORTS)
    installLocalNodePortGate(target, () => PORTS)
    expect(registered.runs).toHaveLength(1)
    const { filter, run } = registered.runs[0]!
    expect(filter.urls).toEqual([...LOOPBACK_URL_PATTERNS])
    expect(await run({ url: 'http://127.0.0.1:20123/ipfs/x' }, { marker: 1 })).toEqual({ marker: 1, cancel: true })
    expect(await run({ url: 'http://127.0.0.1:3000/' }, { marker: 2 })).toEqual({ marker: 2 })
  })

  it('reads the ports at each request, so a node started later is covered', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    const held = new Set<number>()
    installLocalNodePortGate({} as never, () => held)
    const { run } = registered.runs.at(-1)!
    expect(await run({ url: 'http://127.0.0.1:20999/' }, {})).toEqual({})
    held.add(20_999)
    expect(await run({ url: 'http://127.0.0.1:20999/' }, {})).toEqual({ cancel: true })
  })
})
