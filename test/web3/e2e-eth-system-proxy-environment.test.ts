// On Linux with no desktop proxy setting, Chromium takes its proxy from the environment, and `auto_proxy` there is read before the
// manual variables: it wins over `http_proxy` and the like, and `no_proxy` (which Orivon adds the names it serves to) does not apply
// to it. A script in `auto_proxy` is fetched, wrapped so that a name the verifier serves is always answered DIRECT before the script's
// own text runs, and given to the sessions that follow the system once it answers as Chromium's own session does: a script that sends a
// .eth name to a proxy still opens it, the proxy is never asked about it, and the script's split of the other sites between two proxies is
// kept. A manual proxy in the environment is left to the system, with `no_proxy` keeping the names out of it. An `auto_proxy`
// that is set and empty is automatic detection, which beats the manual variables and is left to the system, where a name is asked
// about only while the mirror's own question about an ordinary address is answered DIRECT, since detection that finds a script would
// show it the name. The desktop here is
// XFCE, one Chromium reads no proxy settings of its own for. The proxies are forward proxies on loopback that log every `CONNECT` and
// every plain-HTTP request. Linux only: the other systems have no such variable to read, so there is nothing to run on a Windows or macOS
// runner.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-system-proxy-environment.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { launchShellOn, ORDINARY, proxyEnvironment, refusalLines, report, reportedMirror, resolved, startLoggingProxy, startScriptServer, tunnelsOpened, verifierNames, visitReporting, waitForAnswer } from './system-proxy-support.js'
import type { LoggingProxy, Running, ScriptServer } from './system-proxy-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const LINUX = process.platform === 'linux'
const SETUP_TIMEOUT_MS = 240_000
/** A site the second proxy serves. */
const OTHER = 'http://other.test:8080/'
/** A desktop Chromium reads no proxy settings of its own for, so it reads the environment. */
const XFCE = { XDG_CURRENT_DESKTOP: 'XFCE' }

let gateway: Awaited<ReturnType<typeof startFixtureGateway>>

beforeAll(async () => {
  gateway = await startFixtureGateway({ site: SITE })
})

