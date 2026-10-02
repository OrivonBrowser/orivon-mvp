// A routed response body that an app is reading arrives whole, however long
// the read takes and however often the page's heap is collected meanwhile; a
// body the app dropped unread still gives its socket back.
//
// The probe server sends a gzip body slowly, as a CDN does a large script,
// while the page forces a young-generation collection every tick and a full
// one every twentieth (`--js-flags=--expose-gc` makes `gc()` a page global).
// The young-generation ones matter: they can drop the JS wrapper of a
// stream that only the Response still holds, so a registry watching that
// wrapper would close the socket mid-body. Nothing in the page holds the
// Response or its stream once `.text()` is under way.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { asPage, closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { clearFixtureAsPageScript, setFixtureAsPageScript, AS_PAGE_SCRIPT_URL } from './fixture-as-page.js'
import { HOST, STATIC_PORT } from './apps/fixture/config.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
const AS_PAGE_SCRIPT_FULL_URL = `${FIXTURE_ORIGIN}/${AS_PAGE_SCRIPT_URL}`
/** A literal in the page scripts below too: a closed-over value does not survive their serialisation. */
const PROBE_PORT = 8896
const TEST_TIMEOUT_MS = 120_000
const PIECE_BYTES = 16 * 1024
const PIECE_GAP_MS = 15

/** Incompressible, so the gzip body keeps its size. */
const PLAIN = randomBytes(700_000).toString('base64')
const GZIPPED = gzipSync(Buffer.from(PLAIN))

let staticServer: ChildProcess
let probeServer: Server
const openSockets = new Set<Socket>()
let droppedSocketClosed = false

function sendSlowly (res: ServerResponse, body: Buffer): void {
  let at = 0
  const timer = setInterval(() => {
    if (at >= body.byteLength || res.destroyed) { clearInterval(timer); if (!res.destroyed) res.end(); return }
    res.write(body.subarray(at, at + PIECE_BYTES))
    at += PIECE_BYTES
  }, PIECE_GAP_MS)
  res.on('close', () => { clearInterval(timer) })
}

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  probeServer = createServer((req, res) => {
    const path = req.url ?? ''
    if (path.startsWith('/length')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Encoding': 'gzip', 'Content-Length': GZIPPED.byteLength })
      sendSlowly(res, GZIPPED)
    } else if (path.startsWith('/chunked')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' })
      sendSlowly(res, GZIPPED)
    } else if (path.startsWith('/dropped')) {
      const big = Buffer.alloc(8_000_000, 97)
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': big.byteLength })
      res.write(big)
      res.socket?.on('close', () => { droppedSocketClosed = true })
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  probeServer.on('connection', (socket) => { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)) })
  await Promise.all([
    new Promise<void>((resolve) => { probeServer.listen(PROBE_PORT, HOST, resolve) }),
    waitForTcpReady(HOST, STATIC_PORT, 10_000)
  ])
}, 15_000)

afterAll(async () => {
  for (const socket of openSockets) socket.destroy()
  await Promise.all([
    killChild(staticServer),
    new Promise<void>((resolve) => { probeServer.close(() => resolve()) })
  ])
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('a body being read arrives whole across garbage collections, and a dropped body frees its socket', async () => {
  await runPhase('routed body gc', async (check) => {
    const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, '--js-flags=--expose-gc'] })
    try {
      const grantPattern = `${HOST}:${PROBE_PORT}`
      const manifest: Manifest = {
        orivonApiVersion: 0,
        id: 'app.orivon.fixture.routed-body-gc',
        name: 'Orivon Fixture (routed body gc)',
        version: '0.1.0',
        entry: 'index.html',
        capabilities: { net: { tcp: { connect: [grantPattern] } } }
      }
      const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return { installed: false as const }
        return { installed: true as const, grant: await hook(request) }
      }, { origin: FIXTURE_ORIGIN, manifest, capability: 'tcp.connect', patterns: [grantPattern] } satisfies DevGrantRequest)
      if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

      const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')

      for (const kind of ['length', 'chunked']) {
        const outcome = await asPage(view, setFixtureAsPageScript, AS_PAGE_SCRIPT_FULL_URL, async (path: string) => {
          const collect = (globalThis as unknown as { gc?: (options?: { type: 'minor' | 'major' }) => void }).gc
          if (typeof collect !== 'function') return { ok: false as const, message: 'gc is not exposed to the page' }
          let running = true
          const collector = (async () => {
            for (let tick = 0; running; tick++) {
              collect({ type: tick % 20 === 0 ? 'major' : 'minor' })
              await new Promise((resolve) => setTimeout(resolve, 0))
            }
          })()
          try {
            const text = await fetch(`http://127.0.0.1:8896/${path}`).then(async (response) => await response.text())
            return { ok: true as const, length: text.length }
          } catch (error) {
            return { ok: false as const, message: (error as Error).message }
          } finally {
            running = false
            await collector
          }
        }, kind)
        check(
          `a ${kind === 'length' ? 'Content-Length' : 'chunked'} gzip body read across forced collections arrives whole`,
          outcome.ok && outcome.length === PLAIN.length,
          JSON.stringify(outcome)
        )
      }

      await asPage(view, setFixtureAsPageScript, AS_PAGE_SCRIPT_FULL_URL, async () => {
        const collect = (globalThis as unknown as { gc: () => void }).gc
        await fetch('http://127.0.0.1:8896/dropped')
        for (let i = 0; i < 40; i++) {
          collect()
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return true
      })
      const deadline = Date.now() + 10_000
      while (!droppedSocketClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      check('a response the app dropped unread releases its socket', droppedSocketClosed, 'the server\'s connection stayed open')
    } finally {
      await closeElectronApp(app)
      clearFixtureAsPageScript()
    }
  })
}, TEST_TIMEOUT_MS)
