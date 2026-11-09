// A name a protocol serves, written with the DNS root dot (`vitalik.eth.`), is a host of its own to Chromium: the resolver
// rule that sends `*.eth` to the verifier does not match it, and neither does a proxy's bypass rule for `*.eth`. Left alone
// it would be looked up by Chromium's own resolver, or handed to a proxy or a tunnel's far end, and so leave this computer.
// The proof is Chromium's own record, the net log, not the page's outcome: a run with no host-resolution event for the
// name and no proxy asked to tunnel to it never sent it anywhere. The launch hides every name that does not end in a dot
// (`ALL_BUT_ROOT_DOT_RESOLVER`), because the usual hermetic rule would turn the root-dot spelling into "not found" before a
// leak could show; a control in each run proves the log sees the requests and the dotless name still loads. A host with two
// trailing dots (`vitalik.eth..`) is no rule's to list: Chromium makes no lookup for it, and a front refuses it.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-root-dot-names.test.ts
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { gnomeProxy, launchWithoutDesktop, loadFailures, proxyEnvironment, recordLoadFailures, startLoggingProxy, visitReporting } from './system-proxy-support.js'
import type { LoggingProxy, Visit } from './system-proxy-support.js'
import { ALL_BUT_ROOT_DOT_RESOLVER, readNetLog, startNetLog, stopNetLog } from './root-dot-support.js'
import type { NetLogFacts } from './root-dot-support.js'

const LINUX = process.platform === 'linux'
const SETUP_TIMEOUT_MS = 300_000
/** Every root-dot name this run asks for holds this, so the net log is searched for one word; the name with two dots holds the other. */
const MARK = 'rootdot-'
const DOUBLE_MARK = 'dotdot-'
const named = (text: string): boolean => text.includes(MARK) || text.includes(DOUBLE_MARK)
const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const ORDINARY_ORIGIN = 'http://ordinary.test:8080'
const ORDINARY = `${ORDINARY_ORIGIN}/`
const ORDINARY_TITLE = 'ordinary via the tunnel'
/** The root-dot spelling under each suffix a protocol serves: a top-level domain, and the suffix every address scheme shares. */
const MAIN_FRAME_NAMES = [`https://${MARK}main.eth./`, `https://${MARK}main.ipfs.orivon./`]
/** Chromium's name for a request that failed to resolve, and for one Orivon cancelled before it was sent. */
const NOT_FOUND = 'ERR_NAME_NOT_RESOLVED'
const CANCELLED = 'ERR_BLOCKED_BY_CLIENT'

/**
 * A page that asks for the root-dot spelling in every way a page can: a picture, a script's `fetch` and WebSocket, and a hint
 * to connect ahead. The name with two dots, which no bypass rule lists, is asked for as a picture, a `fetch`, a `wss:` socket
 * and a plain `ws:` one. It retitles itself once its requests have ended.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>asking</title>
<link rel="preconnect" href="https://${MARK}preconnect.eth."><link rel="dns-prefetch" href="//${MARK}prefetch.eth.">
<img src="https://${MARK}image.eth./a.png"><img src="https://${MARK}image.ipfs.orivon./a.png"><img src="https://${DOUBLE_MARK}double.eth../a.png">
<script>
const socketEnds = (address) => new Promise((done) => { const socket = new WebSocket(address); socket.onclose = socket.onerror = () => { done() } })
Promise.allSettled([
  fetch('https://${MARK}fetch.eth./a'), socketEnds('wss://${MARK}socket.eth./'),
  fetch('https://${DOUBLE_MARK}fetch.eth../a'), socketEnds('wss://${DOUBLE_MARK}secure-socket.eth../'), socketEnds('ws://${DOUBLE_MARK}plain-socket.eth../')
]).then(() => { document.title = 'rootdot settled' })
</script>`

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
let pageServer: Server
let pageUrl = ''

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-root-dot-'))
  gateway = await startFixtureGateway({ site: SITE })
  pageServer = createHttpServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
  })
  await new Promise<void>((resolve) => { pageServer.listen(0, '127.0.0.1', resolve) })
  pageUrl = `http://127.0.0.1:${String((pageServer.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { pageServer.close(() => { resolve() }); pageServer.closeAllConnections() })
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Running { app: ElectronApplication, chrome: Page }

/** A shell whose verifier host is up, launched with no desktop in its environment and `env` on top of it. */
async function launchShell (env: Record<string, string>, seedProfile?: (dir: string) => void): Promise<Running> {
  const app = await launchWithoutDesktop(async () => await launchElectron({
    appPath: '.',
    args: [ALL_BUT_ROOT_DOT_RESOLVER],
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.eth': `ipfs://${gateway.roots['site']!}` }),
      ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
      ...env
    },
    ...(seedProfile === undefined ? {} : { seedProfile })
  }))
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
  await recordLoadFailures(app)
  return { app, chrome: findChrome(app) }
}

