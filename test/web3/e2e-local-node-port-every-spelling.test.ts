// A page reaches no port of Orivon's own nodes by any spelling of this computer. The nodes bind 127.0.0.1 alone, and a page can write that address as
// `localhost` or any name under it (with or without the dot that ends a name), as an IPv4 number in the forms a URL accepts, or as an IPv6 form of it. A
// stand-in takes the IPFS node's port on 127.0.0.1 (and on ::1 where the system has it) and a control server sits beside it on the same hosts; the
// run's resolver is told to resolve every spelling below, so a request that fails is stopped by the browser's gate and not by a name that went nowhere.
// For each spelling a page asks both servers over http and over a WebSocket: the control must answer where the spelling is delivered, and the stand-in
// must see nothing, whatever the scheme.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-local-node-port-every-spelling.test.ts
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { clickAddressBarRetrying, closeElectronApp } from '../support/e2e-helpers.js'
import { ABSENCE_SETTLE_MS, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import type { Page } from 'playwright'

/** Every way the page can write an address that reaches a listener on 127.0.0.1, and the forms of it that a listener on ::1 would take. */
const SPELLINGS = [
  '127.0.0.1', 'localhost', 'localhost.', 'LOCALHOST.', 'sub.localhost', 'sub.localhost.', 'SUB.Localhost.',
  '127.1', '127.0.1', '0x7f.1', '2130706433', '0177.0.0.1', '0x7f000001',
  '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:0:0]', '0.0.0.0', '0',
  '[::1]', '[0:0:0:0:0:0:0:1]'
] as const

/** The spellings every system delivers to a listener on 127.0.0.1, so the control must answer at each: the rest are reported and judged on the stand-in alone. */
const MUST_ANSWER: ReadonlySet<string> = new Set<string>(['127.0.0.1', 'localhost', 'localhost.', 'LOCALHOST.', 'sub.localhost', 'sub.localhost.', 'SUB.Localhost.', '127.1', '127.0.1', '0x7f.1', '2130706433', '0177.0.0.1', '0x7f000001'])

/** What the resolver is told to resolve itself: each spelling as the browser's resolver sees it, without brackets. */
const resolvedNames = (): string[] => [...new Set(SPELLINGS.map((spelling) => new URL(`http://${spelling}:1/`).hostname.replace(/^\[|\]$/g, '')))]
const RESOLVER = `--host-resolver-rules=MAP * ~NOTFOUND, ${['127.0.0.1', ...resolvedNames()].map((name) => `EXCLUDE ${name}`).join(', ')}`

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What reached a server: the kind of request, the local address it arrived at, and its path. */
interface Arrival { readonly kind: 'http' | 'ws', readonly at: string, readonly path: string }

/** A server that records what reaches it and answers a page's request, or ends a WebSocket handshake. */
function recording (seen: Arrival[]): Server {
  const server = createServer((request, response) => {
    seen.push({ kind: 'http', at: request.socket.localAddress ?? '', path: request.url ?? '' })
    response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }).end('ok')
  })
  server.on('upgrade', (request, socket) => {
    seen.push({ kind: 'ws', at: request.socket.localAddress ?? '', path: request.url ?? '' })
    socket.destroy()
  })
  return server
}

interface Listening { readonly port: number, readonly close: () => void }

/** Listens on 127.0.0.1 at `port` (any when 0), and on ::1 at the same port where the system has it. */
async function listenOnLoopback (seen: Arrival[], port = 0): Promise<Listening> {
  const servers: Server[] = []
  const first = recording(seen)
  await new Promise<void>((resolve, reject) => { first.once('error', reject); first.listen(port, '127.0.0.1', resolve) })
  servers.push(first)
  const chosen = (first.address() as AddressInfo).port
  const twin = recording(seen)
  if (await new Promise<boolean>((resolve) => { twin.once('error', () => { resolve(false) }); twin.listen(chosen, '::1', () => { resolve(true) }) })) servers.push(twin)
  return { port: chosen, close: () => { for (const each of servers) { each.close(); each.closeAllConnections() } } }
}

