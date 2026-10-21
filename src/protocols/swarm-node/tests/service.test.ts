import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { instantiateFrom, listenerFixture, tourFixture } from '../../../shim/wasi-p2/tests/support/component-fixture.js'
import { hasJspi, jspiWebAssembly } from '../../../shim/wasi/tests/support/jspi.js'
import { CONFIG_FILE } from '../config.js'
import { SWARM_NODE } from '../kind.js'
import { MAX_FAILURE_MESSAGE } from '../../local-node/protocol.js'
import type { FromNode, LocalNodeConfig, PinnedFile } from '../../local-node/protocol.js'
import { startNode } from '../../local-node/service.js'

let directory: string
const posted: FromNode[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'swarm-node-service-'))
  posted.length = 0
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function configOf (overrides: Partial<LocalNodeConfig> = {}): LocalNodeConfig {
  return { kind: 'swarm-node', apiPort: 24_242, dataDir: join(directory, 'data'), componentDir: join(directory, 'component'), componentName: 'swarm-node', files: [], ...overrides }
}

const post = (message: FromNode): void => { posted.push(message) }

describe('startNode, for the Swarm node', () => {
  it('posts a compile failure, and throws, when the component is not there', async () => {
    await expect(startNode(SWARM_NODE, configOf({ files: [{ name: 'swarm-node.js', bytes: 1, sha256: 'a'.repeat(64) }] }), { post })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'compile', message: expect.stringContaining('ENOENT') as string }])
  })

  it('posts a start failure when the data directory cannot be made', async () => {
    await writeFile(join(directory, 'file'), '')
    await expect(startNode(SWARM_NODE, configOf({ dataDir: join(directory, 'file', 'data') }), { post })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'start', message: expect.stringContaining('data directory') as string }])
  })

  /** A fixture installed as the component, with the pins a build would hold for it. */
  async function install (fixture: { glue: string, cores: ReadonlyMap<string, Uint8Array> } = tourFixture()): Promise<PinnedFile[]> {
    const component = join(directory, 'component')
    await mkdir(component)
    const glue = Buffer.from(fixture.glue)
    await writeFile(join(component, 'swarm-node.js'), glue)
    const pins: PinnedFile[] = [{ name: 'swarm-node.js', bytes: glue.length, sha256: createHash('sha256').update(glue).digest('hex') }]
    for (const [file, bytes] of fixture.cores) {
      await writeFile(join(component, file), bytes)
      pins.push({ name: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    return pins
  }

  const seams = { instantiate: async (glue: string) => instantiateFrom(glue, jspiWebAssembly), wasm: jspiWebAssembly }

  it('posts an artifact failure, not a compile one, when a file is not the pinned one', async () => {
    const files = await install()
    await writeFile(join(directory, 'component', 'swarm-node.js'), `${tourFixture().glue}\n// changed after it was pinned`)
    await expect(startNode(SWARM_NODE, configOf({ files }), { post, loader: seams })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'artifact', message: expect.stringContaining('is not the file this build pins') as string }])
  })

  it('cuts a failure message to the length main accepts', async () => {
    const files = await install()
    await writeFile(join(directory, 'component', 'swarm-node.js'), 'x')
    const hugeName = `swarm-node-${'x'.repeat(5_000)}`
    await expect(startNode(SWARM_NODE, configOf({ files, componentName: hugeName }), { post, loader: seams })).rejects.toThrow()
    const failed = posted[0] as { message: string }
    expect(failed.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE)
    expect(failed.message.length).toBeGreaterThan(100)
  })

  it.skipIf(!hasJspi)("writes the node's config, passes its log lines on, and says why the component ended", async () => {
    const files = await install()
    const lines: string[] = []
    const node = await startNode(SWARM_NODE, configOf({ files }), {
      post,
      onLog: (line) => lines.push(line),
      pollEveryMs: 10_000,
      fetcher: async () => { throw new Error('refused') },
      loader: seams
    })
    expect(await node.finished).toBe(1)
    node.stop()
    expect(await readFile(join(directory, 'data', CONFIG_FILE), 'utf8')).toContain('api-addr: 127.0.0.1:24242')
    expect(lines).toContain('done')
    expect(posted).toEqual([{ type: 'failed', stage: 'run', message: 'the node stopped with exit code 1: done' }])
  })

  it.skipIf(!hasJspi)('says the port was taken, whatever the node printed, when the listen on its API port failed', async () => {
    const files = await install(listenerFixture())
    const taken = Object.assign(new Error('no free port in the granted range'), { code: 'limit', platformCode: 'EADDRINUSE' })
    const node = await startNode(SWARM_NODE, configOf({ files, apiPort: 8912 }), {
      post,
      pollEveryMs: 10_000,
      fetcher: async () => { throw new Error('refused') },
      net: { dial: async () => { throw taken }, listen: async () => { throw taken }, bind: async () => { throw taken }, lookup: async () => [] },
      loader: seams
    })
    await node.finished
    node.stop()
    expect(posted).toEqual([{ type: 'failed', stage: 'port', message: 'its API port 8912 is taken by another program' }])
  })
})