interface Probe {
  /** What each live session reports as the proxy for the root-dot name, and for an ordinary one. */
  readonly sessions: Record<string, string>
  readonly ordinarySessions: Record<string, string>
  /** What the shell's own requests for the root-dot name come to: the error's text, or `answered`. */
  readonly own: Record<string, string>
}

/** Asks, from main, what every session that exists makes of a root-dot name: the default one and the one of each page in a tab. The shell's own windows are left out: they load nothing of anyone's, and no request for a name is made through their session. */
async function probe (app: ElectronApplication, rootDot: string, ordinary: string): Promise<Probe> {
  return await app.evaluate(async ({ net, session, webContents }, { target, plain }) => {
    const live = new Map<string, Electron.Session>([['default', session.defaultSession]])
    for (const contents of webContents.getAllWebContents()) if (!contents.getURL().startsWith('orivon-shell:') && ![...live.values()].includes(contents.session)) live.set(`session of a page at ${contents.getURL()}`, contents.session)
    const sessions: Record<string, string> = {}
    const ordinarySessions: Record<string, string> = {}
    for (const [name, one] of live) {
      sessions[name] = await one.resolveProxy(target)
      ordinarySessions[name] = await one.resolveProxy(plain)
    }
    const asked: Array<[string, () => Promise<unknown>]> = [['net.fetch', async () => await net.fetch(target)], ['resolveHost', async () => await session.defaultSession.resolveHost(new URL(target).hostname)]]
    for (const [name, one] of live) asked.push([name, async () => await one.fetch(target)])
    const own: Record<string, string> = {}
    for (const [name, ask] of asked) {
      try { await ask(); own[name] = 'answered' } catch (error) { own[name] = String(error) }
    }
    return { sessions, ordinarySessions, own }
  }, { target: rootDot, plain: ordinary })
}

interface Facts {
  readonly control: Visit
  readonly main: Visit[]
  readonly page: Visit
  readonly sessions: Record<string, string>
  readonly ordinarySessions: Record<string, string>
  readonly own: Record<string, string>
  /** The net log for the names with one root dot, and for the name with two. */
  readonly log: NetLogFacts
  readonly double: NetLogFacts
  /** The net log for the dotless control: proof that it covers the run when Orivon cancels a request before it is sent. */
  readonly controlLog: NetLogFacts
  readonly failures: string[]
}

/** Asks for the root-dot spelling every way the shell and a page can, with the net log recording, and reads the log. */
async function ask ({ app, chrome }: Running, name: string): Promise<Facts> {
  const path = join(scratch, `${name}-net.json`)
  await startNetLog(app, path)
  const control = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
  const main: Visit[] = []
  for (const url of MAIN_FRAME_NAMES) main.push(await visitReporting(app, chrome, url, 'never shown'))
  const page = await visitReporting(app, chrome, pageUrl, 'rootdot settled')
  await new Promise((resolve) => { setTimeout(resolve, 1_500) })
  const { sessions, ordinarySessions, own } = await probe(app, `https://${MARK}own.eth./`, ORDINARY)
  await new Promise((resolve) => { setTimeout(resolve, 500) })
  await stopNetLog(app)
  const facts: Facts = { control, main, page, sessions, ordinarySessions, own, log: await readNetLog(path, MARK), double: await readNetLog(path, DOUBLE_MARK), controlLog: await readNetLog(path, 'fixture.eth'), failures: await loadFailures(app) }
  console.log(`[root-dot] ${name}: ${JSON.stringify(facts)}`)
  return facts
}

/**
 * What every launch must show whatever carries the traffic: the dotless name loads, no root-dot name is looked up or sent to
 * a proxy, and nothing the shell asks for it is answered. Behind a front (`front`) the name with two dots is sent to the
 * front, which refuses it, so the caller reads the tunnel's own record for it.
 */