it('[app:local-node-port-closed-to-pages-at-every-spelling] cancels a page\'s request to the port the IPFS node holds at every spelling of 127.0.0.1, over http and over a WebSocket, and still answers the same spellings on another port', async () => {
  const pageServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>every spelling fixture</title><body>page</body>') })
  const controlSeen: Arrival[] = []
  const standInSeen: Arrival[] = []
  const closers: Array<() => void> = [() => { pageServer.close() }]
  const launched = await launchShell({ args: [RESOLVER] })
  try {
    const { app, chrome } = launched
    await new Promise<void>((resolve, reject) => { pageServer.once('error', reject); pageServer.listen(0, '127.0.0.1', resolve) })
    const pagePort = (pageServer.address() as AddressInfo).port
    const control = await listenOnLoopback(controlSeen)
    closers.push(control.close)

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3') })
    let settings: Page | undefined
    await waitFor(() => { settings = app.windows().find((each) => each.url().startsWith('orivon://settings')); return settings !== undefined })
    if (settings === undefined) throw new Error('Settings did not open')
    let listed = ''
    await waitFor(async () => { listed = (await settings?.locator('#row-web3-servers .value').textContent().catch(() => '')) ?? ''; return /IPFS node, on this computer: http:\/\/127\.0\.0\.1:\d+/.test(listed) }, 15_000)
    const nodePort = Number(/IPFS node, on this computer: http:\/\/127\.0\.0\.1:(\d+)/.exec(listed)?.[1])
    expect(Number.isInteger(nodePort), `Settings names the port the IPFS node holds: ${listed}`).toBe(true)
    const standIn = await listenOnLoopback(standInSeen, nodePort)
    closers.push(standIn.close)

    await clickAddressBarRetrying(chrome, `http://127.0.0.1:${String(pagePort)}/`)
    expect((await waitForTab(chrome, { title: 'every spelling fixture' })).ok).toBe(true)
    const view = findViewShowing(app, chrome, `http://127.0.0.1:${String(pagePort)}/`)
    if (view === undefined) throw new Error('no view shows the fixture page')

    const asksHttp = async (url: string): Promise<'answered' | 'failed'> => await view.evaluate(async (target: string) => {
      try {
        await fetch(target, { mode: 'no-cors', cache: 'no-store' })
        return 'answered'
      } catch {
        return 'failed'
      }
    }, url)
    const asksSocket = async (url: string): Promise<'opened' | 'failed'> => await view.evaluate(async (target: string) => await new Promise<'opened' | 'failed'>((resolve) => {
      try {
        const socket = new WebSocket(target)
        socket.onopen = () => { socket.close(); resolve('opened') }
        socket.onerror = () => { resolve('failed') }
        socket.onclose = () => { resolve('failed') }
      } catch {
        resolve('failed')
      }
    }), url)

    const table: Record<string, { control: string, node: string }> = {}
    // Both servers at once: a browser has one WebSocket handshake to an address under way at a time (RFC 6455), so the two are asked side by side and the spellings one after another.
    for (const [index, spelling] of SPELLINGS.entries()) {
      await Promise.all([control.port, nodePort].flatMap((port) => [asksHttp(`http://${spelling}:${String(port)}/${String(index)}`), asksSocket(`ws://${spelling}:${String(port)}/${String(index)}`)]))
    }
    await new Promise((resolve) => setTimeout(resolve, ABSENCE_SETTLE_MS))

    const reached = (seen: Arrival[], index: number): string => seen.filter((each) => each.path === `/${String(index)}`).map((each) => `${each.kind} at ${each.at}`).join(', ') || 'nothing'
    for (const [index, spelling] of SPELLINGS.entries()) table[spelling] = { control: reached(controlSeen, index), node: reached(standInSeen, index) }
    console.log(`which spelling reached which server (the control, then the stand-in on the node's port ${String(nodePort)}):\n${JSON.stringify(table, null, 1)}`)

    const gotThrough = SPELLINGS.filter((spelling) => table[spelling]?.node !== 'nothing')
    expect(gotThrough, `spellings that reached the node's port: ${JSON.stringify(table)}`).toEqual([])
    const answeredBoth = (seen: Arrival[], index: number): boolean => ['http', 'ws'].every((kind) => seen.some((each) => each.kind === kind && each.path === `/${String(index)}`))
    const unanswered = [...MUST_ANSWER].filter((spelling) => !answeredBoth(controlSeen, SPELLINGS.indexOf(spelling as typeof SPELLINGS[number])))
    expect(unanswered, `spellings the control did not answer, so the stand-in's silence proves nothing there: ${JSON.stringify(table)}`).toEqual([])
  } finally {
    await closeElectronApp(launched.app)
    for (const close of closers) close()
  }
}, QA_TEST_TIMEOUT_MS * 2)
