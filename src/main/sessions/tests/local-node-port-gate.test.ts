import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reachesLocalNode, requestsHeldPort } from '../local-node-ports.js'

interface Registered {
  readonly filter: { urls: string[] }
  readonly matches: (url: string) => boolean
  readonly run: (details: { url: string }, current: object) => Promise<object>
}
const registered = vi.hoisted(() => ({ runs: [] as Registered[] }))

vi.mock('electron', () => ({ app: { on: vi.fn() }, session: { defaultSession: {} } }))
vi.mock('../../../loader/electron/serve.js', () => ({ forEachAppSession: vi.fn() }))
vi.mock('../web-request-owner.js', () => ({
  webRequestOwnerFor: () => ({
    onBeforeRequest: (_order: number, filter: Registered['filter'], matches: Registered['matches'], run: Registered['run']) => { registered.runs.push({ filter, matches, run }); return { remove: vi.fn() } }
  })
}))

beforeEach(() => {
  registered.runs.length = 0
})

const PORTS: ReadonlySet<number> = new Set([20_123, 20_456])

/** Every way a URL can name 127.0.0.1, where Orivon's own nodes listen, or 0.0.0.0, which reaches it, or `::1`, the other address of `localhost`. */
const REACHING = [
  '127.0.0.1', '127.1', '127.0.1', '0x7f.1', '0x7f000001', '0177.0.0.1', '2130706433', '017700000001', '127.0.0.1.',
  'localhost', 'LOCALHOST', 'localhost.', 'LOCALHOST.', 'node.localhost', 'a.b.localhost', 'sub.localhost.', 'SUB.Localhost.',
  '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[0000:0000:0000:0000:0000:ffff:7f00:0001]',
  '0.0.0.0', '0', '0x0', '[::ffff:0.0.0.0]', '[::ffff:0:0]', '[0:0:0:0:0:ffff:0:0]',
  '[::1]', '[0:0:0:0:0:0:0:1]', '[0000:0000:0000:0000:0000:0000:0000:0001]'
]

/** Addresses no listener of Orivon's own nodes answers at: the rest of 127.0.0.0/8 and the unspecified IPv6 address, which are other listeners' to answer. */
const NOT_REACHING = ['127.0.0.2', '127.255.255.254', '[::]', '[::ffff:7f00:2]', '[::ffff:1:2]', '10.0.0.1', '[2001:db8::1]', 'example.com', 'localhost.example.com', 'notlocalhost', 'localhostx', 'sub.localhost.example', 'xlocalhost.com']

describe('reachesLocalNode', () => {
  it.each(REACHING.flatMap((host) => ['http', 'https', 'ws', 'wss'].map((scheme) => `${scheme}://${host}:20123/ipfs/bafy?format=raw`)))('is true for %s', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(true)
  })

  it.each(['http://127.0.0.1:20456/', 'ws://[::ffff:0:0]:20456/health', 'http://user:pw@localhost.:20123/', 'http://localhost.:020123/', 'http://LOCALHOST.:20123/#frag', 'custom://LOCALHOST.:20123/'])('is true for the second port, the rest of a URL and a scheme whose host is not lowercased by the parser: %s', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(true)
  })

  it.each(NOT_REACHING.map((host) => `http://${host}:20123/`))('is false for %s, which no listener of a node answers', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(false)
  })

  it.each([
    'http://127.0.0.1:20124/',
    'http://127.0.0.1/',
    'https://127.0.0.1/',
    'http://localhost./',
    'http://localhost.:20124/',
    'http://[::ffff:0:0]:3000/',
    'https://ipfs.orbitor.dev/ipfs/bafy',
    'http://example.com:20123/',
    'not a url',
    ''
  ])('is false for %s', (url) => {
    expect(reachesLocalNode(url, PORTS)).toBe(false)
  })

  it('is false for everything while no node holds a port', () => {
    expect(reachesLocalNode('http://127.0.0.1:20123/', new Set())).toBe(false)
    expect(reachesLocalNode('http://[::ffff:0:0]:20123/', new Set())).toBe(false)
  })
})

describe('requestsHeldPort', () => {
  it.each([
    'http://127.0.0.1:20123/',
    'https://example.com:20456/',
    'ws://[::1]:20123/',
    'http://anything.example:20123/x',
    'foo://localhost:20123/'
  ])('is true for %s, whatever the host: the host is the gate\'s to judge', (url) => {
    expect(requestsHeldPort(url, PORTS)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:20124/',
    'http://127.0.0.1/',
    'https://example.com/',
    'http://127.0.0.1:2012/',
    'file:///etc/passwd',
    'data:text/plain,hello',
    'orivon://settings/',
    'not a url',
    ''
  ])('is false for %s', (url) => {
    expect(requestsHeldPort(url, PORTS)).toBe(false)
  })

  it('is false for everything while no node holds a port', () => {
    expect(requestsHeldPort('http://127.0.0.1:20123/', new Set())).toBe(false)
  })
})

describe('the local node port gate', () => {
  it('cancels a request to a held port on any spelling of 127.0.0.1, lets every other request through, and registers once per session', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    const target = {} as never
    installLocalNodePortGate(target, () => PORTS)
    installLocalNodePortGate(target, () => PORTS)
    expect(registered.runs).toHaveLength(1)
    const { run } = registered.runs[0]!
    expect(await run({ url: 'http://127.0.0.1:20123/ipfs/x' }, { marker: 1 })).toEqual({ marker: 1, cancel: true })
    expect(await run({ url: 'ws://[::ffff:0:0]:20456/' }, { marker: 2 })).toEqual({ marker: 2, cancel: true })
    expect(await run({ url: 'http://127.0.0.1:3000/' }, { marker: 3 })).toEqual({ marker: 3 })
    expect(await run({ url: 'http://127.0.0.2:20123/' }, { marker: 4 })).toEqual({ marker: 4 })
  })

  it('takes every URL, so that no spelling depends on a match pattern, and asks first only whether the request is to a held port', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    installLocalNodePortGate({} as never, () => PORTS)
    const { filter, matches } = registered.runs.at(-1)!
    expect(filter.urls).toEqual(['<all_urls>'])
    expect(matches('http://[::ffff:0:0]:20123/')).toBe(true)
    expect(matches('https://example.com:20456/')).toBe(true)
    expect(matches('http://127.0.0.1:3000/')).toBe(false)
    expect(matches('http://127.0.0.1/')).toBe(false)
    expect(matches('file:///tmp/a')).toBe(false)
  })

  it('has the owner call the gate for every spelling that reaches a node, and for no request to another port', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    installLocalNodePortGate({} as never, () => PORTS)
    const { matches, run } = registered.runs.at(-1)!
    for (const host of REACHING) {
      const url = `http://${host}:20123/`
      expect(matches(url), url).toBe(true)
      expect(await run({ url }, {}), url).toEqual({ cancel: true })
      const other = `http://${host}:20999/`
      expect(matches(other), other).toBe(false)
    }
  })

  it('reads the ports at each request, so a node started later is covered', async () => {
    const { installLocalNodePortGate } = await import('../local-node-port-gate.js')
    const held = new Set<number>()
    installLocalNodePortGate({} as never, () => held)
    const { matches, run } = registered.runs.at(-1)!
    expect(matches('http://127.0.0.1:20999/')).toBe(false)
    expect(await run({ url: 'http://127.0.0.1:20999/' }, {})).toEqual({})
    held.add(20_999)
    expect(matches('http://127.0.0.1:20999/')).toBe(true)
    expect(await run({ url: 'http://127.0.0.1:20999/' }, {})).toEqual({ cancel: true })
  })
})
