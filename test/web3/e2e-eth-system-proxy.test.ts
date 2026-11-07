// A computer with a proxy set: the names the verifier serves (`.eth` and the other namespaces) reach the verifier on this
// computer, and the proxy is never asked about them. The proxy here is a forward proxy on loopback that logs every
// `CONNECT` and every plain-HTTP request; the launch has no desktop, so Chromium reads the proxy from the environment
// the way it does for a shell profile that exports `https_proxy`. A control launch with no proxy proves the page loads
// when nothing stands in the way, so a failure with the proxy is the proxy's.
//
// Three launches. The control has no proxy. The second has the proxy and no tunnel (the shared session follows the
// system). The third has the proxy and the whole browser on a SOCKS5 tunnel (the shared session is on the tunnel's front,
// and a website set to off runs in the direct profile's session, which follows the system). A test marked `fails` states
// what must hold and does not yet; it is flipped to a plain `it` by whatever makes it hold.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-system-proxy.test.ts
import { execFileSync } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { closeElectronApp, readShield } from '../support/e2e-helpers.js'
import { activeTabInfo, findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { launchWithoutDesktop, loadFailures, proxyEnvironment, recordLoadFailures, startLoggingProxy, visitReporting } from './system-proxy-support.js'
import type { LoggingProxy, Visit } from './system-proxy-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const SETUP_TIMEOUT_MS = 240_000
const ORDINARY = 'http://ordinary.test:8080/'

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
let tls: { port: number, connections: () => number, requests: () => number, close: () => Promise<void> }

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-system-proxy-'))
  gateway = await startFixtureGateway({ site: SITE })
  // A TLS server that answers for decoy.eth with a certificate of its own, as a proxy that terminates TLS for a name would.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=decoy.eth', '-addext', 'subjectAltName=DNS:decoy.eth',
    '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore' })
  let connections = 0
  let requests = 0
  const server = createTlsServer({ key: readFileSync(join(scratch, 'key.pem')), cert: readFileSync(join(scratch, 'cert.pem')) }, (_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>decoy served</title><body>decoy served</body>')
  })
  server.on('connection', () => { connections += 1 })
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  tls = { port: (server.address() as AddressInfo).port, connections: () => connections, requests: () => requests, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) } }
})