afterAll(async () => {
  await gateway.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const launchShell = async (env: Record<string, string>): Promise<Running> => await launchShellOn(gateway, { ...XFCE, ...env })

/** A script that sends `other.test` to the second proxy and every other host, the names the verifier serves among them, to the first. */
const splitScript = (first: number, second: number): string =>
  `function FindProxyForURL(url, host) { return host === "other.test" ? "PROXY 127.0.0.1:${String(second)}" : "PROXY 127.0.0.1:${String(first)}" }`

/** The lines of a proxy's log that are not Chromium's own component updater. */
const asked = (proxy: LoggingProxy): string[] => proxy.seen.filter((line) => !line.includes('gvt1.com'))

describe.skipIf(!LINUX)('a computer whose environment names a proxy script, beside manual variables that name another proxy', () => {
  let first: LoggingProxy
  let second: LoggingProxy
  let manual: LoggingProxy
  let scripts: ScriptServer
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, other: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, eth2: Record<string, string>, ethRootDot: Record<string, string>, ordinarySessions: Record<string, string>, otherSessions: Record<string, string>, fromMain: string, refusals: string[] }

  beforeAll(async () => {
    first = await startLoggingProxy()
    second = await startLoggingProxy()
    manual = await startLoggingProxy()
    first.serve('ordinary.test:8080', 'ordinary via the first proxy')
    second.serve('other.test:8080', 'other via the second proxy')
    scripts = await startScriptServer()
    scripts.serve(splitScript(first.port, second.port))
    running = await launchShell({ auto_proxy: scripts.url, ...proxyEnvironment(manual.url) })
    const { app, chrome } = running
    // Chromium's own answer for the name is the first proxy; the copy answers DIRECT.
    await waitForAnswer(app, 'https://fixture.eth/', /^DIRECT$/, 45_000)
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the first proxy')
    const other = await visitReporting(app, chrome, OTHER, 'other via the second proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = {
      ordinary,
      other,
      eth,
      eth2: await resolved(app, 'https://fixture.eth/'),
      ethRootDot: await resolved(app, 'https://fixture.eth./'),
      ordinarySessions: await resolved(app, 'https://ordinary.test/'),
      otherSessions: await resolved(app, 'https://other.test/'),
      fromMain,
      refusals: refusalLines(app)
    }
    reported = await reportedMirror(app, chrome)
    report('environment script', { ...facts, mirror: reported.fact, lines: reported.lines, firstSaw: asked(first), secondSaw: asked(second), manualSaw: asked(manual) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await first.close()
    await second.close()
    await manual.close()
    await scripts.close()
  })

  it('opens a .eth name though the script sends it to a proxy, and neither proxy is asked about it', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
    expect(verifierNames(second.seen)).toEqual([])
    expect(tunnelsOpened(first.seen)).toEqual([])
  })

  it('keeps the script\'s own split: an ordinary site through the first proxy and another through the second', () => {
    expect(facts.ordinary.result, JSON.stringify(facts.ordinary)).toBe('page')
    expect(first.seen).toContain(`GET ${ORDINARY}`)
    expect(facts.other.result, JSON.stringify(facts.other)).toBe('page')
    expect(second.seen).toContain(`GET ${OTHER}`)
    expect(first.seen.filter((line) => line.includes('other.test'))).toEqual([])
  })

  it('answers DIRECT for a name the verifier serves, with and without the root dot, in every session kind, and the script\'s answer for the rest', () => {
    for (const kind of Object.keys(facts.eth2)) {
      expect(facts.eth2[kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.ethRootDot[kind], `${kind} session, .eth with a root dot`).toBe('DIRECT')
      expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
      expect(facts.otherSessions[kind], `${kind} session, the other site`).toBe(`PROXY 127.0.0.1:${String(second.port)}`)
    }
  })

  it('is read before the manual variables: the proxy they name is never asked for anything', () => {
    expect(asked(manual)).toEqual([])
  })

  it('reaches the verifier for the shell\'s own fetch of a .eth name, and refuses nothing for the proxy\'s sake', () => {
    expect(facts.fromMain).toBe('status 200')
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
  })

  it('tells the report that the script is copied, without its address or its text', () => {
    expect(reported.fact).toEqual({ source: 'environment', mode: 'script', state: 'mirrored', reason: 'copied' })
    for (const secret of [scripts.url, 'proxy.pac', 'FindProxyForURL', String(first.port), String(second.port)]) expect(reported.text, secret).not.toContain(secret)
    expect(reported.lines).toEqual(['[route] system proxy: copied (environment, script, copied)'])
  })
})

describe.skipIf(!LINUX)('a computer whose environment carries a manual proxy and no auto_proxy', () => {
  let proxy: LoggingProxy
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, eth2: Record<string, string>, ordinarySessions: Record<string, string> }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    running = await launchShell(proxyEnvironment(proxy.url))
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    facts = { ordinary, eth, eth2: await resolved(app, 'https://fixture.eth/'), ordinarySessions: await resolved(app, 'https://ordinary.test/') }
    reported = await reportedMirror(app, chrome)
    report('environment manual', { ...facts, mirror: reported.fact, lines: reported.lines, proxySaw: asked(proxy) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('is left to the system: no_proxy keeps the names out of the proxy and ordinary sites go through it', () => {
    expect(facts.ordinary.result, JSON.stringify(facts.ordinary)).toBe('page')
    expect(proxy.seen).toContain(`GET ${ORDINARY}`)
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(verifierNames(proxy.seen)).toEqual([])
    for (const kind of Object.keys(facts.eth2)) {
      expect(facts.eth2[kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toMatch(/^PROXY /)
    }
  })

  it('has nothing to copy, and the report says there is no reader', () => {
    expect(reported.fact).toEqual({ source: 'environment', mode: 'unknown', state: 'system', reason: 'no-reader' })
    expect(reported.lines).toEqual([])
  })
})

describe.skipIf(!LINUX)('a computer whose environment sets auto_proxy and leaves it empty, beside a manual proxy', () => {
  let proxy: LoggingProxy
  let running: Running
  let settled = false
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, ordinarySessions: Record<string, string>, refusals: string[] }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    running = await launchShell({ auto_proxy: '', ...proxyEnvironment(proxy.url) })
    const { app, chrome } = running
    settled = await waitFor(() => mainOutput(app).includes('(environment, detect, detect)'), 60_000)
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    facts = { ordinary, eth, ordinarySessions: await resolved(app, 'https://ordinary.test/'), refusals: refusalLines(app) }
    reported = await reportedMirror(app, chrome)
    report('environment empty', { settled, ...facts, mirror: reported.fact, lines: reported.lines, proxySaw: asked(proxy) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('is automatic detection, which beats the manual variables: the proxy they name is never asked, and the report says detection', () => {
    expect(settled, 'the mirror said it left detection to the system').toBe(true)
    expect(reported.fact).toMatchObject({ source: 'environment', mode: 'detect', state: 'system', reason: 'detect' })
    expect(asked(proxy)).toEqual([])
    for (const kind of Object.keys(facts.ordinarySessions)) expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toBe('DIRECT')
    expect(facts.ordinary.result).not.toBe('page')
  })

  it('opens a .eth name while the probe says detection finds no script: Chromium\'s answer for ordinary addresses is DIRECT, the session is asked, and the report carries that', () => {
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(['direct', 'unsure'], 'never the answer of a search that found something').toContain(reported.fact?.probe)
    expect(facts.refusals.join('\n')).not.toContain('may run a script')
    expect(asked(proxy)).toEqual([])
  })
})
