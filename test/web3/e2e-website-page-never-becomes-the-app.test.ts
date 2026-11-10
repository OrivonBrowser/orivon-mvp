// A page the browser loaded as a website, before the person allowed the site, never becomes the app by being brought back:
// Back to it after Allow asks the shell's handler for it again, so the file is checked, and its bytes are not the ones the
// session's HTTP cache kept from the website's first visit. The documents are read, not the cache: a document that commits as
// the app with the grants must have come through the shell.
//
// Also pins what the rule depends on: the web-request hook of a session sees the browser's `Sec-Fetch-*` headers on the
// requests it is asked about, with the values the server receives.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-website-page-never-becomes-the-app.test.ts
import { createServer } from 'node:http'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { documentParsed, pageAt, pageValue, withDeclaredTree } from './first-visit-support.js'

type Running = Awaited<ReturnType<typeof launchElectron>>

const files = (name: string, id: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'second.html': `<!doctype html><meta charset="utf-8"><title>${name} second</title><body>second<script src="app.js"></script></body>`,
  'app.js': 'document.body.dataset.app = "ran"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'second.html'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface NavigationFacts { readonly orivon: boolean, readonly delivery: string, readonly transferSize: number, readonly ran: string | null, readonly hasProcess: boolean }

const NAVIGATION_FACTS = '(() => { const nav = performance.getEntriesByType("navigation")[0]; return { orivon: typeof window.orivon === "object" && window.orivon !== null, delivery: nav.deliveryType ?? "", transferSize: nav.transferSize, ran: document.body?.dataset.app ?? null, hasProcess: typeof process !== "undefined" } })()'

/** The newest page under `origin`, and what its document holds, or null when none answers in time. */
async function newestPage (app: Running, origin: string): Promise<{ readonly url: string, readonly facts: NavigationFacts | null } | null> {
  return await app.evaluate(async ({ webContents }, [prefix, code]) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL().startsWith(prefix as string)).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    const facts = await Promise.race([newest.executeJavaScript(code as string).catch(() => null), new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_500))])
    return { url: newest.getURL(), facts: facts as { orivon: boolean, delivery: string, transferSize: number, ran: string | null, hasProcess: boolean } | null }
  }, [origin, NAVIGATION_FACTS] as const).catch(() => null)
}

