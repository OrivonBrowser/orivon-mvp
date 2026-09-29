// web.embed end to end (ADR-0039), against the real shell and the real
// broker: an app tab holding the grant puts a <webview> in its page, the
// shown site loads in the app's own embed partition with the shell's
// preload and no orivon.*, the app's script runs there first under a strict
// page CSP and talks to the element both ways, a site outside the grant is
// refused, popups go nowhere, an ordinary tab's <webview> stays inert, and
// revoking the grant closes the shown page.
//
// Same launch/grant-hook/teardown shape as ./e2e-web-context.test.ts. The
// shown sites are two loopback servers this file starts itself, on ports no
// other e2e file uses: 8899 (granted) and 8900 (never granted).
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-embed.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { asPage, closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from './e2e-helpers.js'
import { AS_PAGE_SCRIPT_URL, clearFixtureAsPageScript, setFixtureAsPageScript } from './fixture-as-page.js'
import { HOST, STATIC_PORT } from './apps/fixture/config.mjs'
import { embedPartitionFor } from '../src/main/embed/embed-guard.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('./apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const FIXTURE_URL = `${FIXTURE_ORIGIN}/`
/** asPage's (e2e-helpers.ts) same-origin script URL: the window.orivon call below runs as a script the fixture page loaded, never through page.evaluate() (ADR-0045). */
const AS_PAGE_URL = `${FIXTURE_URL}${AS_PAGE_SCRIPT_URL}`
const SITE_PORT = 8899
const OTHER_PORT = 8900
const SITE_ORIGIN = `http://${HOST}:${SITE_PORT}`
const OTHER_ORIGIN = `http://${HOST}:${OTHER_PORT}`
const STEP_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 180_000

// A286: a name that resolves to loopback -- not a literal, so
// embed-origin.ts's own hostname gate cannot see it; only guestRequestAllowedAsync's
// resolveHost check can. Mapped by its OWN --host-resolver-rules entry
// (below), ahead of the file's usual blackhole rule, to the SAME already-
// listening `site` server -- no third HTTP server needed.
const REBIND_HOST = 'rebind.orivon-embed-e2e.invalid'
const REBIND_URL = `http://${REBIND_HOST}:${SITE_PORT}/`

/** The app's own script for every page it shows: marks the page before its own code runs, and answers the element. */
const PAGE_SCRIPT = `
  window.orivonProbe = { value: 'injected-first' };
  orivonEmbed.sendToHost('hello', location.href);
  orivonEmbed.on('ping', function (value) { orivonEmbed.sendToHost('pong', value * 2); });
`

/** A site under a CSP that forbids inline and eval script: the page script must still run, and first. */
function shownSite (label: string): Server {
  return createServer((req, res) => {
    if (req.url === '/probe.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end("document.title = 'probe:' + typeof window.orivonProbe + ':' + (window.orivonProbe ? window.orivonProbe.value : '-')")
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'self'"
    })
    res.end(`<!doctype html><html><head><title>${label}</title></head><body><h1>${label}</h1><script src="/probe.js"></script></body></html>`)
  })
}

let staticServer: ChildProcess
const site = shownSite('shown site')
const other = shownSite('other site')

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await Promise.all([
    new Promise<void>((resolve) => { site.listen(SITE_PORT, HOST, resolve) }),
    new Promise<void>((resolve) => { other.listen(OTHER_PORT, HOST, resolve) })
  ])
  await Promise.all([waitForTcpReady(HOST, STATIC_PORT, 10_000), waitForTcpReady(HOST, SITE_PORT, 10_000), waitForTcpReady(HOST, OTHER_PORT, 10_000)])
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
  await Promise.all([site, other].map(async (server) => await new Promise<void>((resolve) => { server.close(() => resolve()) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function testManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.embed-e2e',
    name: 'Orivon embed e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { web: { embed: { origins: [SITE_ORIGIN] } } }
  }
}

function wildcardManifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.embed-e2e-wildcard',
    name: 'Orivon embed e2e wildcard fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { web: { embed: { origins: ['*'] } } }
  }
}

/** The run's constants, stashed on the app page for the retrying callbacks. */
interface E2eArgs { readonly siteUrl: string, readonly otherUrl: string, readonly script: string }

