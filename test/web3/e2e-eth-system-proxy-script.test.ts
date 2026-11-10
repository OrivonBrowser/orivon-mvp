// Behind a proxy script in GNOME's, Windows' or macOS's settings, Orivon fetches the script, wraps it so that a name the verifier serves
// is always answered DIRECT before the script's own text runs, and gives the sessions that follow the system the wrapped copy once it
// answers as Chromium's own session does. A script that sends a .eth name to a proxy still opens it, the proxy is never asked about it, and
// the rest of the script's split between two proxies is kept. A script that answers differently at every question, or that never arrives,
// is left to the system, where the guard refuses a name as it does for any script it cannot copy. The proxies are forward proxies on
// loopback that log every `CONNECT` and every plain-HTTP request. The macOS cases change the runner's own network settings, so they run
// only on GitHub's runner (`node scripts/ci/cross-os.mjs --systems macos --specs test/web3/e2e-eth-system-proxy-script.test.ts`).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-system-proxy-script.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { CANCELLED, gnomeScriptProxy, launchShellOn, macosProxy, ORDINARY, PLAIN_SHEET, refusalLines, report, reportedMirror, resolved, startLoggingProxy, startScriptServer, tunnelsOpened, UNSURE_SHEET, verifierNames, visitReporting, waitForAnswer, windowsScriptProxy } from './system-proxy-support.js'
import type { LoggingProxy, Running, ScriptServer } from './system-proxy-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const LINUX = process.platform === 'linux'
const WINDOWS = process.platform === 'win32'
const MACOS = process.platform === 'darwin'
/** The macOS cases write the computer's network settings, so they run only on a runner that is thrown away. */
const ON_RUNNER = MACOS && process.env['GITHUB_ACTIONS'] === 'true'
const SETUP_TIMEOUT_MS = 240_000
/** A site the second proxy serves. */
const OTHER = 'http://other.test:8080/'

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-system-proxy-script-'))
  gateway = await startFixtureGateway({ site: SITE })
})

