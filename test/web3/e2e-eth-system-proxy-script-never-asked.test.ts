// Behind a proxy script Orivon does not copy, a name the verifier serves is never put to the script. Chromium runs the system's
// script with the host of every request, and a script that resolves what it is shown (`dnsResolve`) hands the name to a DNS
// server, whatever it then answers. This script says each host it is run with (`alert`, which the net log records), resolves
// `<host>.leak.test` and answers a different proxy at every question, so no copy of it ever agrees with Chromium's own session and
// the sessions stay on the system's own config. The proof is the script's own log, which the net log records: the script says every
// host it is run with, so with the sessions refusing the name unasked no line names it, while the control (an ordinary site) shows
// the script saying the host it was run with. The net log does not record a script's `dnsResolve`, so a count of lookups of
// `<host>.leak.test` would prove nothing and none is made; the net log also holds no request for the name, no connection through a
// proxy for it and no proxy list resolved for it. One case turns the script on while the browser runs: the mirror notices, and
// from then on the name is refused and never shown to the script. The refusal says what a name it could not tell about says. Run on GNOME's settings, Windows' `AutoConfigURL` and macOS's
// automatic proxy configuration; the macOS cases change the runner's own network settings, so they run only on GitHub's runner
// (`node scripts/ci/cross-os.mjs --systems windows,macos --specs test/web3/e2e-eth-system-proxy-script-never-asked.test.ts`).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-eth-system-proxy-script-never-asked.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors, mainOutput } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { CANCELLED, gnomeProxy, gnomeScriptProxy, launchShellOn, macosProxy, ORDINARY, PLAIN_SHEET, refusalLines, report, reportedMirror, startScriptServer, UNSURE_SHEET, visitReporting, windowsScriptProxy } from './system-proxy-support.js'
import type { Running, ScriptServer } from './system-proxy-support.js'
import { readNetLog, readPacAlerts, startNetLog, stopNetLog } from './root-dot-support.js'
import type { NetLogFacts } from './root-dot-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const LINUX = process.platform === 'linux'
const WINDOWS = process.platform === 'win32'
const MACOS = process.platform === 'darwin'
/** The macOS cases write the computer's network settings, so they run only on a runner that is thrown away. */
const ON_RUNNER = MACOS && process.env['GITHUB_ACTIONS'] === 'true'
const SETUP_TIMEOUT_MS = 240_000

/** Says which host it is run with, resolves `<host>.leak.test` for it, and sends it to a proxy no question repeats: no copy of it can agree with Chromium's own session. */
const LEAKING_SCRIPT = 'function FindProxyForURL(url, host) { alert("asked " + host); dnsResolve(host + ".leak.test"); return "PROXY 127.0.0.1:" + String(20000 + Math.floor(Math.random() * 40000)) }'

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-system-script-never-asked-'))
  gateway = await startFixtureGateway({ site: SITE })
})

