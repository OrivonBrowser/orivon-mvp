// Behind a manual proxy in GNOME's settings or macOS's, Orivon copies the proxy into its sessions with the names the verifier serves left
// out: a .eth name opens and the proxy is never asked about it, an ordinary site is still served through the proxy, the system's
// own exceptions still apply, and a proxy that is moved, turned off or turned on again is followed without a restart. Where the
// settings cannot be read, the guard refuses a name as before and the report says why; where no reader exists yet (a Linux
// computer without GNOME's settings, Windows) nothing is read, copied or changed. The proxy is a forward proxy on loopback that
// logs every `CONNECT` and every plain-HTTP request. The macOS cases change the runner's own network settings with `networksetup`,
// so they run only on GitHub's runner (`node scripts/ci/cross-os.mjs --systems macos --specs test/web3/e2e-eth-system-proxy-mirror.test.ts`).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-system-proxy-mirror.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { gnomeProxy, launchShellOn, macosProxy, ORDINARY, PROXY_SHEET, CANCELLED, refusalLines, report, resolved, startLoggingProxy, verifierNames, visitReporting } from './system-proxy-support.js'
import type { LoggingProxy, MacosProxy, Running } from './system-proxy-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const LINUX = process.platform === 'linux'
const MACOS = process.platform === 'darwin'
/** The macOS cases write the computer's network settings, so they run only on a runner that is thrown away. */
const ON_RUNNER = MACOS && process.env['GITHUB_ACTIONS'] === 'true'
const SETUP_TIMEOUT_MS = 240_000
/** Longer than the 30 s between two reads of the settings. */
const READ_WAIT_MS = 45_000
/** What the system's exceptions cover that no implicit rule does. */
const EXCEPTIONS = ['localhost', '127.0.0.0/8', '::1', '*.lan.test']
/** The exceptions macOS ships, and one more. */
const MACOS_EXCEPTIONS = ['*.local', '169.254/16', '*.lan.test']

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-system-proxy-mirror-'))
  gateway = await startFixtureGateway({ site: SITE })
})