afterAll(async () => {
  await tls.close()
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** The lines of a proxy's log that name a host the verifier serves. */
const verifierNames = (log: readonly string[]): string[] => log.filter((line) => /\.(eth|orivon)\b/.test(line))

interface Running { app: ElectronApplication, chrome: Page }

/** A shell whose verifier host is up, launched with no desktop in its environment and `env` on top of it. */
async function launchShell (env: Record<string, string>, seedProfile?: (dir: string) => void): Promise<Running> {
  const app = await launchWithoutDesktop(async () => await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'fixture.eth': `ipfs://${gateway.roots['site']!}`, 'direct.eth': `ipfs://${gateway.roots['site']!}` }),
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

/** What each session kind reports as the proxy for `url`: the answer of `session.resolveProxy`, by partition. */
async function resolved (app: ElectronApplication, url: string): Promise<Record<string, string>> {
  return await app.evaluate(async ({ session }, target) => {
    const partitions: Array<[string, Electron.Session]> = [
      ['default', session.defaultSession],
      ['direct-profile', session.fromPartition('persist:direct-profile')],
      ['proxy-profile', session.fromPartition('persist:proxy-profile')],
      ['tunnel-profile', session.fromPartition('persist:tunnel-profile')]
    ]
    const out: Record<string, string> = {}
    for (const [name, one] of partitions) out[name] = await one.resolveProxy(target)
    return out
  }, url)
}

const report = (label: string, facts: unknown): void => { console.log(`[system-proxy] ${label}: ${JSON.stringify(facts)}`) }

describe('no proxy at all (the control)', () => {
  it('a .eth name loads and an ordinary name does not resolve, so a failure with a proxy is the proxy\'s', async () => {
    const { app, chrome } = await launchShell({})
    try {
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
      const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
      report('control', { eth, ordinary, failures: await loadFailures(app) })
      expect(eth.result).toBe('page')
      expect(ordinary).toMatchObject({ result: 'error', error: 'ERR_NAME_NOT_RESOLVED' })
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)
})

describe('a computer with a proxy, the browser not on a tunnel', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: { ordinary: Visit, eth: Visit, decoy: Visit, plain: Visit, plainTab: { address?: string, title?: string }, plainShield: unknown, sessions: Record<string, Record<string, string>>, refused: string[], fromMain: string }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    proxy.serve('plain.eth', 'served by the proxy as plain.eth')
    proxy.tunnelTo('decoy.eth', tls.port)
    running = await launchShell(proxyEnvironment(proxy.url))
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const decoy = await visitReporting(app, chrome, 'https://decoy.eth/', 'decoy served')
    const plain = await visitReporting(app, chrome, 'http://plain.eth/', 'served by the proxy as plain.eth')
    const plainTab = await activeTabInfo(chrome)
    const plainShield = await readShield(chrome).catch((error: unknown) => String(error))
    const sessions = { eth: await resolved(app, 'https://fixture.eth/'), ordinary: await resolved(app, 'https://ordinary.test/') }
    const refused = mainOutput(app).split('\n').filter((line) => line.includes('refused certificate'))
    // The shell reads an app's files from a `.eth` name itself, with `net.fetch` on the default session.
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = { ordinary, eth, decoy, plain, plainTab, plainShield, sessions, refused, fromMain }
    report('proxy, no tunnel', { ...facts, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), decoyTlsConnections: tls.connections(), decoyTlsRequests: tls.requests(), failures: await loadFailures(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('an ordinary site is served through the system proxy, which is asked for it', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(proxy.seen).toContain(`GET ${ORDINARY}`)
  })

  it.fails('a .eth name loads', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
  })

  it.fails('the proxy is never asked about a name the verifier serves', () => {
    expect(verifierNames(proxy.seen)).toEqual([])
  })

  it.fails('every session kind sends a name the verifier serves to the verifier and an ordinary name to the proxy', () => {
    for (const kind of Object.keys(facts.sessions['eth']!)) {
      expect(facts.sessions['eth']![kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.sessions['ordinary']![kind], `${kind} session, ordinary`).toMatch(/^PROXY /)
    }
  })

  it.fails('the shell\'s own fetch of a .eth name, which is how it reads an app\'s files, reaches the verifier', () => {
    expect(facts.fromMain).toBe('status 200')
  })

  it('a page a proxy serves under a .eth name over TLS, with a certificate of its own, is never shown', () => {
    expect(facts.decoy.result).not.toBe('page')
    expect(tls.requests(), 'the decoy served no request').toBe(0)
  })

  it.fails('a plain-http page the proxy serves under a .eth name is never shown', () => {
    expect(facts.plain.result, JSON.stringify(facts.plain)).not.toBe('page')
  })
})

describe('a computer with a proxy, the whole browser on a SOCKS5 tunnel', () => {
  let proxy: LoggingProxy
  let socks: Socks5Fixture
  let ordinaryServer: Server
  let running: Running
  let facts: { ordinary: Visit, eth: Visit, offsite: Visit, directEth: Visit, sessions: Record<string, Record<string, string>> }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('offsite.test:8080', 'off site via the proxy')
    ordinaryServer = createHttpServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>ordinary via the tunnel</title><body>tunnel</body>') })
    await new Promise<void>((resolve) => { ordinaryServer.listen(0, '127.0.0.1', resolve) })
    socks = await startSocks5Fixture({ preferAuth: true, names: { 'ordinary.test:8080': { host: '127.0.0.1', port: (ordinaryServer.address() as AddressInfo).port } } })
    running = await launchShell(proxyEnvironment(proxy.url), (dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
      writeFileSync(join(dir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [], via: {}, off: ['https://direct.eth', 'http://offsite.test:8080'], apart: [], apartProxy: [], apartDirect: [] }))
    })
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the tunnel')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const offsite = await visitReporting(app, chrome, 'http://offsite.test:8080/', 'off site via the proxy')
    const directEth = await visitReporting(app, chrome, 'https://direct.eth/', 'verified fixture')
    const sessions = { eth: await resolved(app, 'https://fixture.eth/'), ordinary: await resolved(app, 'https://ordinary.test/') }
    facts = { ordinary, eth, offsite, directEth, sessions }
    report('proxy, tunnel on', { ...facts, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), socksSaw: socks.requests.map((request) => `${request.destination}:${String(request.port)}`).filter((line) => !line.includes('gvt1.com')), failures: await loadFailures(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await socks.close()
    await new Promise<void>((resolve) => { ordinaryServer.close(() => { resolve() }); ordinaryServer.closeAllConnections() })
    await proxy.close()
  })

  it('an ordinary site goes through the tunnel, a website set to off through the system proxy', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(socks.requests.some((request) => request.destination === 'ordinary.test'), 'the tunnel was asked for the ordinary site').toBe(true)
    expect(proxy.seen.filter((line) => line.includes('ordinary.test')), 'and the proxy was not').toEqual([])
    expect(facts.offsite.result).toBe('page')
    expect(proxy.seen).toContain('GET http://offsite.test:8080/')
  })

  it('a .eth name loads in the shared session, which the tunnel\'s front serves, and the proxy is never asked about it', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(facts.sessions['eth']!['default']).toBe('DIRECT')
    expect(facts.sessions['ordinary']!['default']).toMatch(/^PROXY 127\.0\.0\.1:/)
  })

  it.fails('a .eth name of a website set to off loads in the direct profile\'s session, and the proxy is never asked about it', () => {
    expect(facts.directEth.result, JSON.stringify(facts.directEth)).toBe('page')
    expect(verifierNames(proxy.seen)).toEqual([])
  })
})

describe('a proxy that is down', () => {
  it.fails('does not stop a .eth name loading, since the name never goes to the proxy', async () => {
    const { app, chrome } = await launchShell(proxyEnvironment('http://127.0.0.1:1'))
    try {
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
      report('proxy down', { eth, failures: await loadFailures(app) })
      expect(eth.result, JSON.stringify(eth)).toBe('page')
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)
})