function expectNothingLeft (facts: Facts, front = false): void {
  expect(facts.control.result, JSON.stringify(facts.control)).toBe('page')
  expect(facts.log.requests, 'the net log saw the requests for the root-dot names').toBeGreaterThan(0)
  expect(facts.log.lookups, 'host-resolution events for a root-dot name').toEqual([])
  expect(facts.log.tunnelled, 'a proxy asked to tunnel to a root-dot name').toEqual([])
  expect(facts.double.requests, 'the net log saw the request for the name with two dots').toBeGreaterThan(0)
  expect(facts.double.lookups, 'host-resolution events for the name with two dots').toEqual([])
  if (!front) expect(facts.double.tunnelled, 'a proxy asked to tunnel to the name with two dots').toEqual([])
  expect(facts.page.result, JSON.stringify(facts.page)).toBe('page')
  for (const [asked, outcome] of Object.entries(facts.own)) expect(outcome, `the shell's own request: ${asked}`).not.toBe('answered')
}

/** A root-dot name in a tab is not found, never served, and every session sends it direct, where the resolver refuses it. */
function expectNotFoundDirect (facts: Facts): void {
  for (const visit of facts.main) expect(visit, JSON.stringify(visit)).toMatchObject({ result: 'error', error: NOT_FOUND })
  for (const [kind, answer] of Object.entries(facts.sessions)) expect(answer, kind).toBe('DIRECT')
}

/** A server that answers for `ordinary.test`, which a SOCKS5 fixture maps to. */
async function startOrdinary (): Promise<Server> {
  const server = createHttpServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${ORDINARY_TITLE}</title><body>tunnel</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return server
}

async function stopOrdinary (server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
}

describe('no proxy at all', () => {
  let running: Running
  let facts: Facts

  beforeAll(async () => {
    running = await launchShell({})
    facts = await ask(running, 'no proxy')
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => { await closeElectronApp(running.app) })

  it('no root-dot name is looked up, in a tab, a page, or the shell\'s own request; the dotless name still loads', () => {
    expectNothingLeft(facts)
  })

  it('a root-dot name in a tab is not found, never served, and every session sends it direct', () => {
    expectNotFoundDirect(facts)
  })
})

describe('the whole browser on a SOCKS5 tunnel', () => {
  let running: Running
  let socks: Socks5Fixture
  let ordinaryServer: Server
  let facts: Facts
  let ordinary: Visit

  beforeAll(async () => {
    ordinaryServer = await startOrdinary()
    socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true, names: { 'ordinary.test:8080': { host: '127.0.0.1', port: (ordinaryServer.address() as AddressInfo).port } } })
    running = await launchShell({}, (dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
    })
    ordinary = await visitReporting(running.app, running.chrome, ORDINARY, ORDINARY_TITLE)
    facts = await ask(running, 'socks5 tunnel')
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await socks.close()
    await stopOrdinary(ordinaryServer)
  })

  it('an ordinary site goes through the tunnel, so what follows is asked of a browser that is on it', () => {
    expect(ordinary.result).toBe('page')
    expect(socks.requests.some((request) => request.destination === 'ordinary.test')).toBe(true)
    expect(facts.ordinarySessions['default']).toMatch(/^PROXY /)
  })

  it('no root-dot name reaches the tunnel, in the net log or the tunnel\'s own record', () => {
    expectNothingLeft(facts, true)
    expect(socks.requests.filter((request) => named(request.destination))).toEqual([])
    expect(socks.datagrams.filter(named)).toEqual([])
  })

  it('a root-dot name in a tab is not found, and every session sends it direct, not to the tunnel\'s front', () => {
    expectNotFoundDirect(facts)
  })
})