afterAll(async () => {
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const launchShell = async (env: Record<string, string>): Promise<Running> => await launchShellOn(gateway, env)

/** The desktop's proxy settings for a launch of its own, pointing at `port`. */
const desktopProxy = (port: number): ReturnType<typeof gnomeProxy> => gnomeProxy(mkdtempSync(join(scratch, 'desktop-')), port, EXCEPTIONS)

interface SystemProxyFact { readonly source: string, readonly mode: string, readonly state: string, readonly reason: string }

/** Opens `orivon://report` and reads the mirror's fact, the log lines it wrote and the whole preview text, once main has built the preview. The log is read from the report because the lines a launch prints first reach a test's capture of the output only by chance. */
async function reportedMirror (app: ElectronApplication, chrome: Page): Promise<{ fact: SystemProxyFact | undefined, lines: string[], text: string }> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('report.open') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://report') && !w.isClosed()))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://report') && !w.isClosed()) as Page
  await page.waitForSelector('#report-what')
  let text = ''
  let fact: SystemProxyFact | undefined
  let lines: string[] = []
  await waitFor(async () => {
    text = await page.locator('#report-preview').textContent() ?? ''
    try {
      const shown = JSON.parse(text === '' ? '{}' : text) as { log?: string[] | null, diagnostics?: { browser?: { systemProxy?: SystemProxyFact } } }
      fact = shown.diagnostics?.browser?.systemProxy
      lines = (shown.log ?? []).filter((line) => line.includes('[route] system proxy:')).map((line) => line.slice(line.indexOf('[route]')))
    } catch { fact = undefined }
    return fact !== undefined
  }, 15_000)
  return { fact, lines, text }
}

/** Waits until the sessions carry a copy of the proxy at `port`: the proxy answers for an ordinary name and the verifier for a .eth name. Chromium follows a proxy turned on by itself before that, and the guard refuses a name meanwhile. */
async function waitForCopy (app: ElectronApplication, port: number): Promise<void> {
  await waitForAnswer(app, 'https://ordinary.test/', new RegExp(`^PROXY 127\\.0\\.0\\.1:${String(port)}$`))
  await waitForAnswer(app, 'https://fixture.eth/', /^DIRECT$/)
}

/** Waits until the default session answers `url` as `expected` says, which is how a change of the copy shows. A proxy turned on, off or moved is followed within a few seconds (the question to Chromium is asked every 2 s), an edit of the exceptions alone within the 30 s between reads, which `timeoutMs` then has to allow. */
async function waitForAnswer (app: ElectronApplication, url: string, expected: RegExp, timeoutMs = 15_000): Promise<string> {
  let last = ''
  const settled = await waitFor(async () => { last = (await resolved(app, url))['default'] ?? ''; return expected.test(last) }, timeoutMs)
  if (!settled) throw new Error(`the default session still answers ${last} for ${url}`)
  return last
}

/** Has `proxy` answer for the ordinary address with a page of this title, so a visit shows which proxy served it. */
const serveOrdinary = (proxy: LoggingProxy, title: string): void => { proxy.serve('ordinary.test:8080', title) }

describe.skipIf(!LINUX)('a computer whose GNOME settings carry a manual proxy', () => {
  let first: LoggingProxy
  let second: LoggingProxy
  let desktop: ReturnType<typeof gnomeProxy>
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, eth2: Record<string, string>, rootDot: Record<string, string>, ordinarySessions: Record<string, string>, exempt: Record<string, string>, fromMain: string, refusals: string[], rootDotFetch: string, rootDotRefusals: string[] }

  beforeAll(async () => {
    first = await startLoggingProxy()
    second = await startLoggingProxy()
    serveOrdinary(first, 'ordinary via the first proxy')
    serveOrdinary(second, 'ordinary via the second proxy')
    desktop = desktopProxy(first.port)
    running = await launchShell(desktop.env)
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the first proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    const refusals = refusalLines(app)
    // The address bar drops a root dot, so the spelling is asked for by the shell's own fetch, after the refusals above are taken: its refusal is the only one after them.
    const rootDotFetch = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth./'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = {
      ordinary,
      eth,
      eth2: await resolved(app, 'https://fixture.eth/'),
      rootDot: await resolved(app, 'https://fixture.eth./'),
      ordinarySessions: await resolved(app, 'https://ordinary.test/'),
      exempt: await resolved(app, 'http://printer.lan.test/'),
      fromMain,
      refusals,
      rootDotFetch,
      rootDotRefusals: refusalLines(app).slice(refusals.length)
    }
    reported = await reportedMirror(app, chrome)
    report('manual GNOME proxy', { ...facts, mirror: reported.fact, lines: reported.lines, firstSaw: first.seen.filter((line) => !line.includes('gvt1.com')) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await first.close()
    await second.close()
  })

  it('serves an ordinary site through the proxy and a .eth name from the verifier, which the proxy is never asked about', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(first.seen).toContain(`GET ${ORDINARY}`)
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
    expect(first.seen.filter((line) => line.startsWith('CONNECT') && !line.includes('gvt1.com'))).toEqual([])
  })

  it('answers DIRECT for a name the verifier serves in every session kind, and the proxy for an ordinary one', () => {
    for (const kind of Object.keys(facts.eth2)) {
      expect(facts.eth2[kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
    }
  })

  it('leaves the root-dot spelling of a name on the proxy, where the guard refuses it before the proxy is asked', () => {
    for (const kind of Object.keys(facts.rootDot)) expect(facts.rootDot[kind], `${kind} session, .eth with the root dot`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
    expect(facts.rootDotFetch).toContain(CANCELLED)
    expect(facts.rootDotRefusals.filter((line) => line.includes('would have carried it'))).toHaveLength(1)
    expect(verifierNames(first.seen)).toEqual([])
  })

  it('keeps the system\'s own exceptions', () => {
    for (const kind of Object.keys(facts.exempt)) expect(facts.exempt[kind], `${kind} session, an excepted name`).toBe('DIRECT')
  })

  it('reaches the verifier for the shell\'s own fetch of a .eth name, and refuses nothing for the proxy\'s sake', () => {
    expect(facts.fromMain).toBe('status 200')
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
  })

  it('tells the report that the settings are copied, without the proxy\'s address or an exception', () => {
    expect(reported.fact).toEqual({ source: 'gnome', mode: 'manual', state: 'mirrored', reason: 'copied' })
    expect(reported.text).not.toContain(String(first.port))
    expect(reported.text).not.toContain('lan.test')
    expect(reported.lines).toEqual(['[route] system proxy: copied (gnome, manual, copied)'])
  })

  it('follows a proxy moved to another address: the new proxy is asked for the ordinary site and the .eth name still opens', async () => {
    desktop.write(second.port)
    await waitForCopy(running.app, second.port)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the second proxy')
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result).toBe('page')
    expect(second.seen).toContain(`GET ${ORDINARY}`)
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
    expect(verifierNames(second.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)

  it('follows a proxy turned off: nothing is sent to a proxy and the .eth name still opens', async () => {
    desktop.off()
    await waitForAnswer(running.app, 'https://ordinary.test/', /^DIRECT$/)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the second proxy', 8_000)
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result, 'the ordinary site no longer comes from a proxy').not.toBe('page')
    expect(eth.result, JSON.stringify(eth)).toBe('page')
  }, SETUP_TIMEOUT_MS)

  it('follows a proxy turned on again, and the proxy is still never asked about a name the verifier serves', async () => {
    desktop.write(first.port)
    await waitForCopy(running.app, first.port)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the first proxy')
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result).toBe('page')
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)
})

describe.skipIf(!LINUX)('a computer whose GNOME settings carry a manual proxy that Orivon cannot read', () => {
  let proxy: LoggingProxy
  let running: Running
  let facts: { eth: Awaited<ReturnType<typeof visitReporting>>, sessions: Record<string, string> }
  let reported: Awaited<ReturnType<typeof reportedMirror>>

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    proxy.serve('plain.eth', 'served by the proxy as plain.eth')
    // Chromium reads the settings in process; the program Orivon asks for them is not found.
    running = await launchShell({ ...desktopProxy(proxy.port).env, PATH: join(scratch, 'no-programs') })
    const { app, chrome } = running
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    facts = { eth, sessions: await resolved(app, 'https://fixture.eth/') }
    reported = await reportedMirror(app, chrome)
    report('GNOME proxy, settings unreadable', { ...facts, mirror: reported.fact, lines: reported.lines, refusals: refusalLines(app) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
  })

  it('refuses a .eth name, saying the proxy would see it, and the proxy is never asked', () => {
    expect(facts.eth).toMatchObject({ result: 'error', error: CANCELLED, sheet: PROXY_SHEET })
    expect(verifierNames(proxy.seen)).toEqual([])
    for (const kind of Object.keys(facts.sessions)) expect(facts.sessions[kind], `${kind} session, .eth`).toMatch(/^PROXY /)
  })

  it('tells the report that the sessions follow the system\'s own settings, and why', () => {
    expect(reported.fact).toEqual({ source: 'gnome', mode: 'unreadable', state: 'system', reason: 'unreadable' })
    expect(reported.lines).toEqual(['[route] system proxy: left to the system (gnome, unreadable, unreadable)'])
  })
})

describe.skipIf(!ON_RUNNER)('a computer whose macOS settings carry no proxy', () => {
  it('reads and copies nothing, loads a .eth name, and the report says there is no proxy', async () => {
    const mac = macosProxy()
    try {
      await mac.off()
      const { app, chrome } = await launchShell({})
      try {
        const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
        const reported = await reportedMirror(app, chrome)
        report('no proxy in macOS', { eth, mirror: reported.fact, lines: reported.lines })
        expect(eth.result, JSON.stringify(eth)).toBe('page')
        expect(reported.fact).toEqual({ source: 'macos', mode: 'none', state: 'system', reason: 'no-proxy' })
        expect(reported.lines).toEqual(['[route] system proxy: left to the system (macos, none, no-proxy)'])
        for (const [kind, answer] of Object.entries(await resolved(app, 'https://example.com/'))) expect(answer, `${kind} session`).toBe('DIRECT')
      } finally {
        await closeElectronApp(app)
      }
    } finally {
      mac.restore()
    }
  }, SETUP_TIMEOUT_MS)
})

describe.skipIf(!ON_RUNNER)('a computer whose macOS settings carry a manual proxy', () => {
  let first: LoggingProxy
  let second: LoggingProxy
  let mac: MacosProxy
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { ordinary: Awaited<ReturnType<typeof visitReporting>>, eth: Awaited<ReturnType<typeof visitReporting>>, eth2: Record<string, string>, rootDot: Record<string, string>, ordinarySessions: Record<string, string>, listed: Record<string, string>, shipped: Record<string, string>, linkLocal: Record<string, string>, simple: Record<string, string>, fromMain: string, refusals: string[] }

  beforeAll(async () => {
    first = await startLoggingProxy()
    second = await startLoggingProxy()
    serveOrdinary(first, 'ordinary via the first proxy')
    serveOrdinary(second, 'ordinary via the second proxy')
    mac = macosProxy()
    await mac.manual(first.port, MACOS_EXCEPTIONS)
    running = await launchShell({})
    const { app, chrome } = running
    const ordinary = await visitReporting(app, chrome, ORDINARY, 'ordinary via the first proxy')
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    facts = {
      ordinary,
      eth,
      eth2: await resolved(app, 'https://fixture.eth/'),
      rootDot: await resolved(app, 'https://fixture.eth./'),
      ordinarySessions: await resolved(app, 'https://ordinary.test/'),
      listed: await resolved(app, 'http://printer.lan.test/'),
      shipped: await resolved(app, 'http://printer.local/'),
      linkLocal: await resolved(app, 'http://169.254.169.254/'),
      simple: await resolved(app, 'http://intranet/'),
      fromMain,
      refusals: refusalLines(app)
    }
    reported = await reportedMirror(app, chrome)
    report('manual macOS proxy', { ...facts, mirror: reported.fact, lines: reported.lines, firstSaw: first.seen.filter((line) => !line.includes('gvt1.com')) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    mac.restore()
    await first.close()
    await second.close()
  })

  it('serves an ordinary site through the proxy and a .eth name from the verifier, which the proxy is never asked about', () => {
    expect(facts.ordinary.result).toBe('page')
    expect(first.seen).toContain(`GET ${ORDINARY}`)
    expect(facts.eth.result, JSON.stringify(facts.eth)).toBe('page')
    // The proxy is the whole computer's, so other programs' tunnels (Apple's services, Safe Browsing) reach it too: only a name the verifier serves matters.
    expect(verifierNames(first.seen)).toEqual([])
  })

  it('answers DIRECT for a name the verifier serves in every session kind, in both spellings of the name, and the proxy for an ordinary one', () => {
    for (const kind of Object.keys(facts.eth2)) {
      expect(facts.eth2[kind], `${kind} session, .eth`).toBe('DIRECT')
      expect(facts.rootDot[kind], `${kind} session, .eth with the root dot`).toBe('DIRECT')
      expect(facts.ordinarySessions[kind], `${kind} session, ordinary`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
    }
  })

  it('keeps the exceptions macOS ships and the one added, and leaves simple host names to the proxy until they are excluded', () => {
    for (const kind of Object.keys(facts.listed)) {
      expect(facts.listed[kind], `${kind} session, a listed name`).toBe('DIRECT')
      expect(facts.shipped[kind], `${kind} session, a .local name`).toBe('DIRECT')
      expect(facts.linkLocal[kind], `${kind} session, a link-local address`).toBe('DIRECT')
      expect(facts.simple[kind], `${kind} session, a simple host name`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
    }
  })

  it('reaches the verifier for the shell\'s own fetch of a .eth name, and refuses nothing for the proxy\'s sake', () => {
    expect(facts.fromMain).toBe('status 200')
    expect(facts.refusals.filter((line) => !line.includes('plain request'))).toEqual([])
  })

  it('tells the report that the settings are copied, without the proxy\'s address or an exception', () => {
    expect(reported.fact).toEqual({ source: 'macos', mode: 'manual', state: 'mirrored', reason: 'copied' })
    expect(reported.text).not.toContain(String(first.port))
    expect(reported.text).not.toContain('lan.test')
    expect(reported.lines).toEqual(['[route] system proxy: copied (macos, manual, copied)'])
  })

  it('follows a proxy moved to another address: the new proxy is asked for the ordinary site and the .eth name still opens', async () => {
    await mac.manual(second.port)
    await waitForCopy(running.app, second.port)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the second proxy')
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result).toBe('page')
    expect(second.seen).toContain(`GET ${ORDINARY}`)
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
    expect(verifierNames(second.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)

  it('follows a proxy turned off: nothing is sent to a proxy and the .eth name still opens', async () => {
    await mac.off()
    await waitForAnswer(running.app, 'https://ordinary.test/', /^DIRECT$/)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the second proxy', 8_000)
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result, 'the ordinary site no longer comes from a proxy').not.toBe('page')
    expect(eth.result, JSON.stringify(eth)).toBe('page')
  }, SETUP_TIMEOUT_MS)

  it('follows a proxy turned on again, and the proxy is still never asked about a name the verifier serves', async () => {
    await mac.manual(first.port)
    await waitForCopy(running.app, first.port)
    const ordinary = await visitReporting(running.app, running.chrome, ORDINARY, 'ordinary via the first proxy')
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(ordinary.result).toBe('page')
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(first.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)

  it('follows "Exclude simple hostnames" ticked and cleared again, which an edit of the settings alone changes', async () => {
    await mac.simpleHostnames(true)
    await waitForAnswer(running.app, 'http://intranet/', /^DIRECT$/, READ_WAIT_MS)
    for (const [kind, answer] of Object.entries(await resolved(running.app, 'http://intranet/'))) expect(answer, `${kind} session, ticked`).toBe('DIRECT')
    await mac.simpleHostnames(false)
    await waitForAnswer(running.app, 'http://intranet/', new RegExp(`^PROXY 127\\.0\\.0\\.1:${String(first.port)}$`), READ_WAIT_MS)
    for (const [kind, answer] of Object.entries(await resolved(running.app, 'http://intranet/'))) expect(answer, `${kind} session, cleared`).toBe(`PROXY 127.0.0.1:${String(first.port)}`)
    await waitForCopy(running.app, first.port)
  }, SETUP_TIMEOUT_MS)

  it('follows a SOCKS proxy as the SOCKS5 server macOS makes it, and still opens a .eth name', async () => {
    await mac.socks(second.port)
    const answer = await waitForAnswer(running.app, 'https://ordinary.test/', new RegExp(`^SOCKS5 127\\.0\\.0\\.1:${String(second.port)}$`))
    await waitForAnswer(running.app, 'https://fixture.eth/', /^DIRECT$/)
    for (const [kind, one] of Object.entries(await resolved(running.app, 'https://ordinary.test/'))) expect(one, `${kind} session, ordinary`).toBe(answer)
    const eth = await visitReporting(running.app, running.chrome, 'https://fixture.eth/', 'verified fixture')
    expect(eth.result, JSON.stringify(eth)).toBe('page')
    expect(verifierNames(second.seen)).toEqual([])
  }, SETUP_TIMEOUT_MS)
})

describe.skipIf(MACOS)('a computer whose proxy settings Orivon cannot read yet', () => {
  const SOURCE: Record<string, string> = { linux: 'environment', win32: 'windows' }

  it('reads, copies and changes nothing, loads a .eth name, and the report says so', async () => {
    const { app, chrome } = await launchShell({})
    try {
      const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
      const reported = await reportedMirror(app, chrome)
      report('no reader', { eth, mirror: reported.fact, lines: reported.lines })
      expect(eth.result, JSON.stringify(eth)).toBe('page')
      expect(reported.fact).toEqual({ source: SOURCE[process.platform] ?? 'environment', mode: 'unknown', state: 'system', reason: 'no-reader' })
      expect(reported.lines).toEqual([])
      for (const [kind, answer] of Object.entries(await resolved(app, 'https://example.com/'))) expect(answer, `${kind} session`).toBe('DIRECT')
    } finally {
      await closeElectronApp(app)
    }
  }, SETUP_TIMEOUT_MS)
})
