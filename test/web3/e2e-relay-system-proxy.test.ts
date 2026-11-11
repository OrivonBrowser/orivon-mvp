// With the setting "Look up site addresses in Orivon, not in your proxy" on, a computer whose system settings carry a manual
// proxy is asked for an address and never for a name: Orivon looks each site's address up with a DNS-over-HTTPS query tunnelled
// through that proxy (a fake DNS server on this computer, behind the proxy), then asks the proxy to connect to the address with
// nothing in the request that names the site. Turned off, the proxy is asked for names as before, and turned off in the middle of
// a run, names come back to it. The proxy is a forward proxy on loopback that logs every `CONNECT` with its headers. A name the
// DNS server does not know, one it cannot answer, one whose DNS host the proxy refuses and a proxy that asks for a sign-in each
// show the sheet that names why. A .eth name opens with the proxy seeing nothing, a host the system's exceptions list goes
// direct, and Chromium's net log, over every visit with the setting on (the refusals, an embedded page and a site that offers an
// app included), shows no DNS transaction for a relayed name and no connection that leaves loopback. A page open when the setting
// is turned on is loaded again, and a peer connection in a relayed page gathers no host or server-reflexive candidate. The report
// carries the state, the provider and the counts, and no address. The Linux case reads GNOME's settings; Windows' are written as
// Internet Options writes them, and the macOS case changes the runner's own network settings, so it runs only on GitHub's runner
// (`node scripts/ci/cross-os.mjs --systems windows,macos --specs test/web3/e2e-relay-system-proxy.test.ts`).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-relay-system-proxy.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'
import { appManifest, grantApp, startAppServer } from '../app-behaviours/app-behaviour-support.js'
import type { AppServer } from '../app-behaviours/app-behaviour-support.js'
import { gnomeProxy, launchShellOn, macosProxy, report, resolved, startLoggingProxy, verifierNames, visitReporting, waitForAnswer, windowsManualProxy } from './system-proxy-support.js'
import type { LoggingProxy, Running, Visit } from './system-proxy-support.js'
import { readConnectedAddresses, readNetLog, startNetLog, stopNetLog } from './root-dot-support.js'
import type { NetLogFacts } from './root-dot-support.js'
import { gatherCandidates, holdsKeptPeer, keepPeerConnection, NXDOMAIN, quiet, relayCertificate, reportedRelay, SERVFAIL, setRelaySwitch, startFakeDoh, startFakeSite, startFakeStun } from './name-relay-support.js'
import type { FakeDoh, FakeSite, FakeStun, RelayFact } from './name-relay-support.js'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>verified fixture</title><body>verified</body>' }
const LINUX = process.platform === 'linux'
const WINDOWS = process.platform === 'win32'
const MACOS = process.platform === 'darwin'
/** The macOS case writes the computer's network settings, so it runs only on a runner that is thrown away. */
const ON_RUNNER = MACOS && process.env['GITHUB_ACTIONS'] === 'true'
const SETUP_TIMEOUT_MS = 480_000
/** Closing the shell and five servers, one of them with tunnels open, on a loaded runner. */
const CLEANUP_TIMEOUT_MS = 60_000

/** The site's name, the address the fake DNS server gives it (a documentation address: nothing answers there), and the DNS host the lookups go to. */
const NAME = 'site.relay.test'
/** A name never visited before the switch is turned off: an idle tunnel from an earlier visit may carry a later request to the same name without a new CONNECT. */
const BACK = 'back.relay.test'
const ADDRESS = '203.0.113.7'
const DOH_HOST = 'dns.relay.test'
/** Where the page's icon is: another host, which the shell reads for the tab (a caller that checks the address before it reads). */
const ICON_HOST = 'icons.relay.test'
/** The icon host's address is one a public site could have: the check a caller makes before it reads refuses the documentation address the other names get. */
const ICON_ADDRESS = '93.184.216.34'
/** The host a page shown in an embedded frame comes from, and the one that offers an app: both are looked up by the shell before it reads them, and answer an address a public site could have. */
const EMBED_HOST = 'embed.relay.test'
const APP_HOST = 'app.relay.test'
/** A host the system's exceptions list, which the resolver rule maps to this computer so a direct connection has somewhere to go. */
const EXCEPTED = 'printer.lan.test'
const EXCEPTIONS = ['localhost', '127.0.0.0/8', '::1', '*.lan.test']
const WINDOWS_EXCEPTIONS = '<local>;*.lan.test'
const MACOS_EXCEPTIONS = ['*.local', '169.254/16', '*.lan.test']

