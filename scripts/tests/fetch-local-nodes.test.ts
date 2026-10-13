import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENDPOINTS } from '../../src/main/verifier/endpoints.js'
import { NODE_FOLDER, dirVariable, dohEndpointsFrom, exitCodeFor, fetchLocalNode, fetchLocalNodes, gatewaysFrom, localNodeNames, notPublished } from '../fetch-local-nodes.mjs'

const GLUE = Buffer.from('a pretend glue')
const CORE = Buffer.from('a pretend core module')
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const MANIFEST = (cid: string): string => JSON.stringify({
  cid,
  name: 'swarm-node',
  files: [
    { name: 'swarm-node.js', bytes: GLUE.length, sha256: digest(GLUE) },
    { name: 'swarm-node.core.wasm', bytes: CORE.length, sha256: digest(CORE) }
  ]
})
const GATEWAYS = ['https://one.example', 'https://two.example']

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fetch-local-node-'))
  await writeFile(join(dir, 'swarm-node.json'), MANIFEST('bafyexample'))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const bufferOf = (bytes: Buffer): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer
const FILES: Record<string, Buffer> = { 'swarm-node.js': GLUE, 'swarm-node.core.wasm': CORE }

/** A gateway set where `answer` decides what each URL gives. */
function gateways (answer: (url: string) => Buffer | number) {
  return vi.fn(async (url: string, _init?: object) => {
    const given = answer(url)
    return typeof given === 'number'
      ? { ok: false, status: given, arrayBuffer: async () => new ArrayBuffer(0) }
      : { ok: true, status: 200, arrayBuffer: async () => bufferOf(given) }
  })
}

const served = (url: string): Buffer | number => FILES[url.split('/').pop() as string] ?? 404

