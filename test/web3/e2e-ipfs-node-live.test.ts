// The real IPFS node, live and opt-in (ORIVON_IPFS_NODE_LIVE=1; CI never sets it): its utility process
// starts from the built app, answers /health, and serves a raw block whose hash is the CID asked for; then
// the shell opens an ipfs:// address with the node as its source. The node's files are the ones the build
// pins, or the directory ORIVON_IPFS_NODE_DIR names (a build not yet published; ORIVON_IPFS_NODE_NAME is its
// component name when that is not ipfs-node). Needs `npm run build` first, and the network.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { clickAddressBarRetrying, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp } from '../support/e2e-helpers.js'
import { IPFS_NODE_IDENTITY, routingOptions } from '../../src/protocols/ipfs-node/protocol.js'
import { verifyArtifact } from '../../src/main/verifier/local-node-artifact.js'
import type { LocalNodeManifest } from '../../src/main/verifier/local-node-artifact.js'
import type { ElectronApplication } from 'playwright'

const LIVE = process.env['ORIVON_IPFS_NODE_LIVE'] === '1'
/** The public gateway checker's own test content, which the network holds widely. */
const CONTENT = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const READY_BY_MS = 45_000

async function freePort (): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => { server.close(() => { done() }) })
  return port
}

describe.skipIf(!LIVE)('the IPFS node, live', () => {
  let app: ElectronApplication | undefined
  let data: string | undefined

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'orivon-ipfs-node-live-'))
  })

  afterAll(async () => {
    if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
    if (data !== undefined) await rm(data, { recursive: true, force: true })
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('answers /health and serves a raw block whose hash is its CID, with a lookup service and without', async () => {
    const host = resolve('out/main/local-node-host.js')
    expect(existsSync(host), 'run `npm run build` first').toBe(true)
    const manifest = JSON.parse(readFileSync('resources/ipfs-node/ipfs-node.json', 'utf8')) as LocalNodeManifest
    const componentDir = process.env['ORIVON_IPFS_NODE_DIR'] ?? resolve('resources/ipfs-node')
    const checked = await verifyArtifact(componentDir, manifest, IPFS_NODE_IDENTITY)
    expect(checked.ok, checked.ok ? '' : checked.reason).toBe(true)

    app = await launchElectron({ chrome: false })
    for (const lookupService of [true, false]) {
      const apiPort = await freePort()
      const run = await app.evaluate(async ({ utilityProcess, app: electronApp }, arg) => {
        const started = Date.now()
        const child = utilityProcess.fork(arg.host, [], { serviceName: 'IPFS node live', stdio: 'ignore' })
        const timeline: Array<{ at: number, type: string }> = []
        let ready = false
        let failure: string | undefined
        child.on('message', (message: { type: string, message?: string }) => {
          timeline.push({ at: Date.now() - started, type: message.type })
          if (message.type === 'ready') ready = true
          if (message.type === 'failed') failure = message.message
        })
        child.postMessage({ type: 'start', config: { kind: 'ipfs-node', apiPort: arg.apiPort, dataDir: arg.data, componentDir: arg.componentDir, componentName: arg.name, files: arg.files, options: arg.options } })
        while (!ready && failure === undefined && Date.now() - started < arg.readyByMs) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        let block: string | undefined
        let blockMs: number | undefined
        let memoryMb: number | undefined
        if (ready) {
          const asked = Date.now()
          const response = await fetch(`http://127.0.0.1:${String(arg.apiPort)}/ipfs/${arg.content}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' }, signal: AbortSignal.timeout(40_000) })
          blockMs = Date.now() - asked
          if (response.ok) block = Buffer.from(await response.arrayBuffer()).toString('hex')
          const metric = electronApp.getAppMetrics().find((entry) => entry.name === 'IPFS node live')
          memoryMb = metric === undefined ? undefined : Math.round(metric.memory.workingSetSize / 1024)
        }
        child.kill()
        return { timeline, failure, block, blockMs, memoryMb }
      }, { host, apiPort, data: join(data as string, lookupService ? 'auto' : 'light-dht'), componentDir, name: process.env['ORIVON_IPFS_NODE_NAME'] ?? manifest.name, files: manifest.files, content: CONTENT, readyByMs: READY_BY_MS, options: routingOptions(lookupService) })

      console.log(`[ipfs-node live] ${JSON.stringify({ lookupService, blockMs: run.blockMs, memoryMb: run.memoryMb, timeline: run.timeline })}`)
      expect(run.failure).toBeUndefined()
      expect(run.timeline.map((entry) => entry.type)).toContain('listening')
      expect(run.timeline.map((entry) => entry.type)).toContain('ready')
      if (run.block === undefined) {
        // Network-only lookups can be slow to find a provider; a missing block is reported, a wrong one fails.
        console.log(`[ipfs-node live] no block with lookupService=${String(lookupService)}`)
        expect(lookupService, 'with the lookup service the block must arrive').toBe(false)
        continue
      }
      const bytes = Buffer.from(run.block, 'hex')
      const digest = await sha256.digest(bytes)
      expect(Buffer.from(digest.digest).toString('hex')).toBe(Buffer.from(CID.parse(CONTENT).multihash.digest).toString('hex'))
      expect(run.memoryMb).toBeLessThan(700)
    }
  }, 240_000)

  it('opens the content through the shell: the node starts on demand and the page says it came from the node', async () => {
    const componentDir = process.env['ORIVON_IPFS_NODE_DIR'] ?? resolve('resources/ipfs-node')
    const shell = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_IPFS_NODE_DIR: componentDir } })
    try {
      await waitFor(() => shell.windows().length === 2)
      const chrome = findChrome(shell)
      await waitForAddressBarStable(chrome)
      const started = Date.now()
      await clickAddressBarRetrying(chrome, `ipfs://${CONTENT}`)
      const shown = await waitForTab(chrome, { address: `ipfs://${CONTENT}/` })
      let view = findViewShowing(shell, chrome, `https://${CONTENT}.ipfs.orivon/`)
      await waitFor(async () => {
        view = findViewShowing(shell, chrome, `https://${CONTENT}.ipfs.orivon/`)
        if (view === undefined) return false
        const seen = await evaluateRetrying(view, () => ({ title: document.title })).catch(() => ({ title: '' }))
        return seen.title !== '' && !/^Cannot /.test(seen.title)
      }, 60_000)
      const page = view === undefined ? undefined : await evaluateRetrying(view, () => ({ title: document.title, text: document.body.innerText.length, origin: location.origin }))
      console.log(`[ipfs-node live] page after ${String(Date.now() - started)} ms: ${JSON.stringify({ shown: shown.info, page })}`)
      expect(view).toBeDefined()
      expect(page?.origin).toBe(`https://${CONTENT}.ipfs.orivon`)
      expect(page?.title).not.toMatch(/^Cannot /)
    } finally {
      await closeElectronApp(shell, APP_CLOSE_RACE_MS)
    }
  }, 180_000)
})
