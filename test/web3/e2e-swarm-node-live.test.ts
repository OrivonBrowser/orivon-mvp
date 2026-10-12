// The real Swarm node, live and opt-in (ORIVON_SWARM_NODE_LIVE=1; CI never sets it): its utility process
// starts from the built app, finds peers on the public network, and answers a chunk request with bytes
// whose binary-merkle-tree hash is the address asked for. The node's files are the ones the build pins,
// or the directory ORIVON_SWARM_NODE_DIR names (a build not yet published; ORIVON_SWARM_NODE_NAME is its
// component name when that is not swarm-node). Needs `npm run build` first, and the network.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { keccak256 } from 'viem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp } from '../support/e2e-helpers.js'
import { verifyArtifact } from '../../src/main/verifier/swarm-node-artifact.js'
import type { SwarmNodeManifest } from '../../src/main/verifier/swarm-node-artifact.js'
import type { ElectronApplication } from 'playwright'

const LIVE = process.env['ORIVON_SWARM_NODE_LIVE'] === '1'
/** A chunk of the network's own content: the manifest chunk of a published site, 8 bytes of span and 384 of payload. */
const CHUNK = '03b80b08353b288c08b161fcf0e904eff3001c88006bcc7087290929197eb69f'
const READY_BY_MS = 75_000

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A chunk's address: keccak256 of its span and the root of the binary merkle tree over its payload, zero-padded to 4096 bytes in 128 segments. */
function chunkAddress (chunk: Uint8Array): string {
  const span = chunk.subarray(0, 8)
  const payload = new Uint8Array(4096)
  payload.set(chunk.subarray(8))
  let level: Uint8Array[] = Array.from({ length: 128 }, (_, index) => payload.subarray(index * 32, index * 32 + 32))
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(Buffer.from(keccak256(Buffer.concat([level[index] as Uint8Array, level[index + 1] as Uint8Array]), 'bytes')))
    }
    level = next
  }
  return keccak256(Buffer.concat([span, level[0] as Uint8Array])).slice(2)
}

async function freePort (): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => { server.close(() => { done() }) })
  return port
}

describe.skipIf(!LIVE)('the Swarm node, live', () => {
  let app: ElectronApplication | undefined
  let data: string | undefined

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'orivon-swarm-node-live-'))
  })

  afterAll(async () => {
    if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
    if (data !== undefined) await rm(data, { recursive: true, force: true })
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('finds peers and serves a chunk whose hash is its address', async () => {
    const host = resolve('out/main/swarm-node-host.js')
    expect(existsSync(host), 'run `npm run build` first').toBe(true)
    const manifest = JSON.parse(readFileSync('resources/swarm-node/swarm-node.json', 'utf8')) as SwarmNodeManifest
    const componentDir = process.env['ORIVON_SWARM_NODE_DIR'] ?? resolve('resources/swarm-node')
    const checked = await verifyArtifact(componentDir, manifest)
    expect(checked.ok, checked.ok ? '' : checked.reason).toBe(true)
    const apiPort = await freePort()

    app = await launchElectron({ chrome: false })
    const run = await app.evaluate(async ({ utilityProcess, app: electronApp }, arg) => {
      const started = Date.now()
      const child = utilityProcess.fork(arg.host, [], { serviceName: 'Swarm node live', stdio: 'ignore' })
      const timeline: Array<{ at: number, type: string, peers?: number }> = []
      let ready = false
      let failure: string | undefined
      child.on('message', (message: { type: string, count?: number, peers?: number, message?: string }) => {
        timeline.push({ at: Date.now() - started, type: message.type, ...(message.count === undefined ? {} : { peers: message.count }) })
        if (message.type === 'ready') ready = true
        if (message.type === 'failed') failure = message.message
      })
      child.postMessage({ type: 'start', config: { apiPort: arg.apiPort, dataDir: arg.data, componentDir: arg.componentDir, componentName: arg.name } })
      while (!ready && failure === undefined && Date.now() - started < arg.readyByMs) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
      let chunk: string | undefined
      let chunkMs: number | undefined
      let memoryMb: number | undefined
      if (ready) {
        const asked = Date.now()
        const response = await fetch(`http://127.0.0.1:${String(arg.apiPort)}/chunks/${arg.chunk}`, { signal: AbortSignal.timeout(20_000) })
        chunkMs = Date.now() - asked
        if (response.ok) chunk = Buffer.from(await response.arrayBuffer()).toString('hex')
        const metric = electronApp.getAppMetrics().find((entry) => entry.name === 'Swarm node live')
        memoryMb = metric === undefined ? undefined : Math.round(metric.memory.workingSetSize / 1024)
      }
      child.kill()
      return { timeline, failure, chunk, chunkMs, memoryMb }
    }, { host, apiPort, data: data as string, componentDir, name: process.env['ORIVON_SWARM_NODE_NAME'] ?? manifest.name, chunk: CHUNK, readyByMs: READY_BY_MS })

    console.log(`[swarm-node live] ${JSON.stringify({ chunkMs: run.chunkMs, memoryMb: run.memoryMb, timeline: run.timeline.filter((entry) => entry.type !== 'peers' || (entry.peers ?? 0) % 10 === 0) })}`)
    expect(run.failure).toBeUndefined()
    expect(run.timeline.map((entry) => entry.type)).toContain('listening')
    expect(run.timeline.map((entry) => entry.type)).toContain('ready')
    expect(run.chunk).toBeDefined()
    const bytes = Buffer.from(run.chunk as string, 'hex')
    expect(bytes.length).toBe(392)
    expect(chunkAddress(bytes)).toBe(CHUNK)
    expect(hex(bytes.subarray(0, 8))).toMatch(/^[0-9a-f]{16}$/)
    expect(run.memoryMb).toBeLessThan(700)
  }, 180_000)
})