describe('fetchLocalNode', () => {
  it('keeps files that match their pins, asks the directory by CID, and asks nobody again once they are there', async () => {
    const fetchImpl = gateways(served)
    expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
    expect(await readFile(join(dir, 'swarm-node.core.wasm'))).toEqual(CORE)
    expect(fetchImpl).toHaveBeenCalledWith('https://one.example/ipfs/bafyexample/swarm-node.js', expect.anything())
    const calls = fetchImpl.mock.calls.length
    expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(fetchImpl.mock.calls.length).toBe(calls)
  })

  it('fetches again a file whose bytes were changed', async () => {
    await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl: gateways(served) })
    await writeFile(join(dir, 'swarm-node.core.wasm'), 'tampered')
    const fetchImpl = gateways(served)
    expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await readFile(join(dir, 'swarm-node.core.wasm'))).toEqual(CORE)
  })

  it('goes to the next gateway when one fails or answers something else', async () => {
    const fetchImpl = gateways((url) => url.startsWith('https://one.example') ? Buffer.from('a fallback page') : served(url))
    expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
  })

  it('keeps nothing from a file whose hash differs on every gateway, and names each gateway', async () => {
    const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl: gateways((url) => url.endsWith('.wasm') ? Buffer.from('tampered') : served(url)) })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('swarm-node.core.wasm')
    expect(failures[0]).toContain('https://one.example')
    expect(failures[0]).toContain('https://two.example')
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['swarm-node.js', 'swarm-node.json']))
    expect(await readdir(dir)).not.toContain('swarm-node.core.wasm')
    expect(await readdir(dir)).not.toContain('swarm-node.core.wasm.download')
  })

  it('reports an HTTP failure on every gateway as one line', async () => {
    const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl: gateways(() => 503) })
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('HTTP 503')
  })

  describe('when no request reaches a gateway by its name', () => {
    const DOH = ['https://doh.example/dns-query']
    /** Gateways no request reaches by name (a network whose DNS hijacks them), and a DNS-over-HTTPS endpoint answering from `answers`. */
    const hijacked = (answers: Record<string, unknown>) => vi.fn(async (url: string, _init?: object) => {
      const asked = new URL(url)
      if (asked.host !== 'doh.example') throw new TypeError('fetch failed')
      const body = Buffer.from(JSON.stringify(answers[asked.searchParams.get('name') ?? ''] ?? { Status: 3 }))
      return { ok: true, status: 200, arrayBuffer: async () => bufferOf(body) }
    })
    const fromAddress = (answer: (url: string) => Buffer | number) => vi.fn(async (url: string, _address: string, _init?: object) => {
      const given = answer(url)
      return typeof given === 'number'
        ? { ok: false, status: given, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => bufferOf(given) }
    })

    it('asks DNS-over-HTTPS for the gateway\'s address and fetches from that address', async () => {
      const fetchImpl = hijacked({ 'one.example': { Status: 0, Answer: [{ type: 5, data: 'alias.example.' }, { type: 1, data: '192.0.2.7' }] } })
      const addressFetch = fromAddress(served)
      expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, dohEndpoints: DOH, fetchImpl, addressFetch })).toEqual([])
      expect(await readFile(join(dir, 'swarm-node.core.wasm'))).toEqual(CORE)
      expect(fetchImpl).toHaveBeenCalledWith('https://doh.example/dns-query?name=one.example&type=A', expect.anything())
      expect(addressFetch).toHaveBeenCalledWith('https://one.example/ipfs/bafyexample/swarm-node.js', '192.0.2.7', expect.anything())
    })

    it('asks DNS-over-HTTPS once per gateway, not once per file', async () => {
      const fetchImpl = hijacked({ 'one.example': { Status: 0, Answer: [{ type: 1, data: '192.0.2.7' }] } })
      await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, dohEndpoints: DOH, fetchImpl, addressFetch: fromAddress(served) })
      expect(fetchImpl.mock.calls.filter(([url]) => url.startsWith('https://doh.example')).length).toBe(1)
    })

    it('still checks every hash of a file fetched from an address', async () => {
      const fetchImpl = hijacked({ 'one.example': { Status: 0, Answer: [{ type: 1, data: '192.0.2.7' }] }, 'two.example': { Status: 0, Answer: [{ type: 1, data: '192.0.2.8' }] } })
      const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, dohEndpoints: DOH, fetchImpl, addressFetch: fromAddress((url) => url.endsWith('.wasm') ? Buffer.from('tampered') : served(url)) })
      expect(failures).toEqual([expect.stringContaining('swarm-node.core.wasm')])
      expect(failures[0]).toContain('not the pinned file')
      expect(await readdir(dir)).not.toContain('swarm-node.core.wasm')
    })

    it('never asks DNS-over-HTTPS about a gateway that answered over HTTP', async () => {
      const fetchImpl = gateways(() => 503)
      const addressFetch = fromAddress(served)
      expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, dohEndpoints: DOH, fetchImpl, addressFetch })).toHaveLength(2)
      expect(fetchImpl.mock.calls.map(([url]) => new URL(url).host)).not.toContain('doh.example')
      expect(addressFetch).not.toHaveBeenCalled()
    })

    it('names both tries when DNS-over-HTTPS has no address either', async () => {
      const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, dohEndpoints: DOH, fetchImpl: hijacked({}), addressFetch: fromAddress(served) })
      expect(failures).toHaveLength(2)
      expect(failures[0]).toContain('https://one.example: fetch failed')
      expect(failures[0]).toContain('https://one.example by DNS-over-HTTPS: no address for one.example')
      expect(failures[0]).toContain('DNS status 3')
    })
  })

  it('says the node is not published, and asks nobody, while the manifest has a placeholder CID', async () => {
    await writeFile(join(dir, 'swarm-node.json'), MANIFEST('PLACEHOLDER-NOT-PUBLISHED'))
    const fetchImpl = gateways(served)
    const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', gateways: GATEWAYS, fetchImpl, local: '' })
    expect(failures).toEqual([notPublished('swarm-node')])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('from a local directory', () => {
    let source: string
    beforeEach(async () => {
      source = await mkdtemp(join(tmpdir(), 'fetch-local-node-source-'))
      await writeFile(join(source, 'swarm-node.js'), GLUE)
      await writeFile(join(source, 'swarm-node.core.wasm'), CORE)
    })
    afterEach(async () => { await rm(source, { recursive: true, force: true }) })

    it('copies the files, even while the CID is a placeholder, without the network', async () => {
      await writeFile(join(dir, 'swarm-node.json'), MANIFEST('PLACEHOLDER-NOT-PUBLISHED'))
      const fetchImpl = gateways(() => 500)
      expect(await fetchLocalNode({ directory: dir, name: 'swarm-node', local: source, gateways: GATEWAYS, fetchImpl })).toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
    })

    it('still checks every hash', async () => {
      await writeFile(join(source, 'swarm-node.core.wasm'), 'tampered')
      const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', local: source, gateways: GATEWAYS, fetchImpl: gateways(() => 500) })
      expect(failures).toEqual([expect.stringContaining('swarm-node.core.wasm')])
      expect(await readdir(dir)).not.toContain('swarm-node.core.wasm')
    })

    it('reports a file the directory does not hold', async () => {
      await rm(join(source, 'swarm-node.js'))
      const failures = await fetchLocalNode({ directory: dir, name: 'swarm-node', local: source, gateways: GATEWAYS, fetchImpl: gateways(() => 500) })
      expect(failures).toEqual([expect.stringContaining('swarm-node.js')])
    })
  })
})