/** The element's surface this file drives, typed here rather than through Electron's own `WebviewTag` so the evaluate callbacks stay self-contained. */
interface WebviewLike extends HTMLElement {
  src: string
  loadURL: (url: string) => Promise<void>
  getTitle: () => string
  getURL: () => string
  getWebContentsId: () => number
  executeJavaScript: (code: string) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
}

it(
  'an app tab shows a granted site in a <webview> in its own embed partition, its page script runs first under a strict CSP and ' +
  'talks to the element both ways, an ungranted site and a file: URL are refused, popups go nowhere, an ordinary tab\'s element ' +
  'is inert, and revoking the grant closes the shown page',
  async () => {
    await runPhase('web.embed e2e', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: FIXTURE_ORIGIN, manifest: testManifest(), capability: 'web.embed', patterns: [SITE_ORIGIN] } satisfies DevGrantRequest)
        check('the developer-only grant hook is installed in this build', grantOutcome.installed)
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')
        const grantId = grantOutcome.grant.id

        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')
        // evaluateRetrying's callback takes no argument, so the run's constants
        // are stashed on the page once and read back inside each callback.
        await view.evaluate((args: E2eArgs) => { (window as unknown as { __orivonE2eArgs: E2eArgs }).__orivonE2eArgs = args },
          { siteUrl: `${SITE_ORIGIN}/`, otherUrl: `${OTHER_ORIGIN}/`, script: PAGE_SCRIPT } satisfies E2eArgs)

        // ---- (1) the element is live in the app tab, the script is set, and a granted site loads with the script first.
        const loaded = await asPage(view, setFixtureAsPageScript, AS_PAGE_URL, async () => {
          const args = (window as unknown as { __orivonE2eArgs: E2eArgs }).__orivonE2eArgs
          const orivon = (window as unknown as { orivon: { web: { setEmbedScript: (source: string) => Promise<void> } } }).orivon
          await orivon.web.setEmbedScript(args.script)
          const el = document.createElement('webview') as WebviewLike
          const live = typeof el.loadURL === 'function'
          const messages: Array<{ channel: string, args: unknown[] }> = []
          el.addEventListener('ipc-message', (event) => {
            const { channel, args: eventArgs } = event as unknown as { channel: string, args: unknown[] }
            messages.push({ channel, args: eventArgs })
          })
          const finished = new Promise<string>((resolve) => {
            el.addEventListener('did-finish-load', () => { resolve('finished') })
            el.addEventListener('did-fail-load', (event) => { resolve(`failed:${String((event as unknown as { errorCode: number }).errorCode)}`) })
            setTimeout(() => { resolve('timeout') }, 15_000)
          })
          el.setAttribute('preload', 'file:///tmp/the-apps-own-preload.js')
          el.setAttribute('nodeintegration', 'true')
          el.setAttribute('partition', 'persist:the-apps-choice')
          el.src = args.siteUrl
          el.style.width = '400px'
          el.style.height = '300px'
          document.body.appendChild(el)
          ;(window as unknown as { __orivonE2eView: WebviewLike, __orivonE2eMessages: typeof messages }).__orivonE2eView = el
          ;(window as unknown as { __orivonE2eMessages: typeof messages }).__orivonE2eMessages = messages
          const outcome = await finished
          await new Promise((resolve) => { setTimeout(resolve, 200) })
          return { live, outcome, title: el.getTitle(), messages: messages.slice(), guestId: el.getWebContentsId() }
        })
        check('<webview> is a live element in the app tab', loaded.live, JSON.stringify(loaded))
        check('the granted site loads', loaded.outcome === 'finished', JSON.stringify(loaded))
        check(
          'the app\'s page script ran before the page\'s own script, under a CSP that forbids inline script (the page\'s own script saw the injected global)',
          loaded.title === 'probe:object:injected-first',
          JSON.stringify(loaded)
        )
        check(
          'the page script reached the element through orivonEmbed.sendToHost (ipc-message "hello" with the page URL)',
          loaded.messages.some((m: { channel: string, args: unknown[] }) => m.channel === 'hello' && m.args[0] === `${SITE_ORIGIN}/`),
          JSON.stringify(loaded.messages)
        )

        // ---- (2) the element's send() reaches the page script's orivonEmbed.on, and it answers.
        const pong = await evaluateRetrying(view, async () => {
          const el = (window as unknown as { __orivonE2eView: WebviewLike }).__orivonE2eView
          const messages = (window as unknown as { __orivonE2eMessages: Array<{ channel: string, args: unknown[] }> }).__orivonE2eMessages
          el.send('ping', 21)
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const found = messages.find((m) => m.channel === 'pong')
            if (found !== undefined) return found.args[0]
            await new Promise((resolve) => { setTimeout(resolve, 50) })
          }
          return 'no pong'
        }, STEP_TIMEOUT_MS)
        check('element.send() reaches the page script, which answers over sendToHost (pong 42)', pong === 42, JSON.stringify(pong))

        // ---- (3) the shown page: sandboxed, no orivon.*, no Node, no popups, in the app's own embed partition.
        const inside = await evaluateRetrying(view, async () => {
          const el = (window as unknown as { __orivonE2eView: WebviewLike }).__orivonE2eView
          return await el.executeJavaScript(
            '[typeof orivon, typeof require, typeof process, typeof __orivonEmbedBridge, String(window.open("https://example.com/") === null)].join(":")'
          )
        }, STEP_TIMEOUT_MS)
        check(
          'inside the shown page there is no orivon, no require, no process, the bridge global is gone, and window.open returns null',
          inside === 'undefined:undefined:undefined:undefined:true',
          String(inside)
        )
        const partition = await app.evaluate(({ webContents, session }, args: { guestId: number, partition: string }) => {
          const guest = webContents.fromId(args.guestId)
          if (guest === undefined) return { found: false as const }
          return {
            found: true as const,
            type: guest.getType(),
            inEmbedPartition: guest.session === session.fromPartition(args.partition),
            inDefaultSession: guest.session === session.defaultSession
          }
        }, { guestId: loaded.guestId, partition: embedPartitionFor(FIXTURE_ORIGIN) })
        check(
          'the guest is a webview in the app\'s own persist:embed- partition, never the default session',
          partition.found && partition.type === 'webview' && partition.inEmbedPartition && !partition.inDefaultSession,
          JSON.stringify(partition)
        )

        // ---- (4) a document outside the grant, and a file: URL, are refused; the granted site loads again after.
        const refused = await evaluateRetrying(view, async () => {
          const args = (window as unknown as { __orivonE2eArgs: E2eArgs }).__orivonE2eArgs
          const el = (window as unknown as { __orivonE2eView: WebviewLike }).__orivonE2eView
          // A refused document load never commits: the element's loadURL()
          // rejects and the guest stays on the page it was showing. Electron
          // fires no did-fail-load for it, so the rejection is the signal.
          const attempt = async (url: string): Promise<string> => {
            const before = el.getURL()
            try {
              await el.loadURL(url)
            } catch (error) {
              return `rejected (${String((error as { message?: string })?.message ?? error).includes('ERR_') ? 'net error' : 'other'}) still-at:${el.getURL() === before ? 'same' : el.getURL()}`
            }
            return `finished:${el.getTitle()}`
          }
          const otherSite = await attempt(args.otherUrl)
          const fileUrl = await attempt('file:///etc/hostname')
          const back = await attempt(args.siteUrl)
          return { otherSite, fileUrl, back }
        }, 45_000)
        check('a site outside the grant is refused: loadURL rejects and the shown page stays where it was', refused.otherSite === 'rejected (net error) still-at:same', JSON.stringify(refused))
        check('a file: URL is refused the same way', refused.fileUrl === 'rejected (net error) still-at:same', JSON.stringify(refused))
        check('the granted site loads again afterwards', refused.back === 'finished:probe:object:injected-first', JSON.stringify(refused))

        // ---- (5) revoking the grant closes the shown page.
        await evaluateRetrying(view, async () => {
          const el = (window as unknown as { __orivonE2eView: WebviewLike }).__orivonE2eView
          ;(window as unknown as { __orivonE2eDestroyed: Promise<string> }).__orivonE2eDestroyed = new Promise((resolve) => {
            el.addEventListener('destroyed', () => { resolve('destroyed') })
            setTimeout(() => { resolve('still alive') }, 10_000)
          })
          return true
        }, STEP_TIMEOUT_MS)
        const revokeOutcome = await app.evaluate(async (_electron, args: { origin: string, grantId: string }) => {
          const hook = (globalThis as unknown as { __orivonDevRevoke?: (origin: string, grantId: string) => Promise<void> }).__orivonDevRevoke
          if (typeof hook !== 'function') return false
          await hook(args.origin, args.grantId)
          return true
        }, { origin: FIXTURE_ORIGIN, grantId })
        check('the developer-only revoke hook is installed in this build', revokeOutcome)
        const destroyed = await evaluateRetrying(view, async () =>
          await (window as unknown as { __orivonE2eDestroyed: Promise<string> }).__orivonE2eDestroyed, STEP_TIMEOUT_MS)
        check('revoking web.embed destroys the shown page (the element fires "destroyed")', destroyed === 'destroyed', String(destroyed))

        const afterRevoke = await evaluateRetrying(view, async () => {
          const { siteUrl } = (window as unknown as { __orivonE2eArgs: E2eArgs }).__orivonE2eArgs
          const el = document.createElement('webview') as WebviewLike
          const outcome = new Promise<string>((resolve) => {
            el.addEventListener('did-finish-load', () => { resolve('finished') })
            el.addEventListener('did-fail-load', () => { resolve('failed') })
            el.addEventListener('destroyed', () => { resolve('destroyed') })
            setTimeout(() => { resolve('never attached') }, 5_000)
          })
          el.src = siteUrl
          document.body.appendChild(el)
          return await outcome
        }, STEP_TIMEOUT_MS)
        check('after the revoke a new <webview> never shows the site', afterRevoke !== 'finished', afterRevoke)

        // ---- (6) an ordinary tab's <webview> is inert: navigate this tab to the shown site itself, as a plain website.
        const chromeTab = await navigateToFixture(app, `${SITE_ORIGIN}/`, 'probe:undefined:-')
        const inert = await evaluateRetrying(chromeTab, () => {
          const el = document.createElement('webview') as WebviewLike
          return { live: typeof el.loadURL === 'function', title: document.title }
        }, STEP_TIMEOUT_MS)
        check('in an ordinary tab <webview> is an unknown element with no loadURL, and no script was injected there', !inert.live && inert.title === 'probe:undefined:-', JSON.stringify(inert))
      } finally {
        clearFixtureAsPageScript()
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)

