import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENDPOINTS } from '../../src/main/verifier/endpoints.js'
import { fetchSwarmNode, gatewaysFrom } from '../fetch-swarm-node.mjs'

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
  dir = await mkdtemp(join(tmpdir(), 'fetch-swarm-node-'))
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

describe('fetch-swarm-node', () => {
  it('keeps files that match their pins, asks the directory by CID, and asks nobody again once they are there', async () => {
    const fetchImpl = gateways(served)
    expect(await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
    expect(await readFile(join(dir, 'swarm-node.core.wasm'))).toEqual(CORE)
    expect(fetchImpl).toHaveBeenCalledWith('https://one.example/ipfs/bafyexample/swarm-node.js', expect.anything())
    const calls = fetchImpl.mock.calls.length
    expect(await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(fetchImpl.mock.calls.length).toBe(calls)
  })

  it('fetches again a file whose bytes were changed', async () => {
    await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl: gateways(served) })
    await writeFile(join(dir, 'swarm-node.core.wasm'), 'tampered')
    const fetchImpl = gateways(served)
    expect(await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await readFile(join(dir, 'swarm-node.core.wasm'))).toEqual(CORE)
  })

  it('goes to the next gateway when one fails or answers something else', async () => {
    const fetchImpl = gateways((url) => url.startsWith('https://one.example') ? Buffer.from('a fallback page') : served(url))
    expect(await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl })).toEqual([])
    expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
  })

  it('keeps nothing from a file whose hash differs on every gateway, and names each gateway', async () => {
    const failures = await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl: gateways((url) => url.endsWith('.wasm') ? Buffer.from('tampered') : served(url)) })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('swarm-node.core.wasm')
    expect(failures[0]).toContain('https://one.example')
    expect(failures[0]).toContain('https://two.example')
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['swarm-node.js', 'swarm-node.json']))
    expect(await readdir(dir)).not.toContain('swarm-node.core.wasm')
    expect(await readdir(dir)).not.toContain('swarm-node.core.wasm.download')
  })

  it('reports an HTTP failure on every gateway as one line', async () => {
    const failures = await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl: gateways(() => 503) })
    expect(failures).toHaveLength(2)
    expect(failures[0]).toContain('HTTP 503')
  })

  it('says the node is not published, and asks nobody, while the manifest has a placeholder CID', async () => {
    await writeFile(join(dir, 'swarm-node.json'), MANIFEST('PLACEHOLDER-NOT-PUBLISHED'))
    const fetchImpl = gateways(served)
    const failures = await fetchSwarmNode({ directory: dir, gateways: GATEWAYS, fetchImpl, local: '' })
    expect(failures).toEqual([expect.stringContaining('not published yet')])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('from a local directory', () => {
    let source: string
    beforeEach(async () => {
      source = await mkdtemp(join(tmpdir(), 'fetch-swarm-node-source-'))
      await writeFile(join(source, 'swarm-node.js'), GLUE)
      await writeFile(join(source, 'swarm-node.core.wasm'), CORE)
    })
    afterEach(async () => { await rm(source, { recursive: true, force: true }) })

    it('copies the files, even while the CID is a placeholder, without the network', async () => {
      await writeFile(join(dir, 'swarm-node.json'), MANIFEST('PLACEHOLDER-NOT-PUBLISHED'))
      const fetchImpl = gateways(() => 500)
      expect(await fetchSwarmNode({ directory: dir, local: source, gateways: GATEWAYS, fetchImpl })).toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(await readFile(join(dir, 'swarm-node.js'))).toEqual(GLUE)
    })

    it('still checks every hash', async () => {
      await writeFile(join(source, 'swarm-node.core.wasm'), 'tampered')
      const failures = await fetchSwarmNode({ directory: dir, local: source, gateways: GATEWAYS, fetchImpl: gateways(() => 500) })
      expect(failures).toEqual([expect.stringContaining('swarm-node.core.wasm')])
      expect(await readdir(dir)).not.toContain('swarm-node.core.wasm')
    })

    it('reports a file the directory does not hold', async () => {
      await rm(join(source, 'swarm-node.js'))
      const failures = await fetchSwarmNode({ directory: dir, local: source, gateways: GATEWAYS, fetchImpl: gateways(() => 500) })
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
