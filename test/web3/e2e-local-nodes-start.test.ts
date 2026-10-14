// The real Swarm and IPFS nodes start, offline: each runs in the utility process the built app forks, from
// the files this checkout pins, and reports `listening` once its API answers. That needs no peer and no
// network, so it holds on every operating system the app runs on (the guest paths and the host process's
// platform `path` once disagreed on Windows, and the node sat idle without ever answering). Skipped when
// the node's files were not fetched into resources/ (scripts/fetch-local-nodes.mjs). Needs `npm run build`.
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { APP_CLOSE_RACE_MS, closeElectronApp } from '../support/e2e-helpers.js'
import { SWARM_NODE_IDENTITY } from '../../src/protocols/swarm-node/protocol.js'
import { IPFS_NODE_IDENTITY, routingOptions } from '../../src/protocols/ipfs-node/protocol.js'
import { verifyArtifact } from '../../src/main/verifier/local-node-artifact.js'
import type { LocalNodeManifest } from '../../src/main/verifier/local-node-artifact.js'
import type { ElectronApplication } from 'playwright'

const LISTENING_BY_MS = 60_000

const KINDS = [
  { kind: 'swarm-node', identity: SWARM_NODE_IDENTITY, options: undefined },
  { kind: 'ipfs-node', identity: IPFS_NODE_IDENTITY, options: routingOptions(false) }
] as const

const fetched = (kind: string): boolean => existsSync(resolve('resources', kind, `${kind}.json`)) && existsSync(resolve('resources', kind, `${kind}.js`))

async function freePort (): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => { server.close(() => { done() }) })
  return port
}

describe('the local nodes, offline', () => {
  let app: ElectronApplication | undefined
  let data: string | undefined

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'orivon-local-nodes-start-'))
  })

  afterAll(async () => {
    if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
    if (data !== undefined) await rm(data, { recursive: true, force: true })
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  for (const { kind, identity, options } of KINDS) {
    it.skipIf(!fetched(kind))(`the ${kind} starts and its API answers`, async () => {
      const host = resolve('out/main/local-node-host.js')
      expect(existsSync(host), 'run `npm run build` first').toBe(true)
      const manifest = JSON.parse(readFileSync(resolve('resources', kind, `${kind}.json`), 'utf8')) as LocalNodeManifest
      const componentDir = resolve('resources', kind)
      const checked = await verifyArtifact(componentDir, manifest, identity)
      expect(checked.ok, checked.ok ? '' : checked.reason).toBe(true)
      const apiPort = await freePort()

      app ??= await launchElectron({ chrome: false })
      const run = await app.evaluate(async ({ utilityProcess }, arg) => {
        const started = Date.now()
        const child = utilityProcess.fork(arg.host, [], { serviceName: `${arg.kind} start`, stdio: 'ignore' })
        const types: string[] = []
        let failure: string | undefined
        child.on('message', (message: { type: string, message?: string }) => {
          types.push(message.type)
          if (message.type === 'failed') failure = message.message
        })
        child.postMessage({ type: 'start', config: { kind: arg.kind, apiPort: arg.apiPort, dataDir: arg.data, componentDir: arg.componentDir, componentName: arg.name, files: arg.files, dohEndpoints: [], ...(arg.options === undefined ? {} : { options: arg.options }) } })
        while (!types.includes('listening') && failure === undefined && Date.now() - started < arg.listeningByMs) await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        child.kill()
        return { types, failure, ms: Date.now() - started }
      }, { host, kind, apiPort, data: join(data as string, kind), componentDir, name: manifest.name, files: manifest.files, options, listeningByMs: LISTENING_BY_MS })

      console.log(`[${kind} start] ${JSON.stringify(run)}`)
      expect(run.failure).toBeUndefined()
      expect(run.types).toContain('listening')
    }, LISTENING_BY_MS + 60_000)
  }
})
