// A computer with a proxy set: the names the verifier serves (`.eth` and the other namespaces) reach the verifier on this
// computer, and a proxy the system sets is kept from them. The proxy here is a forward proxy on loopback that logs every `CONNECT` and
// every plain-HTTP request. A control launch with no proxy proves the page loads when nothing stands in the way, so a failure
// with the proxy is the proxy's.
//
// Where the computer's proxy comes from the environment (Linux with no desktop proxy setting, a shell profile that exports
// `https_proxy`), Orivon adds the verifier's suffixes to `no_proxy` before it starts and the names load. Where it comes
// from the desktop's own settings, GNOME's, KDE's or Windows' manual proxy is copied into the sessions with the suffixes left out and the names
// load (e2e-eth-system-proxy-mirror.test.ts follows it as it changes, and e2e-eth-system-proxy-script.test.ts does the same for a
// proxy script); where the settings cannot be copied (KDE's when its exceptions are reversed), nothing Orivon can set
// exempts a name, so a request for one is cancelled before it is sent and the tab says why. Where the system may run a script of its
// own, the session is not asked at all, since asking hands the name to the script (e2e-eth-system-proxy-script-never-asked.test.ts
// proves it from the script's own log). Automatic detection counts as such a script only while Chromium's answer for an ordinary
// address is not DIRECT: a stock Windows, with "Automatically detect settings" ticked and no script found, opens the names. A name asked for over plain http is never sent, whatever
// the proxy says. A browser on a SOCKS5 tunnel is on its front, which leaves the names to the verifier, whatever the computer's proxy is.
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
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { closeElectronApp, readShield } from '../support/e2e-helpers.js'
import { activeTabInfo } from '../support/smoke-helpers.mjs'
import { CANCELLED, gnomeProxy, launchShellOn, loadFailures, ORDINARY, PLAIN_SHEET, proxyEnvironment, refusalLines, report, resolved, startLoggingProxy, SUBRESOURCES_BODY, UNSURE_SHEET, verifierNames, visitReporting, visitSubresources, windowsAutoDetect } from './system-proxy-support.js'
import type { LoggingProxy, Running, Visit } from './system-proxy-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
/** The environment variables and the GNOME settings these cases write are what Linux reads; Windows and macOS read their own. */
const LINUX = process.platform === 'linux'
const WINDOWS = process.platform === 'win32'
const SETUP_TIMEOUT_MS = 240_000
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

/** A shell on this spec's fixture gateway. */
const launchShell = async (env: Record<string, string>, seedProfile?: (dir: string) => void): Promise<Running> => await launchShellOn(gateway, env, seedProfile)

describe('no proxy at all (the control)', () => {
  it('a .eth name loads and an ordinary name does not resolve, so a failure with a proxy is the proxy\'s', async () => {
    // A new Windows installation has "Automatically detect settings" ticked and nothing else: the control is that computer.
    const restoreSettings = WINDOWS ? windowsAutoDetect() : () => {}
    try {
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
    } finally {
      restoreSettings()
    }
  }, SETUP_TIMEOUT_MS)
})

/** The desktop's proxy settings for a launch of its own, pointing at `port`. */
const desktopProxy = (port: number): ReturnType<typeof gnomeProxy> => gnomeProxy(mkdtempSync(join(scratch, 'desktop-')), port)