// A286: a "*" grant reaches an ordinary DNS name (embed-origin.ts's own
// hostname gate has nothing to refuse -- it is not a localhost name and not
// an address literal), so admitting it must now go through the guest
// session's OWN resolveHost before the load proceeds. Its own launch and
// its own --host-resolver-rules, on top of the shared HERMETIC_RESOLVER
// blackhole: REBIND_HOST maps to loopback, everything else stays refused.
it(
  'a "*" grant refuses a document whose host resolves to a loopback address, rather than loading it (A286)',
  async () => {
    await runPhase('web.embed "*" DNS-rebind e2e', async (check) => {
      const app = await launchElectron({
        appPath: '.',
        args: [`--host-resolver-rules=MAP ${REBIND_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`]
      })
      try {
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: FIXTURE_ORIGIN, manifest: wildcardManifest(), capability: 'web.embed', patterns: ['*'] } satisfies DevGrantRequest)
        check('the developer-only grant hook is installed in this build', grantOutcome.installed)
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        const view = await navigateToFixture(app, FIXTURE_URL, 'Orivon fixture app')
        await view.evaluate((url: string) => { (window as unknown as { __orivonE2eRebindUrl: string }).__orivonE2eRebindUrl = url }, REBIND_URL)

        const outcome = await evaluateRetrying(view, async () => {
          const url = (window as unknown as { __orivonE2eRebindUrl: string }).__orivonE2eRebindUrl
          const el = document.createElement('webview') as WebviewLike
          const result = new Promise<string>((resolve) => {
            el.addEventListener('did-finish-load', () => { resolve('finished') })
            el.addEventListener('did-fail-load', (event) => { resolve(`failed:${String((event as unknown as { errorCode: number }).errorCode)}`) })
            setTimeout(() => { resolve('timeout') }, 15_000)
          })
          el.src = url
          el.style.width = '400px'
          el.style.height = '300px'
          document.body.appendChild(el)
          return await result
        }, STEP_TIMEOUT_MS)
        check(
          'a document whose host resolves to a loopback address is refused, never loaded, though "*" admits the hostname itself',
          outcome !== 'finished',
          outcome
        )
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
