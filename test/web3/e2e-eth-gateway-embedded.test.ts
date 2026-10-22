// A `<name>.eth.limo` address inside a page loads as `<name>.eth` too: an image, a stylesheet, a script, a frame and a
// `fetch()` that a page on a `.eth` name, and a page on an ordinary web origin, point at the gateway. The fetch is
// readable across origins, as the gateway's CORS headers make it. With the setting off the same requests stay on the
// gateway. The fixture names are served by the test seam's gateway, and the gateway hosts do not resolve here, so
// content that loads can only have come through the mapping. A second run marks the web page's origin as a public
// address (Chromium's override switch), which is where Local Network Access would act on a page reaching `.eth`
// content, served from loopback.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, findChrome, findViewShowing, HERMETIC_RESOLVER, tabViews, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

/** The gateway address every embed points at: the name `pic.eth`, as the gateway spells it. */
const BASE = 'https://pic.eth.limo'

/** The gateway address of the name the first page itself is served at: a frame of it is a frame of the page's own origin once mapped. */
const SAME = 'https://host.eth.limo'

/** Loads one of each kind of thing from `BASE` and records how each went in `window.__embed`; `window.__embedDone` is set when all have finished. */
const embedScript = (control: string): string => `
const CONTROL = ${JSON.stringify(control)}
const BASE = ${JSON.stringify(BASE)}
const SAME = ${JSON.stringify(SAME)}
const out = {}
window.__embed = out
const settle = (promise, key, read) => promise.then(async (value) => { out[key] = await read(value) }, (error) => { out[key] = 'ERR ' + String(error) })
const element = (tag, props, key) => new Promise((resolve) => {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.onload = () => { out[key] = 'loaded'; resolve(node) }
  node.onerror = () => { out[key] = 'error'; resolve(node) }
  document.body.append(node)
})
Promise.all([
  settle(fetch(CONTROL), 'control', (response) => response.text()),
  settle(fetch(BASE + '/data.txt'), 'fetch', (response) => response.text()),
  settle(fetch(BASE + '/data.txt', { headers: { 'X-Requested-With': 'probe' } }), 'fetchHeader', (response) => response.text()),
  settle(fetch(BASE + '/data.txt', { method: 'POST', body: 'x' }), 'fetchPost', (response) => response.text()),
  settle(fetch(BASE + '/data.txt', { credentials: 'include' }), 'fetchCredentials', (response) => response.text()),
  element('img', { src: BASE + '/p.png' }, 'img').then((img) => { out.imgWidth = img.naturalWidth }),
  element('img', { src: BASE + '/p.png?cors', crossOrigin: 'anonymous' }, 'imgCors').then((img) => { out.imgCorsWidth = img.naturalWidth }),
  element('script', { src: BASE + '/s.js' }, 'script').then(() => { out.scriptRan = window.mappedScript === 'yes' }),
  element('link', { rel: 'stylesheet', href: BASE + '/s.css' }, 'css').then(() => { out.cssApplied = getComputedStyle(document.body).getPropertyValue('--mapped').trim() === 'yes' }),
  element('iframe', { src: BASE + '/frame.html', id: 'framed' }, 'frame'),
  element('iframe', { src: SAME + '/frame.html', id: 'framedSame' }, 'frameSame')
]).then(() => { window.__embedDone = true })
`

