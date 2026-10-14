import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { instantiateFrom, tourFixture } from '../../../shim/wasi-p2/tests/support/component-fixture.js'
import { hasJspi, jspiWebAssembly } from '../../../shim/wasi/tests/support/jspi.js'
import type { NodeKind, ReadinessDeps } from '../kind.js'
import type { FromNode, LocalNodeConfig, PinnedFile } from '../protocol.js'
import { startNode } from '../service.js'

// A kind that is nothing like the Swarm node: no YAML, a readiness it announces itself.

let directory: string
const posted: FromNode[] = []
const post = (message: FromNode): void => { posted.push(message) }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'local-node-service-'))
  posted.length = 0
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

interface Calls {
  prepared: Array<{ dataDir: string, apiPort: number }>
  argumentsFor: LocalNodeConfig[]
  watched: ReadinessDeps[]
  logged: string[]
  stopped: number
}

function secondKind (): { kind: NodeKind, record: Calls } {
  const record: Calls = { prepared: [], argumentsFor: [], watched: [], logged: [], stopped: 0 }
  const kind: NodeKind = {
    name: 'second-node',
    noun: 'second node',
    arguments: (config) => { record.argumentsFor.push(config); return ['second-node', '--serve'] },
    prepare: async (dataDir, apiPort) => { record.prepared.push({ dataDir, apiPort }) },
    watchReadiness: (deps) => {
      record.watched.push(deps)
      return { onLog: (line) => { record.logged.push(line) }, stop: () => { record.stopped += 1 } }
    }
  }
  return { kind, record }
}

function configOf (files: readonly PinnedFile[]): LocalNodeConfig {
  return { kind: 'second-node', apiPort: 31_337, dataDir: join(directory, 'data'), componentDir: join(directory, 'component'), componentName: 'second-node', files }
}

async function install (): Promise<PinnedFile[]> {
  const component = join(directory, 'component')
  await mkdir(component)
  const fixture = tourFixture()
  const glue = Buffer.from(fixture.glue)
  await writeFile(join(component, 'second-node.js'), glue)
  const pins: PinnedFile[] = [{ name: 'second-node.js', bytes: glue.length, sha256: createHash('sha256').update(glue).digest('hex') }]
  for (const [file, bytes] of fixture.cores) {
    await writeFile(join(component, file), bytes)
    pins.push({ name: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return pins
}

const seams = { instantiate: async (glue: string) => instantiateFrom(glue, jspiWebAssembly), wasm: jspiWebAssembly }

describe('startNode, for a second kind of node', () => {
  it('lets the kind prepare the data directory for this port before the component is looked for', async () => {
    const { kind, record } = secondKind()
    await expect(startNode(kind, configOf([{ name: 'second-node.js', bytes: 1, sha256: 'a'.repeat(64) }]), { post })).rejects.toThrow()
    expect(record.prepared).toEqual([{ dataDir: join(directory, 'data'), apiPort: 31_337 }])
    expect(posted).toEqual([{ type: 'failed', stage: 'compile', message: expect.stringContaining('ENOENT') as string }])
    expect(record.watched).toEqual([])
  })

  it('posts why when the node\'s files or network cannot be set up, so main never waits on a node that cannot start', async () => {
    const { kind, record } = secondKind()
    await writeFile(join(directory, 'blocker'), 'a file where the data directory should be')
    const config = { ...configOf([{ name: 'second-node.js', bytes: 1, sha256: 'a'.repeat(64) }]), dataDir: join(directory, 'blocker', 'data') }
    await expect(startNode(kind, config, { post })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'start', message: expect.stringMatching(/could not set up the node's files and network: .*(ENOTDIR|EEXIST)/) as string }])
    expect(record.watched).toEqual([])
  })

  it('refuses a file that is not the pinned one, whatever the kind', async () => {
    const { kind } = secondKind()
    const files = await install()
    await writeFile(join(directory, 'component', 'second-node.js'), `${tourFixture().glue}\n// changed after it was pinned`)
    await expect(startNode(kind, configOf(files), { post, loader: seams })).rejects.toThrow()
    expect(posted).toEqual([{ type: 'failed', stage: 'artifact', message: expect.stringContaining('is not the file this build pins') as string }])
  })

  it.skipIf(!hasJspi)("runs the kind's arguments and readiness, passes the log to it, and stops it with the node", async () => {
    const { kind, record } = secondKind()
    const files = await install()
    const config = configOf(files)
    const node = await startNode(kind, config, { post, pollEveryMs: 10_000, loader: seams })
    expect(await node.finished).toBe(1)
    expect(record.argumentsFor).toEqual([config])
    expect(record.watched).toHaveLength(1)
    expect(record.watched[0]).toMatchObject({ base: 'http://127.0.0.1:31337', everyMs: 10_000 })
    expect(record.logged).toContain('done')
    expect(record.stopped).toBe(0)
    node.stop()
    expect(record.stopped).toBe(1)
    expect(posted).toEqual([{ type: 'failed', stage: 'run', message: 'the node stopped with exit code 1: done' }])
  })

  it.skipIf(!hasJspi)("passes the readiness a kind posts on to main", async () => {
    const { kind } = secondKind()
    const files = await install()
    const announcing: NodeKind = { ...kind, watchReadiness: (deps) => { deps.post({ type: 'listening' }); deps.post({ type: 'ready', peers: 0 }); return { stop: () => {} } } }
    const node = await startNode(announcing, configOf(files), { post, loader: seams })
    await node.finished
    node.stop()
    expect(posted.slice(0, 2)).toEqual([{ type: 'listening' }, { type: 'ready', peers: 0 }])
  })
})
