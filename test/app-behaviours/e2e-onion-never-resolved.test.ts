// An onion address (`.onion`, RFC 7686) is reached only through Tor, and its name must never go to a DNS resolver: a lookup
// tells the resolver which hidden service the person is about to visit. The launch maps the test onion names to a server on
// loopback with Chromium's own resolver rules, which stands in for the system resolver answering an unknown name (this
// computer's resolver answers every unknown name with 127.0.0.1): a request that reaches it was resolved. A session that is
// not the person's own SOCKS5 tunnel must therefore stop the request before it resolves anything, and the sheet over the tab
// says why. The SOCKS5 fixture stands in for Tor and is the one way an onion name is carried, unresolved.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-onion-never-resolved.test.ts
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** Well-formed v3 onion names that exist nowhere but in the launch's resolver rules and the SOCKS5 fixture. */
const PLAIN = 'orivonexampleonionwithnotunnelsetxxxxxxxxxxxxxxxxxxxxxxxx.onion'
const SECURE = 'orivonexampleonionopenedoverhttpsnotunnelxxxxxxxxxxxxxxxxx.onion'
const SUBRESOURCE = 'orivonexampleonionnamedbyapagenotunnelxxxxxxxxxxxxxxxxxxx.onion'
const DIRECT = 'orivonexampleonionsettodirectwhilethebrowserisonxxxxxxxxxx.onion'
const CARRIED = 'orivonexampleonioncarriedbytheownsocksproxyxxxxxxxxxxxxxxx.onion'

/** A server standing for whatever answers when a name is looked up: it counts every connection made to it. */
interface Resolved {
  readonly port: number
  connections: () => number
  close: () => Promise<void>
}

async function resolvedServer (): Promise<Resolved> {
  const sockets = new Set<Socket>()
  let count = 0
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>reached-by-resolving-the-name</title><body>resolved</body>')
  })
  server.on('connection', (socket) => { count += 1; sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => count,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }
  }
}

const resolverRules = (resolved: Resolved, ...names: string[]): string =>
  `--host-resolver-rules=${names.map((name) => `MAP ${name} 127.0.0.1:${String(resolved.port)}`).join(', ')}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`

describe('with no tunnel on', () => {
  let app: ElectronApplication
  let chrome: Page
  let resolved: Resolved

  beforeAll(async () => {
    resolved = await resolvedServer()
    const launched = await launchShell({ args: [resolverRules(resolved, PLAIN, SECURE, SUBRESOURCE)] })
    app = launched.app
    chrome = launched.chrome
  }, 240_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await resolved?.close()
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  const sheetShown = async (): Promise<boolean> => await popoverShown(app, 'overlay=load-error')
  const sheetText = async (): Promise<string> => {
    const overlay = app.windows().find((w) => w.url().includes('overlay=load-error') && !w.isClosed())
    return (await overlay?.locator('.load-error').innerText().catch(() => '')) ?? ''
  }

  it('[app:onion-name-never-resolved] an onion address opened in the default session is stopped before its name is looked up, and the sheet says it opens only through a Tor tunnel', async () => {
    await clickAddressBarRetrying(chrome, `http://${PLAIN}/`)
    expect(await waitFor(async () => resolved.connections() > 0 || await sheetShown(), 60_000), 'the load ended one way or the other').toBe(true)
    expect(resolved.connections(), 'the name was looked up and the page was asked for').toBe(0)
    expect(await sheetShown(), 'the sheet over the tab says the page could not load').toBe(true)
    const text = await sheetText()
    expect(text, 'the sheet says what an onion address needs').toMatch(/onion/i)
    expect(text, 'the sheet says where to set it up').toMatch(/Settings/)
    expect(text, 'the sheet does not blame an extension or a filter').not.toMatch(/extension|content filter/i)
  }, 4 * QA_TEST_TIMEOUT_MS)

  it('[app:onion-name-never-resolved] an onion address opened over https is stopped just the same', async () => {
    await clickAddressBarRetrying(chrome, `https://${SECURE}/`)
    expect(await waitFor(async () => resolved.connections() > 0 || await sheetShown(), 60_000)).toBe(true)
    expect(resolved.connections(), 'the name was looked up and a connection was made').toBe(0)
    expect(await waitForTab(chrome, { address: `https://${SECURE}/` }, 30_000), 'the tab still names the address').toMatchObject({ ok: true })
  }, 4 * QA_TEST_TIMEOUT_MS)

  it('[app:onion-name-never-resolved] an onion name a page asks for as a picture, a script and a WebSocket is never looked up', async () => {
    const page = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>names-an-onion</title><body>
<img src="http://${SUBRESOURCE}/a.png"><script src="http://${SUBRESOURCE}/a.js"></script>
<script>try { new WebSocket('ws://${SUBRESOURCE}/socket') } catch (e) {} fetch('http://${SUBRESOURCE}/data').catch(() => {})</script></body>`)
    })
    await new Promise<void>((resolve) => { page.listen(0, '127.0.0.1', resolve) })
    try {
      const address = `http://127.0.0.1:${String((page.address() as AddressInfo).port)}/`
      await clickAddressBarRetrying(chrome, address)
      expect((await waitForTab(chrome, { address, title: 'names-an-onion' }, 60_000)).ok, 'the page itself loaded').toBe(true)
      // A refusal is an absence: the page has asked for all four by the time it has finished loading, and the answer is read once.
      await new Promise<void>((resolve) => { setTimeout(resolve, 3_000) })
      expect(resolved.connections(), 'a name the page asked for was looked up').toBe(0)
    } finally {
      page.closeAllConnections()
      await new Promise<void>((resolve) => { page.close(() => { resolve() }) })
    }
  }, 4 * QA_TEST_TIMEOUT_MS)
})