describe('gatewaysFrom', () => {
  it('reads the gateways the verifier asks from endpoints.ts, in order', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/verifier/endpoints.ts'), 'utf8')
    expect(gatewaysFrom(source)).toEqual([...DEFAULT_ENDPOINTS.gateways])
  })

  it('refuses a source with none', () => {
    expect(() => gatewaysFrom('export const x = 1')).toThrow(/no gateways/)
  })
})

describe('dohEndpointsFrom', () => {
  it('reads the DNS-over-HTTPS endpoints the verifier asks from endpoints.ts, in order', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/verifier/endpoints.ts'), 'utf8')
    expect(dohEndpointsFrom(source)).toEqual([...DEFAULT_ENDPOINTS.dnsOverHttps])
  })

  it('refuses a source with none', () => {
    expect(() => dohEndpointsFrom('export const x = 1')).toThrow(/no DNS-over-HTTPS endpoints/)
  })
})

describe('exitCodeFor', () => {
  it('lets a package be built, without the node, while the manifest has no CID', () => {
    expect(exitCodeFor([notPublished('swarm-node')], true)).toBe(0)
    expect(exitCodeFor([notPublished('swarm-node')], false)).toBe(0)
  })

  it('fails a required fetch for any other failure, and only a required one', () => {
    expect(exitCodeFor(['could not get swarm-node.js: HTTP 503'], true)).toBe(1)
    expect(exitCodeFor([notPublished('swarm-node'), 'could not get swarm-node.js: HTTP 503'], true)).toBe(1)
    expect(exitCodeFor(['could not get swarm-node.js: HTTP 503'], false)).toBe(0)
    expect(exitCodeFor([], true)).toBe(0)
  })
})

