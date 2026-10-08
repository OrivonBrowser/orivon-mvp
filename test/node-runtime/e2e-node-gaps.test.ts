// What a Node dependency bundled into a page counts on from the shim: the `constants` module and
// `process.execPath` read as it loads, `fs` opening a file with O_CREAT and no O_TRUNC, and file calls that
// keep completing while many socket dials hang. The hanging dials go to a listener whose process is stopped, so
// its backlog fills and further connections get no answer, as a peer that has gone silent would not answer.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-node-gaps.test.ts
import { afterAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { NodeGapsResults } from './node-gaps-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://node-gaps-e2e.orivon.test'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** A loopback listener with a backlog of one whose process is then stopped: after a few connections the rest hang. */
async function startSilentListener (): Promise<{ port: number, stop: () => void }> {
  const script = "const s = require('node:net').createServer(); s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => console.log(s.address().port))"
  const child: ChildProcess = spawn('node', ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.stdout?.once('data', (chunk: Buffer) => { resolve(Number(chunk.toString().trim())) })
  })
  child.kill('SIGSTOP')
  return { port, stop: () => { child.kill('SIGCONT'); child.kill('SIGKILL') } }
}

it('[app:node-constants-and-exec-path] [app:fs-open-create-in-place] [app:file-calls-complete-beside-hung-dials] [app:url-parse-escapes-like-node] a bundled dependency reads constants and execPath, creates files in place, and its file calls complete while many dials hang, and a request path from url.parse is percent-encoded', async () => {
  const silent = await startSilentListener()
  const seen: string[] = []
  const server = createServer((request, response) => { seen.push(request.url ?? ''); response.end('ok') })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const httpPort = (server.address() as AddressInfo).port
  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.node-gaps-e2e',
    name: 'node gaps e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: ['app.js'],
    capabilities: { fs: { quotaBytes: 4_194_304 }, net: { tcp: { connect: [`127.0.0.1:${String(silent.port)}`, `127.0.0.1:${String(httpPort)}`] }, concurrentSockets: 512 } }
  }
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('node gaps', async (check) => {
      const html = `<!doctype html><html><head><title>node gaps fixture</title><meta name="silent-port" content="${String(silent.port)}"><meta name="http-port" content="${String(httpPort)}"><script src="/app.js"></script></head><body><h1>node gaps fixture</h1></body></html>`
      const served = await serveApp(app, ORIGIN, manifest, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./node-gaps-entry.ts', import.meta.url)))
      }, [], [{ capability: 'tcp.connect', patterns: [`127.0.0.1:${String(silent.port)}`, `127.0.0.1:${String(httpPort)}`] }])
      check('the fixture is granted fs and tcp.connect and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'node gaps fixture')
      await waitForPageGlobal(view, 'nodeGapsE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { nodeGapsE2e: { run: () => Promise<NodeGapsResults> } }).nodeGapsE2e.run(), 120_000)
      const detail = JSON.stringify(results)

      check('the page ran the cases without throwing', results.error === undefined, detail)
      check('require(\'constants\') carries the open flags, equal to fs.constants, and the errno and signal numbers', results.constants?.matchesFs === true && results.constants.errnoNames && results.constants.create === 64 && results.constants.readWrite === 2, detail)
      check('process.execPath is a string a path function accepts', results.execPath?.type === 'string' && typeof results.execPath.dirname === 'string', detail)
      check('an open with O_RDWR | O_CREAT creates a missing file', results.createInPlace?.missingCreated === true, detail)
      check('the same open keeps an existing file\'s bytes and writes at the offset', results.createInPlace?.kept === 'abXYefgh' && results.createInPlace.secondOpenKeeps === 'made', detail)
      check('file calls made while 300 dials hang all complete, and promptly', results.filesBesideHungDials?.failed === 0 && (results.filesBesideHungDials.elapsedMs ?? Infinity) < 5000, detail)

      check('the requests went out without an error', results.requests?.every((outcome: { status?: number | undefined }) => outcome.status === 200) === true, detail)
      check('a space, quotes and braces in the path reach the server percent-encoded', seen.includes('/16%20-%20Artist%20%22Title%22%20%7B1%7D.mp3'), JSON.stringify(seen))
      check('a backslash before the query becomes a slash', seen.includes('/dir/file.bin?x=1'), JSON.stringify(seen))
    })
  } finally {
    await closeElectronApp(app)
    silent.stop()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  }
}, 300_000)