describe('a website routed through a SOCKS5 tunnel of its own', () => {
  let running: Running
  let socks: Socks5Fixture
  let ordinaryServer: Server
  let facts: Facts
  let ordinary: Visit

  beforeAll(async () => {
    ordinaryServer = await startOrdinary()
    socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true, names: { 'ordinary.test:8080': { host: '127.0.0.1', port: (ordinaryServer.address() as AddressInfo).port } } })
    running = await launchShell({}, (dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      writeFileSync(join(dir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [ORDINARY_ORIGIN], via: { [ORDINARY_ORIGIN]: 'socks5' }, off: [], apart: [], apartProxy: [], apartDirect: [] }))
    })
    ordinary = await visitReporting(running.app, running.chrome, ORDINARY, ORDINARY_TITLE)
    facts = await ask(running, 'website tunnel')
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await socks.close()
    await stopOrdinary(ordinaryServer)
  })

  it('the website goes through its own tunnel, so what follows is asked of a session that is on it', () => {
    expect(ordinary.result).toBe('page')
    expect(socks.requests.some((request) => request.destination === 'ordinary.test')).toBe(true)
    expect(Object.values(facts.ordinarySessions).some((answer) => /^PROXY /.test(answer)), JSON.stringify(facts.ordinarySessions)).toBe(true)
  })

  it('no root-dot name reaches the tunnel, from the session of any profile', () => {
    expectNothingLeft(facts, true)
    expect(socks.requests.filter((request) => named(request.destination))).toEqual([])
    expect(socks.datagrams.filter(named)).toEqual([])
  })

  it('a root-dot name in a tab is not found, and every session sends it direct, not to the tunnel\'s front', () => {
    expectNotFoundDirect(facts)
  })
})

/**
 * Behind a proxy Orivon copied, the root-dot name is excepted as the dotless one is, so every session sends it direct and the
 * resolver refuses it. The spelling with two dots, which no exception covers, is cancelled before the proxy is asked.
 */
function expectDirectBehindACopiedProxy (facts: Facts, proxy: LoggingProxy): void {
  expect(facts.control.result, JSON.stringify(facts.control)).toBe('page')
  expect(facts.controlLog.requests, 'the net log covers the run').toBeGreaterThan(0)
  expect(facts.log.requests, 'the net log saw the requests for the root-dot names').toBeGreaterThan(0)
  expect(facts.log.lookups, 'host-resolution events for a root-dot name').toEqual([])
  expect(facts.log.tunnelled, 'a proxy asked to tunnel to a root-dot name').toEqual([])
  expect(facts.double.lookups, 'host-resolution events for the name with two dots').toEqual([])
  expect(facts.double.tunnelled, 'a proxy asked to tunnel to the name with two dots').toEqual([])
  expect(proxy.seen.filter(named)).toEqual([])
  expectNotFoundDirect(facts)
  expect(Object.values(facts.ordinarySessions).length, 'sessions asked about an ordinary site').toBeGreaterThan(0)
  for (const [kind, answer] of Object.entries(facts.ordinarySessions)) expect(answer, `${kind} follows the copied proxy for an ordinary site`).toMatch(/^PROXY /)
  for (const [asked, outcome] of Object.entries(facts.own)) expect(outcome, `the shell's own request: ${asked}`).not.toBe('answered')
}

/** A root-dot name is cancelled before it is sent where the system's proxy would carry it, so a tab shows the refusal and the proxy hears nothing. */
function expectRefusedBeforeTheProxy (facts: Facts, proxy: LoggingProxy): void {
  expect(facts.control.result, JSON.stringify(facts.control)).toBe('page')
  expect(facts.controlLog.requests, 'the net log covers the run').toBeGreaterThan(0)
  expect(facts.log.lookups).toEqual([])
  expect(facts.log.tunnelled).toEqual([])
  expect(facts.double.lookups).toEqual([])
  expect(facts.double.tunnelled).toEqual([])
  expect(proxy.seen.filter(named)).toEqual([])
  for (const visit of facts.main) expect(visit, JSON.stringify(visit)).toMatchObject({ result: 'error', error: CANCELLED })
  for (const [asked, outcome] of Object.entries(facts.own)) expect(outcome, `the shell's own request: ${asked}`).not.toBe('answered')
}

describe.skipIf(!LINUX)('a computer whose desktop carries a proxy that excepts the names', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: Facts

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    running = await launchShell(gnomeProxy(mkdtempSync(join(scratch, 'desktop-')), proxy.port, ['localhost', '127.0.0.0/8', '::1', '*.eth', '*.orivon']).env)
    facts = await ask(running, 'desktop proxy')
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('a root-dot name is excepted like the dotless one, goes direct, is refused by the resolver and never reaches the proxy', () => {
    expectDirectBehindACopiedProxy(facts, proxy)
  })
})

describe.skipIf(!LINUX)('a computer whose environment carries a proxy', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: Facts

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    running = await launchShell(proxyEnvironment(proxy.url))
    facts = await ask(running, 'environment proxy')
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('a root-dot name is not covered by the exception Orivon adds, and is refused before the proxy is asked about it', () => {
    expectRefusedBeforeTheProxy(facts, proxy)
  })
})