it('does not let a website page the person went back to after Allow commit from the session\'s cache', async () => {
  await runPhase('website-page-never-becomes-the-app', async (check) => {
    const gateway = await startFixtureGateway({ good: await withDeclaredTree(files('Back app', 'back.app')) })
    let app: Running | undefined
    try {
      const root = gateway.roots['good']!
      const origin = `https://${root}.ipfs.orivon`
      // The download is held back, so the app is served live: the question is the only thing that changes how the pages load.
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' } })
      const running = app
      await stubNativeDialogs(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host listens', listening)
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      // 1. A first visit: the page loads as a website, and so does a second page of the site, behind the question.
      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      await waitQuestion(running, 60_000)
      check('the first page loads as a website', await waitFor(async () => await documentParsed(running, `${origin}/`), 60_000))
      const asWebsite = await pageAt(running, `${origin}/`)
      check(`the first page has no Node globals (${JSON.stringify(asWebsite)})`, asWebsite !== null && !asWebsite.hasProcess)
      await pageValue(running, `${origin}/`, 'location.assign("/second.html"); true')
      check('the second page loads as a website', await waitFor(async () => await documentParsed(running, `${origin}/second.html`), 60_000))

      // 2. Allow. Where the tab lands is the shell's business; it ends in a page of the app, with the two website pages behind it.
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Grant all')
      check('the tab ends in a page of the app', await waitFor(async () => (await newestPage(running, origin))?.facts?.hasProcess === true, 60_000))
      const landed = await newestPage(running, origin)
      check(`the app is entered with its grants (${JSON.stringify(landed)})`, landed?.facts?.orivon === true)

      // 3. Back to a page the session's cache holds from before the answer.
      const before = landed?.url ?? ''
      await running.evaluate(({ webContents }, [prefix, current]) => {
        const found = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === current && contents.getURL().startsWith(prefix as string)).sort((a, b) => b.id - a.id)[0]
        found?.navigationHistory.goBack()
      }, [origin, before] as const)
      check('a page of the website\'s first visit comes back', await waitFor(async () => {
        const back = await newestPage(running, origin)
        return back !== null && back.url !== before && back.facts?.hasProcess === true
      }, 60_000))
      const back = await newestPage(running, origin)
      check(`it has window.orivon and the app tab's globals (${JSON.stringify(back)})`, back?.facts?.orivon === true && back.facts.hasProcess && back.facts.ran === 'ran')
      check(`its document was not read from the cache (${JSON.stringify(back)})`, back?.facts !== undefined && back.facts !== null && back.facts.delivery !== 'cache' && back.facts.transferSize > 0)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)

it('shows the web-request hook of a session the browser\'s Sec-Fetch headers, with the values the server receives', async () => {
  await runPhase('web-request-hook-sees-sec-fetch', async (check) => {
    const received: Array<{ path: string, site: string, mode: string, dest: string }> = []
    const listen = async (name: string, body: (otherPort: number) => string, otherPort = 0): Promise<{ port: number, close: () => void }> => await new Promise((resolve) => {
      const server = createServer((req, res) => {
        received.push({ path: `${name}${req.url ?? ''}`, site: String(req.headers['sec-fetch-site']), mode: String(req.headers['sec-fetch-mode']), dest: String(req.headers['sec-fetch-dest']) })
        res.setHeader('content-type', req.url === '/' || req.url === '/frame' ? 'text/html' : 'text/plain')
        res.end(req.url === '/' || req.url === '/frame' ? body(otherPort) : 'x')
      })
      server.listen(0, '127.0.0.1', () => { resolve({ port: (server.address() as { port: number }).port, close: () => { server.close() } }) })
    })
    const other = await listen('other', () => '<!doctype html><body>other')
    const first = await listen('first', (port) => `<!doctype html><body><img src="/same.png"><img src="http://127.0.0.1:${String(port)}/cross.png"><iframe src="http://127.0.0.1:${String(port)}/frame"></iframe>`, other.port)
    let app: Running | undefined
    try {
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const seen = await app.evaluate(async ({ BrowserWindow, session }, port) => {
        const probe = session.fromPartition('sec-fetch-visible')
        const rows: Array<{ url: string, names: string[], site: string | undefined, dest: string | undefined }> = []
        probe.webRequest.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*', 'http://127.0.0.1:*/*'] }, (details, callback) => {
          const header = (name: string): string | undefined => Object.entries(details.requestHeaders).find(([key]) => key.toLowerCase() === name)?.[1]
          rows.push({ url: details.url, names: Object.keys(details.requestHeaders).map((name) => name.toLowerCase()).filter((name) => name.startsWith('sec-fetch')), site: header('sec-fetch-site'), dest: header('sec-fetch-dest') })
          callback({ requestHeaders: details.requestHeaders })
        })
        const win = new BrowserWindow({ show: false, webPreferences: { session: probe } })
        await win.loadURL(`http://127.0.0.1:${String(port)}/`)
        await new Promise((resolve) => setTimeout(resolve, 2_500))
        win.destroy()
        return rows
      }, first.port)
      const of = (suffix: string): typeof seen[number] | undefined => seen.find((row) => row.url.endsWith(suffix))
      const sent = (path: string): typeof received[number] | undefined => received.find((row) => row.path === path)
      for (const [suffix, path] of [['/same.png', 'first/same.png'], ['/cross.png', 'other/cross.png'], ['/frame', 'other/frame']] as const) {
        const row = of(suffix)
        check(`the hook sees Sec-Fetch-Site, Mode and Dest on ${suffix} (${JSON.stringify(row)})`, row !== undefined && ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].every((name) => row.names.includes(name)))
        check(`and the Site and Dest the server receives for ${suffix}`, row?.site === sent(path)?.site && row?.dest === sent(path)?.dest)
      }
      check('a request for the page itself is marked as the person\'s own navigation', seen.find((row) => row.url.endsWith('/') && row.dest === 'document')?.site === 'none')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      first.close()
      other.close()
    }
  })
}, TEST_TIMEOUT_MS)