let scratch = ''
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
const tls = relayCertificate()

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-name-relay-'))
  gateway = await startFixtureGateway({ site: SITE })
})

afterAll(async () => {
  await gateway.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Every name hidden but the ones under `relay.test`, which a lookup on this computer would have to ask the network for (Chromium's net log shows one), the excepted host and loopback; and the fake servers' certificate trusted. */
const RESOLVER = [`--host-resolver-rules=MAP ${EXCEPTED} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE *.relay.test`, `--ignore-certificate-errors-spki-list=${tls.spki}`]

interface ProxySettings {
  readonly env: Record<string, string>
  readonly restore: () => void
}

const COMPUTERS: ReadonlyArray<{ readonly name: string, readonly applies: boolean, readonly set: (port: number) => Promise<ProxySettings> }> = [
  { name: 'GNOME settings', applies: LINUX, set: async (port) => ({ env: gnomeProxy(mkdtempSync(join(scratch, 'desktop-')), port, EXCEPTIONS).env, restore: () => {} }) },
  {
    name: 'Windows settings, written as Internet Options writes them,',
    applies: WINDOWS,
    set: async (port) => {
      const proxy = windowsManualProxy('both', { server: `127.0.0.1:${String(port)}`, bypass: WINDOWS_EXCEPTIONS, detect: false })
      return { env: {}, restore: proxy.restore }
    }
  },
  {
    name: 'macOS settings',
    applies: ON_RUNNER,
    set: async (port) => {
      const mac = macosProxy()
      await mac.manual(port, MACOS_EXCEPTIONS)
      return { env: {}, restore: mac.restore }
    }
  }
]

/** The lines of a proxy's log that are not Chromium's own component updater. */
const asked = (lines: readonly string[]): string[] => lines.filter((line) => !line.includes('gvt1.com'))

/** Opens `url` in a tab of its own, so the sheet of an earlier failure is not read for this one. */
async function visit (app: ElectronApplication, chrome: Page, url: string, title: string): Promise<Visit> {
  await chrome.click('#new-tab')
  return await visitReporting(app, chrome, url, title, 40_000)
}

/** Waits until the default session answers a site as the relay's own listener (a proxy on this computer that is not the system's). */
async function waitForRelay (app: ElectronApplication, systemPort: number): Promise<string> {
  let last = ''
  const found = await waitFor(async () => {
    last = (await resolved(app, `https://${NAME}/`))['default'] ?? ''
    const port = /^PROXY 127\.0\.0\.1:(\d+)$/.exec(last)?.[1]
    return port !== undefined && Number(port) !== systemPort
  }, 30_000)
  if (!found) throw new Error(`the default session still answers ${last}`)
  return last
}

/** What each of the sessions Orivon makes for its own questions says of its spell checker: it would fetch a dictionary from a fixed host over whatever road the session has. */
const spellCheckers = async (app: ElectronApplication): Promise<Record<string, { enabled: boolean, languages: string[] }>> =>
  await app.evaluate(({ session }) => Object.fromEntries(['orivon-system-proxy', 'orivon-system-mirror'].map((partition) => {
    const one = session.fromPartition(partition)
    return [partition, { enabled: one.isSpellCheckerEnabled(), languages: one.getSpellCheckerLanguages() }]
  })))

/** An ICE candidate that carries an address of this computer, or one the network saw it as. */
const showsAddress = (candidate: string): boolean => /\btyp (?:host|srflx|prflx)\b/.test(candidate)

/** The WebRTC policy of every tab showing a page of `NAME`. */
const rtcPolicies = async (app: ElectronApplication): Promise<string[]> =>
  await app.evaluate(({ webContents }, name) => webContents.getAllWebContents().filter((contents) => contents.getURL().includes(name)).map((contents) => contents.getWebRTCIPHandlingPolicy()), NAME)

for (const computer of COMPUTERS) describe.skipIf(!computer.applies)(`a computer whose ${computer.name} carry a manual proxy`, () => {
  let proxy: LoggingProxy
  let doh: FakeDoh
  let tlsSite: FakeSite
  let plainSite: FakeSite
  let directSite: FakeSite
  let stun: FakeStun
  let embedApp: AppServer
  let settings: ProxySettings
  let running: Running
  let facts: {
    off: { visit: Visit, seen: string[], dohAsked: number, candidates: string[] }
    on: {
      /** Whether the tab that was open before the switch was turned on was loaded again (the peer connection it held is gone), and what a new peer connection gathered in it. */
      reloaded: boolean
      relayedCandidates: string[]
      stunHeard: number
      embed: { outcome: string, seen: string[] }
      appOffered: { visit: Visit, manifestAsked: boolean, seen: string[] }
      spellCheckers: Awaited<ReturnType<typeof spellCheckers>>
      relayAnswer: string
      https: Visit
      iconRead: boolean
      plain: Visit
      eth: Visit
      excepted: Visit
      seen: string[]
      ethSeen: string[]
      connects: LoggingProxy['connects']
      tlsHosts: string[]
      plainHosts: string[]
      directHosts: string[]
      ethSessions: Record<string, string>
      rtc: string[]
      dohAsked: string[]
      addresses: string[]
      lookups: NetLogFacts
    }
    refusals: { missing: Visit, broken: Visit, unreachable: Visit, signIn: Visit }
    reportedOn: Awaited<ReturnType<typeof reportedRelay>>
    after: { visit: Visit, seen: string[], answer: string, rtc: string[], dohAsked: number, reported: Awaited<ReturnType<typeof reportedRelay>> }
  }

  beforeAll(async () => {
    proxy = await startLoggingProxy()
    doh = await startFakeDoh(tls)
    tlsSite = await startFakeSite('relayed site', tls, ICON_HOST, APP_HOST)
    plainSite = await startFakeSite('plain relayed site')
    directSite = await startFakeSite('direct host')
    stun = await startFakeStun()
    embedApp = await startAppServer()
    // Behind this proxy a connection to the site's name and one to its address both reach the site, and the DNS host reaches the fake server.
    proxy.tunnelTo(NAME, tlsSite.port)
    proxy.tunnelTo(BACK, tlsSite.port)
    proxy.tunnelTo(`${ADDRESS}:443`, tlsSite.port)
    proxy.tunnelTo(`${ADDRESS}:80`, plainSite.port)
    proxy.tunnelTo(`${ICON_ADDRESS}:443`, tlsSite.port)
    proxy.tunnelTo(DOH_HOST, doh.port)
    doh.answer(EMBED_HOST, { address: ICON_ADDRESS })
    doh.answer(APP_HOST, { address: ICON_ADDRESS })
    for (const known of [NAME, 'unreach.relay.test', 'signin.relay.test']) doh.answer(known, { address: ADDRESS })
    doh.answer(ICON_HOST, { address: ICON_ADDRESS })
    doh.answer('missing.relay.test', { rcode: NXDOMAIN })
    doh.answer('broken.relay.test', { rcode: SERVFAIL })
    settings = await computer.set(proxy.port)
    running = await launchShellOn(gateway, { ...settings.env, ORIVON_TEST_NAME_RELAY_DOH_URL: `https://${DOH_HOST}/dns-query` }, undefined, RESOLVER)
    const { app, chrome } = running
    // The system's proxy is copied into the sessions before anything is asked of it.
    await waitForAnswer(app, `https://${NAME}/`, new RegExp(`^PROXY 127\\.0\\.0\\.1:${String(proxy.port)}$`), 60_000)

    const offVisit = await visit(app, chrome, `https://${NAME}/off`, 'relayed site /off')
    // A page open before the switch is turned on, with a peer connection of its own: the page gathers this computer's addresses with no setting on, which shows the probe can see them.
    const offCandidates = await gatherCandidates(app, `${NAME}/off`, stun.port)
    await keepPeerConnection(app, `${NAME}/off`)
    const off = { visit: offVisit, seen: asked(proxy.seen), dohAsked: doh.asked.length, candidates: offCandidates }

    // The window opens before the setting is turned on: the page that is loaded again then is a relayed page too.
    const mark = proxy.seen.length
    const connectMark = proxy.connects.length
    const netLogPath = join(scratch, 'relay-net.json')
    await startNetLog(app, netLogPath)
    await setRelaySwitch(app, chrome, true)
    const relayAnswer = await waitForRelay(app, proxy.port)
    // The page is loaded again once the relay is on, so the peer connection it had is gone.
    const reloaded = await waitFor(async () => (await holdsKeptPeer(app, `${NAME}/off`)) === false, 30_000)
    const stunBefore = stun.requests.length
    const relayedCandidates = await gatherCandidates(app, `${NAME}/off`, stun.port)
    const stunHeard = stun.requests.length - stunBefore
    const https = await visit(app, chrome, `https://${NAME}/on`, 'relayed site /on')
    const rtc = await rtcPolicies(app)
    const iconRead = await waitFor(() => tlsSite.hosts.includes(ICON_HOST), 20_000)
    const plain = await visit(app, chrome, `http://${NAME}/plain`, 'plain relayed site /plain')
    await quiet(() => proxy.seen.length)
    const beforeEth = proxy.seen.length
    const eth = await visit(app, chrome, 'https://fixture.eth/', 'verified fixture')
    const ethSeen = asked(proxy.seen.slice(beforeEth))
    const excepted = await visit(app, chrome, `http://${EXCEPTED}:${String(directSite.port)}/direct`, 'direct host /direct')

    // An app shows a site from any host in a frame: the check that the host is no address on this computer's network is the relay's lookup, and the frame is loaded by the relay.
    await grantApp(app, embedApp.origin, appManifest('relay-embed', { web: { embed: { origins: ['*'] } } }), [{ capability: 'web.embed', patterns: ['*'] }])
    await visit(app, chrome, `${embedApp.origin}/`, 'app')
    const beforeEmbed = proxy.seen.length
    const embedOutcome = await app.evaluate(async ({ webContents }, args) => {
      const contents = webContents.getAllWebContents().find((one) => !one.isDestroyed() && one.getURL() === args.page)
      if (contents === undefined) return 'no app tab'
      return await contents.executeJavaScript(`new Promise((resolve) => {
        const frame = document.createElement('webview')
        frame.addEventListener('did-finish-load', () => { resolve('finished') })
        frame.addEventListener('did-fail-load', (event) => { resolve('failed ' + event.errorCode) })
        setTimeout(() => { resolve('timeout') }, 25000)
        frame.src = ${JSON.stringify(args.url)}
        frame.style.width = '400px'
        frame.style.height = '300px'
        document.body.appendChild(frame)
      })`) as string
    }, { page: `${embedApp.origin}/`, url: `https://${EMBED_HOST}/` })
    await quiet(() => proxy.seen.length)
    const embed = { outcome: embedOutcome, seen: asked(proxy.seen.slice(beforeEmbed)) }

    // A site that offers an app is read for its manifest by the loader, which checks the host first and again before the read.
    const beforeApp = proxy.seen.length
    const appVisit = await visit(app, chrome, `https://${APP_HOST}/`, 'relayed site /')
    const manifestAsked = await waitFor(() => tlsSite.requests.includes(`${APP_HOST}/.well-known/orivon.json`), 30_000)
    await quiet(() => proxy.seen.length)
    const appOffered = { visit: appVisit, manifestAsked, seen: asked(proxy.seen.slice(beforeApp)) }

    const on = {
      reloaded,
      relayedCandidates,
      stunHeard,
      embed,
      appOffered,
      spellCheckers: await spellCheckers(app),
      relayAnswer,
      https,
      iconRead,
      plain,
      eth,
      excepted,
      seen: asked(proxy.seen.slice(mark)),
      ethSeen,
      connects: proxy.connects.slice(connectMark),
      tlsHosts: [...tlsSite.hosts],
      plainHosts: [...plainSite.hosts],
      directHosts: [...directSite.hosts],
      ethSessions: await resolved(app, 'https://fixture.eth/'),
      rtc,
      dohAsked: [...doh.asked],
      addresses: [] as string[],
      lookups: { requests: 0, lookups: [], tunnelled: [], proxies: [] } as NetLogFacts
    }

    const missing = await visit(app, chrome, 'https://missing.relay.test/', 'never')
    const broken = await visit(app, chrome, 'https://broken.relay.test/', 'never')
    // A DNS host the proxy will not tunnel to: the lookup's connections end first, so the next query has to ask again.
    proxy.tunnelTo(DOH_HOST, null)
    doh.dropConnections()
    const unreachable = await visit(app, chrome, 'https://unreach.relay.test/', 'never')
    proxy.tunnelTo(DOH_HOST, doh.port)
    proxy.askForSignIn(true)
    doh.dropConnections()
    const signIn = await visit(app, chrome, 'https://signin.relay.test/', 'never')
    proxy.askForSignIn(false)
    // The net log covers every visit above, the refusals too: none of their names was looked up on this computer.
    await stopNetLog(app)
    on.addresses = await readConnectedAddresses(netLogPath)
    on.lookups = await readNetLog(netLogPath, 'relay.test')
    const reportedOn = await reportedRelay(app, chrome, (fact) => fact.state === 'relaying' && Object.values(fact.refused).reduce((sum, count) => sum + count, 0) >= 4)

    const afterMark = proxy.seen.length
    const dohBefore = doh.asked.length
    await setRelaySwitch(app, chrome, false)
    const answer = await waitForAnswer(app, `https://${NAME}/`, new RegExp(`^PROXY 127\\.0\\.0\\.1:${String(proxy.port)}$`), 30_000)
    const again = await visit(app, chrome, `https://${BACK}/again`, 'relayed site /again')
    const reported = await reportedRelay(app, chrome, (fact) => fact.state === 'off')
    const after = { visit: again, seen: asked(proxy.seen.slice(afterMark)), answer, rtc: await rtcPolicies(app), dohAsked: doh.asked.length - dohBefore, reported }
    facts = { off, on, refusals: { missing, broken, unreachable, signIn }, reportedOn, after }
    report(`name relay, ${computer.name}`, { ...facts, reportedOn: { fact: reportedOn.fact, lines: reportedOn.lines }, after: { ...after, reported: { fact: reported.fact, lines: reported.lines } }, connects: proxy.connects.map((connect) => ({ target: connect.target, headers: Object.keys(connect.headers) })) })
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await closeElectronApp(running.app)
    await proxy.close()
    await doh.close()
    await tlsSite.close()
    await plainSite.close()
    await directSite.close()
    await stun.close()
    await embedApp.close()
    settings.restore()
  }, CLEANUP_TIMEOUT_MS)

  it('with the setting off, asks the proxy for the site by name, as before', () => {
    expect(facts.off.visit.result, JSON.stringify(facts.off.visit)).toBe('page')
    expect(facts.off.seen).toContain(`CONNECT ${NAME}:443`)
    expect(facts.off.dohAsked).toBe(0)
    expect(facts.off.seen.filter((line) => line.includes(DOH_HOST))).toEqual([])
  })

  it('with it on, tunnels the DNS query through the proxy first, then asks it to connect to the address, never to the name', () => {
    expect(facts.on.https.result, JSON.stringify(facts.on.https)).toBe('page')
    const dns = facts.on.seen.indexOf(`CONNECT ${DOH_HOST}:443`)
    const connect = facts.on.seen.indexOf(`CONNECT ${ADDRESS}:443`)
    expect(dns, JSON.stringify(facts.on.seen)).toBeGreaterThanOrEqual(0)
    expect(connect, JSON.stringify(facts.on.seen)).toBeGreaterThan(dns)
    expect(facts.on.seen.filter((line) => line.includes(NAME) || line.includes('relay.test') && !line.includes(DOH_HOST))).toEqual([])
    // The relay's own sessions fetch nothing on their own: Electron's spell checker would ask the proxy for a dictionary by name.
    expect(facts.on.connects.filter((connect) => connect.target.includes('gvt1.com')).map((connect) => connect.target)).toEqual([])
    expect(facts.on.dohAsked).toContain(`${NAME} A`)
  })

  it('sends the proxy only the address in the request, and the site receives its own name inside the tunnel', () => {
    const toAddress = facts.on.connects.filter((connect) => connect.target === `${ADDRESS}:443`)
    expect(toAddress.length).toBeGreaterThan(0)
    for (const connect of toAddress) expect(connect.headers, connect.target).toEqual({ host: `${ADDRESS}:443` })
    expect(facts.on.tlsHosts).toContain(NAME)
  })

  it('has the shell read a page\'s icon from another host through the relay too: the address comes from the relay\'s lookup and the read goes to exactly it', () => {
    expect(facts.on.iconRead, 'the icon was read').toBe(true)
    expect(facts.on.dohAsked).toContain(`${ICON_HOST} A`)
    expect(facts.on.seen.filter((line) => line.includes(ICON_HOST))).toEqual([])
    expect(facts.on.seen).toContain(`CONNECT ${ICON_ADDRESS}:443`)
    for (const connect of facts.on.connects.filter((one) => one.target === `${ICON_ADDRESS}:443`)) expect(connect.headers).toEqual({ host: `${ICON_ADDRESS}:443` })
  })

  it('carries plain http as a tunnel to port 80 with the site\'s name inside it', () => {
    expect(facts.on.plain.result, JSON.stringify(facts.on.plain)).toBe('page')
    expect(facts.on.connects.map((connect) => connect.target)).toContain(`${ADDRESS}:80`)
    for (const connect of facts.on.connects.filter((one) => one.target === `${ADDRESS}:80`)) expect(connect.headers, connect.target).toEqual({ host: `${ADDRESS}:80` })
    expect(facts.on.plainHosts).toContain(NAME)
    expect(facts.on.seen.filter((line) => line.startsWith('GET ') || line.includes(`http://${NAME}`))).toEqual([])
  })

  it('shows Chromium\'s net log no DNS transaction and no connection off this computer for a relayed name', () => {
    expect(facts.on.lookups.requests, 'the net log covers the run').toBeGreaterThan(0)
    expect(facts.on.addresses.length, 'the net log saw connections').toBeGreaterThan(0)
    for (const address of facts.on.addresses) expect(address, 'a connection that left this computer').toMatch(/^(127\.0\.0\.1|\[::1\]):\d+$/)
    const transactions = facts.on.lookups.lookups.filter((line) => /HOST_RESOLVER_(MANAGER_JOB|DNS_TASK|SYSTEM_TASK|MANAGER_.*ATTEMPT|.*PROC)|DNS_TRANSACTION/.test(line) && !line.includes('MANAGER_REQUEST'))
    expect(transactions).toEqual([])
  })

  it('looks up the host of an embedded frame and of a site that offers an app through the relay as well, and asks this computer for neither name', () => {
    expect(facts.on.embed.outcome, JSON.stringify(facts.on.embed)).toBe('finished')
    expect(facts.on.dohAsked).toContain(`${EMBED_HOST} A`)
    expect(facts.on.embed.seen.filter((line) => line.includes(EMBED_HOST))).toEqual([])
    expect(facts.on.tlsHosts).toContain(EMBED_HOST)
    expect(facts.on.appOffered.manifestAsked, JSON.stringify(facts.on.appOffered)).toBe(true)
    expect(facts.on.dohAsked).toContain(`${APP_HOST} A`)
    expect(facts.on.appOffered.seen.filter((line) => line.includes(APP_HOST))).toEqual([])
    expect(facts.on.tlsHosts).toContain(APP_HOST)
  })

  it('opens a .eth name with the proxy seeing nothing, and sends a host the system\'s exceptions list direct', () => {
    expect(facts.on.eth.result, JSON.stringify(facts.on.eth)).toBe('page')
    expect(verifierNames(facts.on.seen)).toEqual([])
    expect(facts.on.ethSeen, 'what the proxy was asked while the name opened').toEqual([])
    for (const kind of Object.keys(facts.on.ethSessions)) expect(facts.on.ethSessions[kind], `${kind} session, .eth`).toBe('DIRECT')
    expect(facts.on.excepted.result, JSON.stringify(facts.on.excepted)).toBe('page')
    expect(facts.on.directHosts.length).toBeGreaterThan(0)
    expect(facts.on.seen.filter((line) => line.includes(EXCEPTED))).toEqual([])
  })

  it('confines WebRTC in a relayed page, and only while the relay is on', () => {
    expect(facts.on.rtc.length).toBeGreaterThan(0)
    for (const policy of facts.on.rtc) expect(policy).toBe('disable_non_proxied_udp')
    expect(facts.after.rtc.length).toBeGreaterThan(0)
    for (const policy of facts.after.rtc) expect(policy).toBe('default')
  })

  it('loads a page that was open when the setting went on again, and a peer connection there gathers no address of this computer and reaches no STUN server', () => {
    expect(facts.off.candidates.filter(showsAddress).length, `with the setting off the probe sees this computer: ${JSON.stringify(facts.off.candidates)}`).toBeGreaterThan(0)
    expect(facts.on.reloaded, 'the page was loaded again').toBe(true)
    expect(facts.on.relayedCandidates.filter(showsAddress)).toEqual([])
    expect(facts.on.stunHeard, 'datagrams a STUN server on this computer received').toBe(0)
  })

  it('keeps the spell checker off in the sessions that ask the system for its proxy, which would fetch a dictionary from a fixed host', () => {
    expect(Object.keys(facts.on.spellCheckers).length).toBeGreaterThan(0)
    for (const [partition, state] of Object.entries(facts.on.spellCheckers)) {
      expect(state.enabled, partition).toBe(false)
      // macOS checks spelling with the system's own checker, which fetches nothing and keeps its own list of languages.
      if (!MACOS) expect(state.languages, partition).toEqual([])
    }
  })

  it('shows the sheet that names the switch for a name nobody knows, and the other sheets for what else failed', () => {
    const { missing, broken, unreachable, signIn } = facts.refusals
    expect(missing.result, JSON.stringify(missing)).toBe('error')
    expect(missing.sheet).toContain('could not find this site\'s address')
    expect(missing.sheet).toContain('Look up site addresses in Orivon')
    expect(broken.result, JSON.stringify(broken)).toBe('error')
    expect(broken.sheet).toContain('could not reach Quad9 through your proxy')
    expect(unreachable.result, JSON.stringify(unreachable)).toBe('error')
    expect(unreachable.sheet).toContain('Your proxy could not be reached, or could not reach this site')
    expect(signIn.result, JSON.stringify(signIn)).toBe('error')
    expect(signIn.sheet).toContain('asks for a sign-in')
  })

  it('tells the report the state, the provider and the counts, and no address, name or proxy', () => {
    const fact = facts.reportedOn.fact as RelayFact
    expect(fact.state).toBe('relaying')
    expect(fact.provider).toBe('quad9')
    expect(fact.resolver).toBe('held')
    for (const word of ['not-found', 'no-answer', 'unreachable', 'sign-in']) expect(fact.refused[word], word).toBeGreaterThanOrEqual(1)
    // Only the pinned endpoint says `unpinned`, and only the favicon read is pointed at it: every page, subresource and background request of the default session goes the relay's way and is never counted here.
    for (const word of ['inside', 'anonymity', 'unsure', 'unpinned']) expect(fact.refused[word], word).toBe(0)
    // The log carries Electron's own line for each failed load, with the page's address: the relay adds none of its own.
    for (const secret of [ADDRESS, DOH_HOST, String(proxy.port), EXCEPTED]) expect(facts.reportedOn.text, secret).not.toContain(secret)
    for (const secret of [ADDRESS, NAME, DOH_HOST, 'relay.test', String(proxy.port), EXCEPTED]) expect(JSON.stringify({ fact, lines: facts.reportedOn.lines }), secret).not.toContain(secret)
    expect(facts.reportedOn.lines).toContain('[route] name relay: relaying (quad9, resolver held)')
    expect(facts.reportedOn.lines.filter((line) => line.startsWith('[route] name relay stopped a connection: '))).not.toEqual([])
  })

  it('brings names back to the proxy when it is turned off in the middle of a run', () => {
    expect(facts.after.answer).toBe(`PROXY 127.0.0.1:${String(proxy.port)}`)
    expect(facts.after.visit.result, JSON.stringify(facts.after.visit)).toBe('page')
    expect(facts.after.seen).toContain(`CONNECT ${BACK}:443`)
    expect(facts.after.dohAsked).toBe(0)
    expect(facts.after.reported.fact?.state).toBe('off')
    expect(facts.after.reported.fact?.resolver).toBe('setting')
  })
})