afterAll(async () => {
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const launchShell = async (env: Record<string, string>): Promise<Running> => await launchShellOn(gateway, env)

/** A script that sends `other.test` to the second proxy and every other host, the names the verifier serves among them, to the first. */
const splitScript = (first: number, second: number): string =>
  `function FindProxyForURL(url, host) { return host === "other.test" ? "PROXY 127.0.0.1:${String(second)}" : "PROXY 127.0.0.1:${String(first)}" }`

/** A script that sends every host to the proxy at `port`. */
const sendsAllTo = (port: number): string => `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${String(port)}" }`

/** A computer's script setting as the settings window would change it, in whatever form the computer keeps it. */
interface ScriptSettings {
  readonly env: Record<string, string>
  readonly write: (url: string) => void | Promise<void>
  readonly restore: () => void
}

const COMPUTERS: ReadonlyArray<{ readonly name: string, readonly source: string, readonly applies: boolean, readonly set: (url: string) => Promise<ScriptSettings> }> = [
  { name: 'GNOME settings', source: 'gnome', applies: LINUX, set: async (url) => ({ ...gnomeScriptProxy(mkdtempSync(join(scratch, 'desktop-')), url), restore: () => {} }) },
  { name: 'Windows settings, with AutoConfigURL,', source: 'windows', applies: WINDOWS, set: async (url) => { const proxy = windowsScriptProxy(url); return { env: {}, write: proxy.write, restore: proxy.restore } } },
  {
    name: 'macOS settings, with automatic proxy configuration,',
    source: 'macos',
    applies: ON_RUNNER,
    set: async (url) => {
      const proxy = macosProxy()
      await proxy.script(url)
      return { env: {}, write: async (next) => { await proxy.script(next) }, restore: proxy.restore }
    }
  }
]

for (const computer of COMPUTERS) describe.skipIf(!computer.applies)(`a computer whose ${computer.name} name a proxy script`, () => {
  let first: LoggingProxy
  let second: LoggingProxy
  let scripts: ScriptServer
  let desktop: ScriptSettings
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, other: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, eth2: Record<string, string>, ethRootDot: Record<string, string>, ordinarySessions: Record<string, string>, otherSessions: Record<string, string>, fromMain: string, refusals: string[] }

  beforeAll(async () => {
    first = await startLoggingProxy()
    second = await startLoggingProxy()
    first.serve('ordinary.test:8080', 'ordinary via the first proxy')
    second.serve('other.test:8080', 'other via the second proxy')
    scripts = await startScriptServer()
    scripts.serve(splitScript(first.port, second.port))
    desktop = await computer.set(scripts.url)
    running = await launchShell(desktop.env)
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
    report(`script, ${computer.name}`, { ...facts, mirror: reported.fact, lines: reported.lines, firstSaw: first.seen.filter((line) => !line.includes('gvt1.com')), secondSaw: second.seen.filter((line) => !line.includes('gvt1.com')) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await first.close()
    await second.close()
    await scripts.close()
    desktop.restore()
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

  it('answers DIRECT for a name the verifier serves in every session kind, and the script\'s answer for the rest', () => {
    for (const kind of Object.keys(facts.eth2)) {
      expect(facts.eth2[kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.ethRootDot[kind], `${kind} session, .eth with root dots`).toBe('DIRECT')
      expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
      expect(facts.otherSessions[kind], `${kind} session, the other site`).toBe(`PROXY 127.0.0.1:${String(second.port)}`)
    }
  })

  it('reaches the verifier for the shell\'s own fetch of a .eth name, and refuses nothing for the proxy\'s sake', () => {
    expect(facts.fromMain).toBe('status 200')
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
  })

  it('tells the report that the script is copied, without its address or its text', () => {
    expect(reported.fact).toEqual({ source: computer.source, mode: 'script', state: 'mirrored', reason: 'copied' })
    for (const secret of [scripts.url, 'proxy.pac', 'FindProxyForURL', String(first.port), String(second.port)]) expect(reported.text, secret).not.toContain(secret)
    expect(reported.lines).toEqual([`[route] system proxy: copied (${computer.source}, script, copied)`])
  })

  it('follows a script at another address: its proxy is asked for the ordinary site and the .eth name still opens', async () => {
    scripts.serve(sendsAllTo(second.port))
    await desktop.write(`${scripts.url}?second`)
    await waitForAnswer(running.app, 'https://ordinary.test/', new RegExp(`^PROXY 127\\.0\\.0\\.1:${String(second.port)}$`), 45_000)
    await waitForAnswer(running.app, 'https://fixture.eth/', /^DIRECT$/)
    second.serve('ordinary.test:8080', 'ordinary via the second proxy')
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the second proxy')
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result, JSON.stringify(ordinary)).toBe('page')
    expect(second.seen).toContain(`GET ${ORDINARY}`)
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
    expect(verifierNames(second.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)
})

/** What a script can do to take the answer out of the wrapper's hands, in Chromium's own script context. Each answers `proxy` for every host, and `ordinary` is the answer the copy gives an ordinary site (a script that fails answers DIRECT, as Chromium's session does). */
const HOSTILE: ReadonlyArray<{ readonly name: string, readonly text: (proxy: string) => string, readonly ordinary: 'proxy' | 'direct' }> = [
  {
    name: 'assigns its function to the global, bare and through this, at its first call',
    text: (proxy) => `FindProxyForURL = function (url, host) { FindProxyForURL = function () { return "${proxy}" }; this.FindProxyForURL = function () { return "${proxy}" }; return "${proxy}" }`,
    ordinary: 'proxy'
  },
  {
    name: 'redefines the property of its function, as a value and as a getter, at load and in a call',
    text: (proxy) => `try { Object.defineProperty(this, "FindProxyForURL", { value: function () { return "${proxy}" } }) } catch (e) {}\nfunction FindProxyForURL(url, host) { try { Object.defineProperty(this, "FindProxyForURL", { value: function () { return "${proxy}" } }) } catch (e) {} try { Object.defineProperty(this, "FindProxyForURL", { get: function () { return function () { return "${proxy}" } }, configurable: true }) } catch (e) {} return "${proxy}" }`,
    ordinary: 'proxy'
  },
  {
    name: 'assigns its function and then throws',
    text: (proxy) => `FindProxyForURL = function () { return "${proxy}" }; throw new Error("the script stops half way")`,
    ordinary: 'direct'
  }
]

for (const computer of COMPUTERS) describe.skipIf(!computer.applies)(`a computer whose ${computer.name} name a proxy script that goes after the copy`, () => {
  it.each(HOSTILE)('$name: a .eth name is answered DIRECT in every session and neither proxy is asked about it', async (hostile) => {
    const first = await startLoggingProxy()
    const second = await startLoggingProxy()
    first.serve('ordinary.test:8080', 'ordinary via the first proxy')
    const scripts = await startScriptServer()
    scripts.serve(hostile.text(`PROXY 127.0.0.1:${String(first.port)}`))
    const desktop = await computer.set(scripts.url)
    let running: Running | undefined
    try {
      running = await launchShell(desktop.env)
      const { app, chrome } = running
      const settled = await waitFor(() => mainOutput(app).includes(`system proxy: copied (${computer.source}, script, copied)`), 90_000)
      const reported = await reportedMirror(app, chrome)
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
      const ordinary = hostile.ordinary === 'proxy' ? await visitReporting(app, chrome, ORDINARY, 'ordinary via the first proxy') : undefined
      const answers = { eth: await resolved(app, 'https://fixture.eth/'), ethRootDot: await resolved(app, 'https://fixture.eth./'), ordinary: await resolved(app, 'https://ordinary.test/') }
      report(`hostile script, ${computer.name} ${hostile.name}`, { settled, mirror: reported.fact, eth, ordinary, answers, firstSaw: first.seen, secondSaw: second.seen })
      expect(settled, 'the mirror copied the script').toBe(true)
      expect(reported.fact).toEqual({ source: computer.source, mode: 'script', state: 'mirrored', reason: 'copied' })
      for (const kind of Object.keys(answers.eth)) {
        expect(answers.eth[kind], `${kind} session, .eth`).toBe('DIRECT')
        expect(answers.ethRootDot[kind], `${kind} session, .eth with a root dot`).toBe('DIRECT')
        expect(answers.ordinary[kind], `${kind} session, ordinary`).toBe(hostile.ordinary === 'proxy' ? `PROXY 127.0.0.1:${String(first.port)}` : 'DIRECT')
      }
      expect(eth.result, JSON.stringify(eth)).toBe('page')
      if (ordinary !== undefined) expect(ordinary.result, JSON.stringify(ordinary)).toBe('page')
      expect(verifierNames(first.seen)).toEqual([])
      expect(verifierNames(second.seen)).toEqual([])
      expect(tunnelsOpened(first.seen)).toEqual([])
    } finally {
      if (running !== undefined) await closeElectronApp(running.app)
      await first.close()
      await second.close()
      await scripts.close()
      desktop.restore()
    }
  }, SETUP_TIMEOUT_MS)
})

describe.skipIf(!LINUX)('a computer whose GNOME settings name a proxy script that Orivon does not copy', () => {
  let proxy: LoggingProxy
  let scripts: ScriptServer
  let scratchDir: string

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('ordinary.test:8080', 'ordinary via the proxy')
    proxy.serve('plain.eth', 'served by the proxy as plain.eth')
    scripts = await startScriptServer()
    scratchDir = mkdtempSync(join(scratch, 'uncopied-'))
  })

  afterAll(async () => {
    await scripts.close()
    await proxy.close()
  })

  it('copies a script that answers slowly, and opens the names the verifier serves', async () => {
    scripts.serve(sendsAllTo(proxy.port))
    const desktop = gnomeScriptProxy(mkdtempSync(join(scratchDir, 'slow-')), scripts.url)
    const { app, chrome } = await launchShell(desktop.env)
    try {
      await waitForAnswer(app, 'https://fixture.eth/', /^DIRECT$/, 45_000)
      // The next script takes four seconds to arrive, for Chromium's own session and for the copy.
      scripts.serve('function FindProxyForURL(url, host) { return "DIRECT" }', 4_000)
      const askedBefore = scripts.asked()
      desktop.write(`${scripts.url}?slow`)
      await waitForAnswer(app, 'https://ordinary.test/', /^DIRECT$/, 60_000)
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture', 60_000)
      report('script, slow', { eth, scriptAsked: scripts.asked() - askedBefore, refusals: refusalLines(app) })
      expect(eth.result, JSON.stringify(eth)).toBe('page')
      expect(scripts.asked() - askedBefore).toBeGreaterThanOrEqual(2)
      expect(refusalLines(app)).toEqual([])
      expect(verifierNames(proxy.seen)).toEqual([])
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)

  it('leaves a script that answers differently at every question to the system, which refuses a name without asking it, as it does for any script it cannot copy', async () => {
    // A different proxy at every question: no copy can agree with Chromium's own session, and a guard that trusted one answer would let a request out that the next answer sends to a proxy.
    scripts.serve('function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:" + String(20000 + Math.floor(Math.random() * 40000)) }')
    const { app, chrome } = await launchShell(gnomeScriptProxy(mkdtempSync(join(scratchDir, 'alternating-')), scripts.url).env)
    try {
      const settled = await waitFor(() => mainOutput(app).includes('(gnome, script, disagrees)'), 60_000)
      const plain = await visitReporting(app, chrome, 'http://plain.eth/', 'served by the proxy as plain.eth')
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
      const reported = await reportedMirror(app, chrome)
      report('script, alternating', { settled, plain, eth, mirror: reported.fact, refusals: refusalLines(app) })
      expect(settled, 'the mirror said it left the script to the system').toBe(true)
      expect(reported.fact).toEqual({ source: 'gnome', mode: 'script', state: 'system', reason: 'disagrees' })
      expect(plain).toMatchObject({ result: 'error', error: CANCELLED, sheet: PLAIN_SHEET })
      expect(eth).toMatchObject({ result: 'error', error: CANCELLED, sheet: UNSURE_SHEET })
      expect(verifierNames(proxy.seen)).toEqual([])
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)

  it('leaves a script that never arrives to the system, which refuses a name saying Orivon could not tell', async () => {
    scripts.serve(sendsAllTo(proxy.port), 0)
    const desktop = gnomeScriptProxy(mkdtempSync(join(scratchDir, 'silent-')), scripts.url)
    const { app, chrome } = await launchShell(desktop.env)
    try {
      await waitForAnswer(app, 'https://fixture.eth/', /^DIRECT$/, 45_000)
      scripts.serve(null)
      desktop.write(`${scripts.url}?silent`)
      // The copy of the earlier script stays until the fetch of the new one has given up; the name is visited after the sessions went back to the system's own.
      const settled = await waitFor(() => mainOutput(app).includes('(gnome, script, unfetched)'), 90_000)
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture', 90_000)
      const reported = await reportedMirror(app, chrome)
      report('script, silent', { settled, eth, mirror: reported.fact, refusals: refusalLines(app) })
      expect(settled, 'the mirror said the script could not be fetched').toBe(true)
      expect(reported.fact).toEqual({ source: 'gnome', mode: 'script', state: 'system', reason: 'unfetched' })
      expect(eth).toMatchObject({ result: 'error', error: CANCELLED, sheet: UNSURE_SHEET })
      expect(refusalLines(app).join('\n')).toContain('the system\'s proxy settings may run a script, and the session holds no copy of them')
      expect(verifierNames(proxy.seen)).toEqual([])
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)
})