describe('fetchLocalNodes', () => {
  let resources: string
  const GLUE_B = Buffer.from('the second node glue')
  beforeEach(async () => {
    resources = await mkdtemp(join(tmpdir(), 'fetch-local-nodes-'))
    for (const folder of ['swarm-node', 'other-node', 'lookup-relay-node', 'nym-tunnel', 'not-a-node-folder', 'tunnel-not', 'default-profile']) await mkdir(join(resources, folder))
    await writeFile(join(resources, 'swarm-node', 'swarm-node.json'), MANIFEST('bafyexample'))
    await writeFile(join(resources, 'other-node', 'other-node.json'), JSON.stringify({ cid: 'bafyother', name: 'other-node', files: [{ name: 'other-node.js', bytes: GLUE_B.length, sha256: digest(GLUE_B) }] }))
    await writeFile(join(resources, 'lookup-relay-node', 'lookup-relay-node.json'), JSON.stringify({ cid: 'bafylookup', name: 'lookup-relay-node', files: [] }))
    await writeFile(join(resources, 'nym-tunnel', 'nym-tunnel.json'), JSON.stringify({ cid: 'bafynym', name: 'nym-tunnel', files: [] }))
    await writeFile(join(resources, 'not-a-node-folder', 'not-a-node-folder.json'), '{}')
    await writeFile(join(resources, 'tunnel-not', 'tunnel-not.json'), '{}')
  })
  afterEach(async () => { await rm(resources, { recursive: true, force: true }) })

  it('finds every folder named <name>-node or <name>-tunnel that holds its manifest, a name of several words included', () => {
    expect(localNodeNames(resources)).toEqual(['lookup-relay-node', 'nym-tunnel', 'other-node', 'swarm-node'])
  })

  it('fetches the files of each node into its own folder', async () => {
    const fetchImpl = gateways((url) => url.endsWith('other-node.js') ? GLUE_B : served(url))
    expect(await fetchLocalNodes({ resources, gateways: GATEWAYS, fetchImpl, local: '' })).toEqual([])
    expect(await readFile(join(resources, 'other-node', 'other-node.js'))).toEqual(GLUE_B)
    expect(await readFile(join(resources, 'swarm-node', 'swarm-node.js'))).toEqual(GLUE)
    expect(fetchImpl).toHaveBeenCalledWith('https://one.example/ipfs/bafyother/other-node.js', expect.anything())
  })

  it('names the node a failure belongs to, and goes on to the others', async () => {
    const failures = await fetchLocalNodes({ resources, gateways: GATEWAYS, fetchImpl: gateways((url) => url.endsWith('other-node.js') ? 503 : served(url)), local: '' })
    expect(failures).toHaveLength(1)
    expect(failures.every((failure) => failure.startsWith('other-node: could not get other-node.js'))).toBe(true)
    expect(await readFile(join(resources, 'swarm-node', 'swarm-node.js'))).toEqual(GLUE)
  })

  it('reads each node\'s local directory from the variable named after it', () => {
    expect(dirVariable('swarm-node')).toBe('ORIVON_SWARM_NODE_DIR')
    expect(dirVariable('other-node')).toBe('ORIVON_OTHER_NODE_DIR')
    expect(dirVariable('nym-tunnel')).toBe('ORIVON_NYM_TUNNEL_DIR')
  })
})

describe('the Nym tunnel\'s manifest', () => {
  const resources = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources')
  const manifest = JSON.parse(readFileSync(join(resources, 'nym-tunnel', 'nym-tunnel.json'), 'utf8')) as { cid: string, name: string, files: Array<{ name: string, bytes: number, sha256: string }> }

  it('is found by the fetch script, in a folder the rule accepts', () => {
    expect(NODE_FOLDER.test('nym-tunnel')).toBe(true)
    expect(NODE_FOLDER.test('nym-tunnels')).toBe(false)
    expect(localNodeNames(resources)).toContain('nym-tunnel')
  })

  it('names itself like its folder, pins a CIDv1 directory, and pins each file by size and sha256', () => {
    expect(manifest.name).toBe('nym-tunnel')
    expect(manifest.cid).toMatch(/^bafy[a-z2-7]{50,}$/)
    expect(manifest.files.map((file) => file.name)).toEqual(['smolmix_wasm.js', 'smolmix_wasm_bg.wasm', 'smolmix_wasm.d.ts', 'LICENSE', 'THIRD_PARTY_LICENSES', 'README.md'])
    for (const file of manifest.files) {
      expect(Number.isInteger(file.bytes) && file.bytes > 0).toBe(true)
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
