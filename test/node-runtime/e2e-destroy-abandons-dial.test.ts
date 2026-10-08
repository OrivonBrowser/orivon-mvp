// A socket the app gives up on while it is still connecting (net.Socket#destroy(), or an AbortSignal on
// orivon.net.connect) abandons its dial at once, as under Node: the dial stops and its slot in the origin's
// in-flight budget is free before the dial's own 30 s timeout. The hanging dials go to a listener whose process is
// stopped, so its backlog fills and further connections get no answer, as a peer that has gone silent would not.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-destroy-abandons-dial.test.ts
import { afterAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { AbandonResults } from './destroy-abandons-dial-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://destroy-abandons-dial-e2e.orivon.test'

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

it('[app:socket-destroy-abandons-dial] [app:connect-signal-abandons-dial] destroying a connecting socket, or aborting the signal of orivon.net.connect, frees the dial at once: queued file calls run, a new dial connects, and the abandoned sockets close without an error', async () => {
  const live = createServer((socket) => { socket.on('error', () => {}) })
  let silent: Awaited<ReturnType<typeof startSilentListener>> | undefined
  let app: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    silent = await startSilentListener()
    await new Promise<void>((resolve) => { live.listen(0, '127.0.0.1', resolve) })
    const silentPort = silent.port
    const livePort = (live.address() as AddressInfo).port
    const patterns = [`127.0.0.1:${String(silentPort)}`, `127.0.0.1:${String(livePort)}`]
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.orivon.destroy-abandons-dial-e2e',
      name: 'destroy abandons dial e2e fixture',
      version: '1.0.0',
      entry: 'index.html',
      assets: ['app.js'],
      capabilities: { fs: { quotaBytes: 4_194_304 }, net: { tcp: { connect: patterns }, concurrentSockets: 1024 } }
    }
    const launched = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    app = launched
    await runPhase('destroy abandons dial', async (check) => {
      const html = `<!doctype html><html><head><title>destroy abandons dial fixture</title><meta name="silent-port" content="${String(silentPort)}"><meta name="live-port" content="${String(livePort)}"><script src="/app.js"></script></head><body><h1>destroy abandons dial fixture</h1></body></html>`
      const served = await serveApp(launched, ORIGIN, manifest, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./destroy-abandons-dial-entry.ts', import.meta.url)))
      }, [], [{ capability: 'tcp.connect', patterns }])
      check('the fixture is granted fs and tcp.connect and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(launched, `${ORIGIN}/`, 'destroy abandons dial fixture')
      await waitForPageGlobal(view, 'abandonE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { abandonE2e: { run: () => Promise<AbandonResults> } }).abandonE2e.run(), 120_000)
      const detail = JSON.stringify(results)

      check('the page ran the cases without throwing', results.error === undefined, detail)
      check('a file call waits behind 256 hung dials', results.signal?.probePendingBeforeAbort === true, detail)
      check('aborting the signals hands the slots back: the waiting file call completes within two seconds', results.signal?.probeError === undefined && (results.signal?.probeMsAfterAbort ?? Infinity) < 2000, detail)
      check('every hung dial rejects closed, none with another code', (results.signal?.closedRejections ?? 0) >= 280 && results.signal?.otherSettled.every((outcome: string) => outcome === 'connected') === true, detail)
      check('every destroyed socket closed, with no error event', results.destroy?.closed === results.destroy?.sockets && results.destroy?.errors.length === 0, detail)
      check('a file call right after the destroys completes at once', (results.destroy?.fileCallsMs ?? Infinity) < 2000, detail)
      check('a new dial to a live peer connects within two seconds of the destroys', results.destroy?.freshError === undefined && (results.destroy?.freshConnectMs ?? Infinity) < 2000, detail)
    })
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    silent?.stop()
    live.close()
  }
}, 300_000)
