// A WASI 0.2 program that drops a socket gives back what it held in the broker: the slot among the origin's sockets
// of one that connected (its peer never ends its side, as a host that accepts a connection and then says nothing
// does), and the in-flight slot of one still connecting. The socket host is driven the way a component's glue drives
// it, in the page, over the page's own orivon.net; the silent peer is a loopback listener that never closes, and the
// hanging dials go to one whose process is stopped, so its backlog fills.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-wasi-dropped-sockets.test.ts
import { afterAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { DroppedSocketsResults } from './wasi-dropped-sockets-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://wasi-dropped-sockets-e2e.orivon.test'

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

it('[app:wasi-dropped-socket-frees-its-slots] a socket a WASI program drops, however far it got, no longer counts against the app: connected ones leave the allowance and dials still in flight leave the in-flight budget', async () => {
  const held: Socket[] = []
  const live = createServer((socket) => { held.push(socket); socket.on('error', () => {}) })
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
      id: 'app.orivon.wasi-dropped-sockets-e2e',
      name: 'wasi dropped sockets e2e fixture',
      version: '1.0.0',
      entry: 'index.html',
      assets: ['app.js'],
      capabilities: { fs: { quotaBytes: 4_194_304 }, net: { tcp: { connect: patterns }, concurrentSockets: 16 } }
    }
    const launched = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
    app = launched
    await runPhase('wasi dropped sockets', async (check) => {
      const html = `<!doctype html><html><head><title>wasi dropped sockets fixture</title><meta name="silent-port" content="${String(silentPort)}"><meta name="live-port" content="${String(livePort)}"><script src="/app.js"></script></head><body><h1>wasi dropped sockets fixture</h1></body></html>`
      const served = await serveApp(launched, ORIGIN, manifest, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./wasi-dropped-sockets-entry.ts', import.meta.url)))
      }, [], [{ capability: 'tcp.connect', patterns }])
      check('the fixture is granted fs and tcp.connect and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(launched, `${ORIGIN}/`, 'wasi dropped sockets fixture')
      await waitForPageGlobal(view, 'droppedSocketsE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { droppedSocketsE2e: { run: () => Promise<DroppedSocketsResults> } }).droppedSocketsE2e.run(), 120_000)
      const detail = JSON.stringify(results)

      check('the page ran the cases without throwing', results.error === undefined, detail)
      check('every socket of every round connected, though the rounds hold three times the allowance between them', results.rounds?.connected === results.rounds?.sockets && results.rounds?.refused.length === 0, detail)
      check('the allowance was free again after every round, with the peer still silent', results.rounds?.roomNeverReturned === 0, detail)
      check('a file call waits behind the dials that have not answered', results.hung?.probePendingBeforeDrop === true, detail)
      check('dropping the sockets hands the in-flight slots back: the waiting file call completes within two seconds', results.hung?.probeError === undefined && (results.hung?.probeMsAfterDrop ?? Infinity) < 2000, detail)
    })
  } finally {
    if (app !== undefined) await closeElectronApp(app)
    for (const socket of held) socket.destroy()
    silent?.stop()
    live.close()
  }
}, 300_000)