const embedPage = (title: string, control: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body><script>${embedScript(control)}</script></body>`

interface EmbedResult {
  control?: string
  fetch?: string
  fetchHeader?: string
  fetchPost?: string
  fetchCredentials?: string
  img?: string
  imgWidth?: number
  imgCors?: string
  imgCorsWidth?: number
  script?: string
  scriptRan?: boolean
  css?: string
  cssApplied?: boolean
  frame?: string
  frameSame?: string
}

async function embedResult (view: Page): Promise<{ result: EmbedResult, frames: string[] }> {
  await view.waitForFunction(() => (globalThis as { __embedDone?: boolean }).__embedDone === true, undefined, { timeout: 30_000 })
  const result = await view.evaluate(() => (globalThis as { __embed?: EmbedResult }).__embed ?? {})
  return { result, frames: view.frames().map((frame) => frame.url()) }
}

async function toggleGatewaySetting (app: ElectronApplication, chrome: Page): Promise<void> {
  await chrome.evaluate(() => {
    (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3')
  })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w: Page) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-web3-eth-gateway')
  await page.locator('#row-web3-eth-gateway input[type=checkbox]').click()
}

/** One launch: a page on a .eth name and a page on an ordinary web origin each load the gateway's copy of `pic.eth`; with `webIsPublic` the web origin is marked as a public address first. */
async function scenario (label: string, webIsPublic: boolean): Promise<void> {
  await runPhase(label, async (check) => {
    // A loopback server that is not marked public and sends CORS headers: what a public page may or may not reach.
    const control = createServer((_request, response) => { response.setHeader('access-control-allow-origin', '*'); response.end('control-data') })
    await new Promise<void>((resolve) => { control.listen(0, '127.0.0.1', resolve) })
    const controlUrl = `http://127.0.0.1:${String((control.address() as AddressInfo).port)}/`
    const gateway = await startFixtureGateway({
      host: { 'index.html': embedPage('eth embed page', controlUrl), 'frame.html': '<!doctype html><title>host frame</title><body>framed</body>' },
      pic: { 'p.png': PIXEL, 's.css': 'body{--mapped:yes}', 's.js': 'window.mappedScript = "yes"', 'data.txt': 'pic-data', 'frame.html': '<!doctype html><title>pic frame</title><body>framed</body>' }
    })
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.url?.startsWith('/csp') === true) response.setHeader('content-security-policy', "default-src * 'unsafe-inline'; img-src https://pic.eth.limo; connect-src https://pic.eth.limo")
      response.end(request.url?.startsWith('/embed') === true || request.url?.startsWith('/csp') === true ? embedPage('web embed page', controlUrl) : '<!doctype html><title>empty</title>')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const loopback = `http://127.0.0.1:${String(port)}`
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER, ...(webIsPublic ? [`--ip-address-space-overrides=127.0.0.1:${String(port)}=public`] : [])],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'host.eth': `ipfs://${gateway.roots['host']!}`, 'pic.eth': `ipfs://${gateway.roots['pic']!}` }),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      const verifyMapped = (what: string, result: EmbedResult, frames: string[], sameFrame: string): void => {
        check(`${what}: an image loads`, result.img === 'loaded' && result.imgWidth === 1)
        check(`${what}: a CORS image loads`, result.imgCors === 'loaded' && result.imgCorsWidth === 1)
        check(`${what}: a script loads and runs`, result.script === 'loaded' && result.scriptRan === true)
        check(`${what}: a stylesheet loads and applies`, result.css === 'loaded' && result.cssApplied === true)
        check(`${what}: a fetch is readable across origins (${String(result.fetch)})`, result.fetch === 'pic-data')
        check(`${what}: a fetch that needs a preflight is refused, since the verifier answers no OPTIONS (${String(result.fetchHeader)})`, String(result.fetchHeader).startsWith('ERR'))
        check(`${what}: a request that is not a GET reaches the verifier, which refuses it, and the answer is readable (${String(result.fetchPost)})`, result.fetchPost === 'only GET and HEAD')
        check(`${what}: a fetch with credentials fails as it does through the gateway, whose answer allows any origin`, String(result.fetchCredentials).startsWith('ERR'))
        check(`${what}: Local Network Access does not stop ${webIsPublic ? 'a page on a public address' : 'the page'} reaching a plain loopback server, so the control and the mapped content both load (${String(result.control)})`, result.control === 'control-data')
        check(`${what}: another origin's frame is refused by the name's frame-ancestors (${JSON.stringify(frames)})`, !frames.includes('https://pic.eth/frame.html'))
        check(`${what}: a frame of the page's own name ${sameFrame === '' ? 'is refused too, since the page is another origin' : 'loads'} (${JSON.stringify(frames)})`, sameFrame === '' ? !frames.includes('https://host.eth/frame.html') : frames.includes(sameFrame))
      }

      // The name the page points at is opened once first: the files of a .eth name that no tab has opened yet load unreliably, mapped or not.
      await clickAddressBarRetrying(chrome, 'pic.eth/data.txt')
      expect((await waitForTab(chrome, { address: 'ipfs://pic.eth/data.txt' }, 30_000)).ok).toBe(true)

      // 1. A page on a .eth name.
      await clickAddressBarRetrying(chrome, 'host.eth')
      expect((await waitForTab(chrome, { title: 'eth embed page' }, 30_000)).ok).toBe(true)
      const hostView = findViewShowing(running, chrome, 'https://host.eth/')
      if (hostView === undefined) throw new Error('the .eth page has no view')
      const onEth = await embedResult(hostView)
      verifyMapped('a .eth page', onEth.result, onEth.frames, 'https://host.eth/frame.html')

      // 2. A page on an ordinary web origin.
      await clickAddressBarRetrying(chrome, `${loopback}/embed`)
      expect((await waitForTab(chrome, { title: 'web embed page' }, 30_000)).ok).toBe(true)
      const webView = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/embed`)
      if (webView === undefined) throw new Error('the web page has no view')
      const onWeb = await embedResult(webView)
      verifyMapped('a web page', onWeb.result, onWeb.frames, '')

      // 2b. A page whose Content-Security-Policy names the gateway.
      // 2b. A page whose Content-Security-Policy names the gateway.
      await clickAddressBarRetrying(chrome, `${loopback}/csp`)
      expect((await waitForTab(chrome, { address: `${loopback}/csp`, title: 'web embed page' }, 30_000)).ok).toBe(true)
      const cspView = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/csp`)
      if (cspView === undefined) throw new Error('the page with a policy has no view')
      const policed = (await embedResult(cspView)).result
      check(`a page whose policy allows the gateway address and not the .eth one has its mapped image and fetch blocked: Chromium checks the policy again at the redirect (${JSON.stringify(policed)})`,
        policed.img === 'error' && policed.imgCors === 'error' && String(policed.fetch).startsWith('ERR'))

      // 3. With the setting off the same requests stay on the gateway, which does not resolve here.
      await toggleGatewaySetting(running, chrome)
      await clickAddressBarRetrying(chrome, `${loopback}/embed?off`)
      expect((await waitForTab(chrome, { address: `${loopback}/embed?off`, title: 'web embed page' }, 30_000)).ok).toBe(true)
      const offView = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/embed?off`)
      if (offView === undefined) throw new Error('the page with the setting off has no view')
      const off = await embedResult(offView)
      await delay(ABSENCE_SETTLE_MS)
      check(`with the setting off nothing is mapped (${JSON.stringify(off.result)} ${JSON.stringify(off.frames)})`,
        off.result.img === 'error' && off.result.script === 'error' && off.result.css === 'error' && String(off.result.fetch).startsWith('ERR') && !off.frames.some((url: string) => url.startsWith('https://pic.eth/')))
      check('the tab is still the page', (await activeTabInfo(chrome)).address === `${loopback}/embed?off`)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      for (const closing of [server, control]) await new Promise<void>((resolve) => { closing.close(() => { resolve() }); closing.closeAllConnections() })
    }
  })
}

it('loads the content of a page from a gateway address as the .eth name, readable across origins', async () => {
  await scenario('eth-gateway-embedded', false)
}, TEST_TIMEOUT_MS)

it('does the same for a web page on a public address', async () => {
  await scenario('eth-gateway-embedded-public', true)
}, TEST_TIMEOUT_MS)