describe.skipIf(!LINUX)('a computer whose environment carries the proxy, the browser not on a tunnel', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: { ordinary: Visit, eth: Visit, decoy: Visit, plain: Visit, subresources: Visit, plainTab: { address?: string, title?: string }, plainShield: unknown, sessions: Record<string, Record<string, string>>, refused: string[], fromMain: string, refusals: string[] }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    proxy.serve('plain.eth', 'served by the proxy as plain.eth')
    proxy.serve('subresources.test:8080', 'subresources', SUBRESOURCES_BODY)
    proxy.tunnelTo('decoy.eth', tls.port)
    running = await launchShell(proxyEnvironment(proxy.url))
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const decoy = await visitReporting(app, chrome, 'https://decoy.eth/', 'decoy served')
    const plain = await visitReporting(app, chrome, 'http://plain.eth/', 'served by the proxy as plain.eth')
    const plainTab = await activeTabInfo(chrome)
    const plainShield = await readShield(chrome).catch((error: unknown) => String(error))
    const subresources = await visitSubresources(app, chrome)
    const sessions = { eth: await resolved(app, 'https://fixture.eth/'), ordinary: await resolved(app, 'https://ordinary.test/') }
    const refused = mainOutput(app).split('\n').filter((line) => line.includes('refused certificate'))
    // The shell reads an app's files from a `.eth` name itself, with `net.fetch` on the default session.
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = { ordinary, eth, decoy, plain, subresources, plainTab, plainShield, sessions, refused, fromMain, refusals: refusalLines(app) }
    report('environment proxy, no tunnel', { ...facts, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), decoyTlsConnections: tls.connections(), decoyTlsRequests: tls.requests(), failures: await loadFailures(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('an ordinary site is served through the system proxy, which is asked for it', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(proxy.seen).toContain(`GET ${ORDINARY}`)
  })

  it('a .eth name loads', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
  })

  it('the proxy is never asked about a name the verifier serves', () => {
    expect(verifierNames(proxy.seen)).toEqual([])
  })

  it('every session kind sends a name the verifier serves to the verifier and an ordinary name to the proxy', () => {
    for (const kind of Object.keys(facts.sessions['eth']!)) {
      expect(facts.sessions['eth']![kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.sessions['ordinary']![kind], `${kind} session, ordinary`).toMatch(/^PROXY /)
    }
  })

  it('the shell\'s own fetch of a .eth name, which is how it reads an app\'s files, reaches the verifier', () => {
    expect(facts.fromMain).toBe('status 200')
  })

  it('a page a proxy would serve under a .eth name over TLS, with a certificate of its own, is never shown and never reached', () => {
    expect(facts.decoy.result).not.toBe('page')
    expect(tls.requests(), 'the decoy served no request').toBe(0)
    expect(tls.connections(), 'and nothing connected to it').toBe(0)
  })

  it('a plain-http page the proxy would serve under a .eth name is never shown, and the proxy is never asked for it', () => {
    expect(facts.plain.result, JSON.stringify(facts.plain)).not.toBe('page')
    expect(proxy.seen.filter((line) => line.includes('plain.eth'))).toEqual([])
  })

  it('a page\'s own requests for such names (a picture, a fetch, a WebSocket, a hint to connect ahead) never reach the proxy', () => {
    expect(facts.subresources.result, JSON.stringify(facts.subresources)).toBe('page')
    expect(proxy.seen.filter((line) => /(pre|img|fetched|sock)\.eth/.test(line))).toEqual([])
  })

  it('refuses nothing for the proxy\'s sake, since nothing would have reached it; a plain-http request is refused whatever the proxy is', () => {
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
    expect(facts.refusals.some((line) => line.includes('plain request'))).toBe(true)
    expect(facts.plain).toMatchObject({ result: 'error', error: CANCELLED, sheet: PLAIN_SHEET })
  })
})

describe.skipIf(!LINUX)('a computer whose desktop carries a manual proxy, which no environment variable can exempt', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: { ordinary: Visit, eth: Visit, decoy: Visit, plain: Visit, subresources: Visit, plainTab: { address?: string, title?: string }, sessions: Record<string, Record<string, string>>, refusals: string[], logged: string }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    proxy.serve('plain.eth', 'served by the proxy as plain.eth')
    proxy.serve('subresources.test:8080', 'subresources', SUBRESOURCES_BODY)
    proxy.tunnelTo('decoy.eth', tls.port)
    running = await launchShell(desktopProxy(proxy.port).env)
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const decoy = await visitReporting(app, chrome, 'https://decoy.eth/', 'decoy served')
    const plain = await visitReporting(app, chrome, 'http://plain.eth/', 'served by the proxy as plain.eth')
    const plainTab = await activeTabInfo(chrome)
    const subresources = await visitSubresources(app, chrome)
    const sessions = { eth: await resolved(app, 'https://fixture.eth/'), ordinary: await resolved(app, 'https://ordinary.test/') }
    facts = { ordinary, eth, decoy, plain, subresources, plainTab, sessions, refusals: refusalLines(app), logged: mainOutput(app) }
    report('desktop proxy, no tunnel', { ...facts, logged: undefined, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), decoyTlsConnections: tls.connections(), failures: await loadFailures(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('an ordinary site is still served through the proxy', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(proxy.seen).toContain(`GET ${ORDINARY}`)
  })

  it('every session kind sends a name the verifier serves to the verifier and an ordinary name to the desktop\'s proxy', () => {
    for (const kind of Object.keys(facts.sessions['eth']!)) {
      expect(facts.sessions['eth']![kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.sessions['ordinary']![kind], `${kind} session, ordinary`).toMatch(/^PROXY 127\.0\.0\.1:/)
    }
  })

  it('a .eth name loads', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
  })

  it('the proxy is never asked about a name the verifier serves, a CONNECT included', () => {
    expect(verifierNames(proxy.seen)).toEqual([])
    expect(proxy.seen.filter((line) => line.startsWith('CONNECT') && !line.includes('gvt1.com'))).toEqual([])
  })

  it('a plain-http page under a .eth name is refused, saying it opens only over https, and nothing the proxy would serve is shown', () => {
    expect(facts.plain).toMatchObject({ result: 'error', error: CANCELLED, sheet: PLAIN_SHEET })
    expect(facts.plainTab.title).not.toBe('served by the proxy as plain.eth')
  })

  it('a page a proxy would serve under a .eth name over TLS is never shown and never reached', () => {
    expect(facts.decoy.result).not.toBe('page')
    expect(tls.requests(), 'the decoy served no request').toBe(0)
    expect(tls.connections(), 'and nothing connected to it').toBe(0)
  })

  it('a page\'s own requests for such names (a picture, a fetch, a WebSocket, a hint to connect ahead) never reach the proxy either', () => {
    expect(facts.subresources.result, JSON.stringify(facts.subresources)).toBe('page')
    expect(proxy.seen.filter((line) => /(pre|img|fetched|sock)\.eth/.test(line))).toEqual([])
  })

  it('refuses nothing for the proxy\'s sake, since nothing would have reached it; a plain-http request is refused whatever the proxy is', () => {
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
    expect(facts.refusals.some((line) => line.includes('plain request'))).toBe(true)
  })
})