describe('with the whole browser on the person\'s own SOCKS5 tunnel', () => {
  let app: ElectronApplication
  let chrome: Page
  let resolved: Resolved
  let socks: Socks5Fixture
  let carried: Server

  beforeAll(async () => {
    resolved = await resolvedServer()
    carried = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>carried-unresolved</title><body>carried</body>') })
    await new Promise<void>((resolve) => { carried.listen(0, '127.0.0.1', resolve) })
    socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true, names: { [`${CARRIED}:80`]: { host: '127.0.0.1', port: (carried.address() as AddressInfo).port } } })
    const direct = `http://${DIRECT}`
    const launched = await launchShell({
      args: [resolverRules(resolved, DIRECT, CARRIED)],
      seedProfile: async (userDataDir) => {
        writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': true, 'network.route.kind': 'socks5', 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
        // One website is set to go direct; every other follows the tunnel.
        writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [], via: {}, off: [direct], apart: [], apartProxy: [], apartDirect: [direct] }))
      }
    })
    app = launched.app
    chrome = launched.chrome
  }, 240_000)

  afterAll(async () => {
    await app?.close().catch(() => {})
    await socks?.close()
    await resolved?.close()
    await new Promise<void>((resolve) => { carried?.close(() => { resolve() }) })
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('[app:onion-name-never-resolved] an onion website set to go direct is stopped before its name is looked up, while one that follows the tunnel is carried by it unresolved', async () => {
    await clickAddressBarRetrying(chrome, `http://${DIRECT}/`)
    expect(await waitFor(async () => resolved.connections() > 0 || await popoverShown(app, 'overlay=load-error'), 60_000)).toBe(true)
    expect(resolved.connections(), 'the direct profile looked the name up').toBe(0)
    expect(await popoverShown(app, 'overlay=load-error'), 'the sheet over the tab says the page could not load').toBe(true)

    await clickAddressBarRetrying(chrome, `http://${CARRIED}/`)
    expect((await waitForTab(chrome, { address: `http://${CARRIED}/`, title: 'carried-unresolved' }, 60_000)).ok, 'the tunnel carried the onion page').toBe(true)
    const asked = socks.requests.filter((request) => request.destination === CARRIED)
    expect(asked.length, JSON.stringify(socks.requests)).toBeGreaterThan(0)
    expect(asked.every((request) => request.addressType === 'domain'), 'the name itself reached the proxy').toBe(true)
    expect(resolved.connections(), 'nothing was looked up for the tunnelled one either').toBe(0)
  }, 4 * QA_TEST_TIMEOUT_MS)
})