afterAll(async () => {
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** A computer's script setting as the settings window would put it, in whatever form the computer keeps it. */
interface ScriptSettings {
  readonly env: Record<string, string>
  readonly restore: () => void
}

const COMPUTERS: ReadonlyArray<{ readonly name: string, readonly source: string, readonly applies: boolean, readonly set: (url: string) => Promise<ScriptSettings> }> = [
  { name: 'GNOME settings', source: 'gnome', applies: LINUX, set: async (url) => ({ env: gnomeScriptProxy(mkdtempSync(join(scratch, 'desktop-')), url).env, restore: () => {} }) },
  { name: 'Windows settings, with AutoConfigURL,', source: 'windows', applies: WINDOWS, set: async (url) => ({ env: {}, restore: windowsScriptProxy(url).restore }) },
  {
    name: 'macOS settings, with automatic proxy configuration,',
    source: 'macos',
    applies: ON_RUNNER,
    set: async (url) => {
      const proxy = macosProxy()
      await proxy.script(url)
      return { env: {}, restore: proxy.restore }
    }
  }
]

/** What the net log holds for the name asked for, and the hosts the script was run with. */
interface Logged { readonly name: NetLogFacts, readonly alerts: string[] }

for (const computer of COMPUTERS) describe.skipIf(!computer.applies)(`a computer whose ${computer.name} name a proxy script that answers differently at every question`, () => {
  let scripts: ScriptServer
  let desktop: ScriptSettings
  let running: Running
  let reported: Awaited<ReturnType<typeof reportedMirror>>
  let facts: { eth: Awaited<ReturnType<typeof visitReporting>>, plain: Awaited<ReturnType<typeof visitReporting>>, control: Awaited<ReturnType<typeof visitReporting>>, fromMain: string, refusals: string[], logged: Logged }

  beforeAll(async () => {
    scripts = await startScriptServer()
    scripts.serve(LEAKING_SCRIPT)
    desktop = await computer.set(scripts.url)
    running = await launchShellOn(gateway, desktop.env)
    const { app, chrome } = running
    const settled = await waitFor(() => mainOutput(app).includes(`(${computer.source}, script, disagrees)`), 90_000)
    if (!settled) throw new Error('the mirror never said it left the script to the system')
    const logPath = join(scratch, `net-${computer.source}.json`)
    await startNetLog(app, logPath)
    // The control first: an ordinary site makes the script run with its host, and the script says so, which shows the log sees what the script does.
    const control = await visitReporting(app, chrome, ORDINARY, 'never loads', 8_000)
    const eth = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const plain = await visitReporting(app, chrome, 'http://fixture.eth/', 'verified fixture')
    const fromMain = await app.evaluate(async ({ net }) => { try { const response = await net.fetch('https://fixture.eth/'); return `status ${String(response.status)}` } catch (error) { return String(error) } })
    await stopNetLog(app)
    facts = {
      eth,
      plain,
      control,
      fromMain,
      refusals: refusalLines(app),
      logged: { name: await readNetLog(logPath, 'fixture.eth'), alerts: await readPacAlerts(logPath) }
    }
    reported = await reportedMirror(app, chrome)
    report(`script never asked, ${computer.name}`, { ...facts, mirror: reported.fact })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await scripts.close()
    desktop.restore()
  })

  it('has left the script to the system, which the report says', () => {
    expect(reported.fact).toEqual({ source: computer.source, mode: 'script', state: 'system', reason: 'disagrees' })
  })

  it('shows in the net log the host the script was run with for an ordinary site, so a name put to it would show too', () => {
    expect(facts.logged.alerts.join('\n'), JSON.stringify(facts.control)).toContain('asked ordinary.test')
  })

  it('refuses the name saying Orivon could not tell, without asking the script', () => {
    expect(facts.eth).toMatchObject({ result: 'error', error: CANCELLED, sheet: UNSURE_SHEET })
    expect(facts.refusals.join('\n')).toContain('the system\'s proxy settings may run a script, and the session holds no copy of them, so the name was not put to them')
  })

  it('records no word of the script naming it, no host-resolution event for it, no request for it that started, and no proxy list resolved for it', () => {
    expect(facts.logged.name.lookups).toEqual([])
    expect(facts.logged.name.requests).toBe(0)
    expect(facts.logged.name.tunnelled).toEqual([])
    expect(facts.logged.name.proxies).toEqual([])
    expect(facts.logged.alerts.filter((said) => said.includes('fixture.eth'))).toEqual([])
  })

  it('refuses the shell\'s own fetch of the name the same way, and a plain request for it says it opens only over https', () => {
    expect(facts.fromMain).not.toBe('status 200')
    expect(facts.plain).toMatchObject({ result: 'error', error: CANCELLED, sheet: PLAIN_SHEET })
  })
})

/** A script turned on while the browser runs: until the mirror reads the settings the name may be put to Chromium's session, which is why the visit waits for the mirror's word. */
describe.skipIf(!LINUX)('a computer whose proxy script is turned on while the browser runs', () => {
  let scripts: ScriptServer
  let running: Running
  let facts: { before: Awaited<ReturnType<typeof visitReporting>>, control: Awaited<ReturnType<typeof visitReporting>>, after: Awaited<ReturnType<typeof visitReporting>>, refusals: string[], alerts: string[], logged: NetLogFacts }

  beforeAll(async () => {
    scripts = await startScriptServer()
    scripts.serve(LEAKING_SCRIPT)
    const desktop = gnomeProxy(mkdtempSync(join(scratch, 'desktop-')), 1)
    desktop.off()
    running = await launchShellOn(gateway, desktop.env)
    const { app, chrome } = running
    const before = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    desktop.script(scripts.url)
    const settled = await waitFor(() => mainOutput(app).includes('(gnome, script, disagrees)'), 90_000)
    if (!settled) throw new Error('the mirror never said it left the script to the system')
    const logPath = join(scratch, 'net-turned-on.json')
    await startNetLog(app, logPath)
    const control = await visitReporting(app, chrome, ORDINARY, 'never loads', 8_000)
    const after = await visitReporting(app, chrome, 'https://fixture.eth/', 'verified fixture')
    await stopNetLog(app)
    facts = { before, control, after, refusals: refusalLines(app), alerts: await readPacAlerts(logPath), logged: await readNetLog(logPath, 'fixture.eth') }
    report('script never asked, turned on while running', facts)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await scripts.close()
  })

  it('opened the name while there was no script, and shows the script the ordinary site once there is one', () => {
    expect(facts.before.result, JSON.stringify(facts.before)).toBe('page')
    expect(facts.alerts.join('\n'), JSON.stringify(facts.control)).toContain('asked ordinary.test')
  })

  it('refuses the name from then on, without the script being run with it', () => {
    expect(facts.after).toMatchObject({ result: 'error', error: CANCELLED, sheet: UNSURE_SHEET })
    expect(facts.refusals.join('\n')).toContain('the system\'s proxy settings may run a script, and the session holds no copy of them')
    expect(facts.alerts.filter((said) => said.includes('fixture.eth'))).toEqual([])
    expect(facts.logged.requests).toBe(0)
    expect(facts.logged.proxies).toEqual([])
  })
})
