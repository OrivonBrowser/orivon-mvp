import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { instantiateFrom, tourFixture } from '../../../shim/wasi-p2/tests/support/component-fixture.js'
import { hasJspi, jspiWebAssembly } from '../../../shim/wasi/tests/support/jspi.js'
import { CONFIG_FILE } from '../config.js'
import type { FromNode, SwarmNodeConfig } from '../protocol.js'
import { startNode } from '../service.js'

let directory: string
const posted: FromNode[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'swarm-node-service-'))
  posted.length = 0
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function configOf (overrides: Partial<SwarmNodeConfig> = {}): SwarmNodeConfig {
  return { apiPort: 24_242, dataDir: join(directory, 'data'), componentDir: join(directory, 'component'), componentName: 'swarm-node', ...overrides }
}

const post = (message: FromNode): void => { posted.push(message) }

describe('startNode', () => {
  it('posts a compile failure, and throws, when the component is not there', async () => {
    await expect(startNode(configOf(), { post })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'compile', message: expect.stringContaining('ENOENT') as string }])
  })

  it('posts a start failure when the data directory cannot be made', async () => {
    await writeFile(join(directory, 'file'), '')
    await expect(startNode(configOf({ dataDir: join(directory, 'file', 'data') }), { post })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'start', message: expect.stringContaining('data directory') as string }])
  })

  it.skipIf(!hasJspi)('writes the node\'s config, passes its log lines on, and says why the component ended', async () => {
    const component = join(directory, 'component')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(component)
    await writeFile(join(component, 'swarm-node.js'), tourFixture().glue)
    for (const [file, bytes] of tourFixture().cores) await writeFile(join(component, file), bytes)
    const lines: string[] = []
    const node = await startNode(configOf(), {
      post,
      onLog: (line) => lines.push(line),
      pollEveryMs: 10_000,
      fetcher: async () => { throw new Error('refused') },
      loader: { instantiate: async (glue) => instantiateFrom(glue, jspiWebAssembly), wasm: jspiWebAssembly }
    })
    expect(await node.finished).toBe(1)
    node.stop()
    expect(await readFile(join(directory, 'data', CONFIG_FILE), 'utf8')).toContain('api-addr: 127.0.0.1:24242')
    expect(lines).toContain('done')
    expect(posted).toEqual([{ type: 'failed', stage: 'run', message: 'the node stopped with exit code 1: done' }])
  })
})
