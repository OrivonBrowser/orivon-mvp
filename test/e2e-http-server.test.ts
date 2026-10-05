// `http.createServer` in a real app tab: the page's own HTTP server listens on a
// loopback port through the broker (`orivon.net.listen`, under a granted
// tcp.listen.local for that one port), answers a request the page makes to it
// through the shim's client, and answers real requests from outside the browser
// (a GET, a chunked POST, a HEAD, keep-alive reuse of one connection). After
// `close()` the port no longer answers.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/e2e-http-server.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Agent, request } from 'node:http'
import { connect, createServer } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from './support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from './support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { HttpServerSeen, HttpServerStartResult } from './http-server-entry.js'
import type { Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://http-server-e2e.orivon.test'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function freePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0) })
    })
  })
}

async function portAnswers (port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = connect(port, '127.0.0.1')
    const timer = setTimeout(() => { probe.destroy(); resolve(false) }, 2000)
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true) })
    probe.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

interface Reply { readonly status: number | undefined, readonly headers: Record<string, string | string[] | undefined>, readonly text: string }

async function send (port: number, path: string, init: { method?: string, body?: string | string[], agent?: Agent } = {}): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', agent: init.agent ?? false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    outgoing.on('error', reject)
    if (Array.isArray(init.body)) { for (const piece of init.body) outgoing.write(piece); outgoing.end() } else outgoing.end(init.body)
  })
}

it('[app:local-listener-accepts-connections] a page runs http.createServer on a loopback port, and real requests from outside the browser are answered', async () => {
  const port = await freePort()
  const manifest: Manifest = {
    orivonApiVersion: 0,
    id: 'app.orivon.http-server-e2e',
    name: 'http server e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    assets: ['app.js'],
    capabilities: { net: { tcp: { connect: [`127.0.0.1:${port}`], listen: { local: [String(port)] } } } }
  }
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('http server', async (check) => {
      const html = '<!doctype html><html><head><title>http server fixture</title><script src="/app.js"></script></head><body><h1>http server fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, manifest, 'tcp.listen.local', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./http-server-entry.ts', import.meta.url)))
      }, [String(port)], [{ capability: 'tcp.connect', patterns: [`127.0.0.1:${port}`] }])
      check('the fixture is granted tcp.listen.local and tcp.connect for one port, and registered', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'http server fixture')
      await waitForPageGlobal(view, 'httpServerE2e')
      await view.evaluate((chosen: number) => { (globalThis as unknown as { httpServerPort: number }).httpServerPort = chosen }, port)
      const started = await evaluateRetrying(view, async () => await (globalThis as unknown as { httpServerE2e: { start: () => Promise<HttpServerStartResult> } }).httpServerE2e.start(), 30_000).catch(async (error: unknown) => {
        const progress = await view.evaluate(() => (globalThis as unknown as { httpServerProgress?: string[] }).httpServerProgress)
        return { error: `${String(error)}; progress: ${JSON.stringify(progress)}` } satisfies HttpServerStartResult
      })
      const detail = JSON.stringify(started)
      check('the page listened without throwing', started.error === undefined && started.listening === true, detail)
      check(`the server reports the port it was granted, ${port}`, (started.address as { port?: number } | null)?.port === port, detail)
      check('the page\'s own client got the server\'s answer through the shim: status 200, its header and its JSON body',
        started.selfReply?.status === 200 && started.selfReply.served === 'orivon-shim' &&
        started.selfReply.body === JSON.stringify({ method: 'POST', url: '/self?x=1', body: 'from the page itself' }), detail)

      const outside = await send(port, '/outside?y=2')
      check('a real client outside the browser gets 200, the page\'s header and a JSON body', outside.status === 200 && outside.headers['x-served-by'] === 'orivon-shim' && outside.text === JSON.stringify({ method: 'GET', url: '/outside?y=2', body: '' }), JSON.stringify(outside))

      const chunked = await send(port, '/chunked', { method: 'POST', body: ['one ', 'two ', 'three'] })
      check('a chunked request body from outside arrives whole', chunked.text === JSON.stringify({ method: 'POST', url: '/chunked', body: 'one two three' }), JSON.stringify(chunked))

      const head = await send(port, '/head', { method: 'HEAD' })
      check('HEAD is answered with its headers and no body', head.status === 200 && head.text === '' && head.headers['content-type'] === 'application/json', JSON.stringify(head))

      const missing = await send(port, '/missing')
      check('a status the handler chose reaches the client', missing.status === 404 && missing.text === 'nothing here', JSON.stringify(missing))

      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      await send(port, '/k1', { agent })
      await send(port, '/k2', { agent })
      agent.destroy()
      const seen: HttpServerSeen[] = await evaluateRetrying(view, async () => await (globalThis as unknown as { httpServerE2e: { seen: () => HttpServerSeen[] } }).httpServerE2e.seen(), 10_000)
      const keepAlive = seen.filter((entry) => entry.url === '/k1' || entry.url === '/k2')
      check('two requests over one keep-alive connection reached the same server socket', keepAlive.length === 2 && keepAlive[0]?.remotePort === keepAlive[1]?.remotePort && keepAlive[0]?.remotePort !== undefined, JSON.stringify(keepAlive))

      const stopped = await evaluateRetrying(view, async () => await (globalThis as unknown as { httpServerE2e: { stop: () => Promise<{ closed: boolean, listening: boolean }> } }).httpServerE2e.stop(), 15_000)
      check('close() ended the server in the page', stopped.closed && !stopped.listening, JSON.stringify(stopped))
      check('after close() the port no longer answers', !await portAnswers(port))
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