describe.skipIf(!LINUX)('a computer whose desktop carries a manual proxy, the whole browser on a SOCKS5 tunnel', () => {
  let proxy: LoggingProxy
  let socks: Socks5Fixture
  let ordinaryServer: Server
  let running: Running
  let facts: { ordinary: Visit, eth: Visit, offsite: Visit, directEth: Visit, fromMain: string, refusals: string[] }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('offsite.test:8080', 'off site via the proxy')
    ordinaryServer = createHttpServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>ordinary via the tunnel</title><body>tunnel</body>') })
    await new Promise<void>((resolve) => { ordinaryServer.listen(0, '127.0.0.1', resolve) })
    socks = await startSocks5Fixture({ preferAuth: true, names: { 'ordinary.test:8080': { host: '127.0.0.1', port: (ordinaryServer.address() as AddressInfo).port } } })
    running = await launchShell(desktopProxy(proxy.port).env, (dir) => {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
      writeFileSync(join(dir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, kinds: 1, origins: [], via: {}, off: ['https://direct.eth', 'http://offsite.test:8080'], apart: [], apartProxy: [], apartDirect: [] }))
    })
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the tunnel')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const offsite = await visitReporting(app, chrome, 'http://offsite.test:8080/', 'off site via the proxy')
    const directEth = await visitReporting(app, chrome, 'https://direct.eth/', 'verified fixture')
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = { ordinary, eth, offsite, directEth, fromMain, refusals: refusalLines(app) }
    report('desktop proxy, tunnel on', { ...facts, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), socksSaw: socks.requests.map((request) => `${request.destination}:${String(request.port)}`).filter((line) => !line.includes('gvt1.com')), failures: await loadFailures(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await socks.close()
    await new Promise<void>((resolve) => { ordinaryServer.close(() => { resolve() }); ordinaryServer.closeAllConnections() })
    await proxy.close()
  })

  it('an ordinary site goes through the tunnel, a website set to off through the desktop\'s proxy', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(socks.requests.some((request) => request.destination === 'ordinary.test'), 'the tunnel was asked for the ordinary site').toBe(true)
    expect(proxy.seen.filter((line) => line.includes('ordinary.test')), 'and the proxy was not').toEqual([])
    expect(facts.offsite.result).toBe('page')
    expect(proxy.seen).toContain('GET http://offsite.test:8080/')
  })

  it('a .eth name loads in the shared session, which the tunnel\'s front serves, and is not refused', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(facts.fromMain).toBe('status 200')
  })

  it('a .eth name of a website set to off, which runs in the direct profile on the desktop\'s proxy, loads, and the proxy is never asked about it', () => {
    expect(facts.directEth.result, JSON.stringify(facts.directEth)).toBe('page')
    expect(verifierNames(proxy.seen)).toEqual([])
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
  })

  it('the tunnel never carried a name the verifier serves', () => {
    expect(socks.requests.filter((request) => /\.(eth|orivon)$/.test(request.destination))).toEqual([])
  })
})

describe.skipIf(!LINUX)('a computer whose environment carries the proxy, the whole browser on a SOCKS5 tunnel', () => {
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
    report('environment proxy, tunnel on', { ...facts, proxySaw: proxy.seen.filter((line) => !line.includes('gvt1.com')), socksSaw: socks.requests.map((request) => `${request.destination}:${String(request.port)}`).filter((line) => !line.includes('gvt1.com')), failures: await loadFailures(app) })
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

  it('a .eth name of a website set to off loads in the direct profile\'s session, and the proxy is never asked about it', () => {
    expect(facts.directEth.result, JSON.stringify(facts.directEth)).toBe('page')
    expect(verifierNames(proxy.seen)).toEqual([])
  })
})

describe.skipIf(!WINDOWS)('a computer whose Windows settings detect the proxy automatically', () => {
  let restore: () => void = () => {}

  beforeAll(() => { restore = windowsAutoDetect() })
  afterAll(() => { restore() })

  it('opens a .eth name while detection finds no script, which the mirror knows from Chromium answering DIRECT for ordinary addresses', async () => {
    const { app, chrome } = await launchShell({})
    try {
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture', 60_000)
      report('windows, automatic detection', { eth, refusals: refusalLines(app) })
      expect(eth.result, JSON.stringify(eth)).toBe('page')
      expect(refusalLines(app).join('\n')).not.toContain('may run a script')
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)
})

describe.skipIf(!LINUX)('an environment proxy that is down', () => {
  it('does not stop a .eth name loading, since the name never goes to the proxy', async () => {
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
