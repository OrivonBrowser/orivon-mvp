// What a tab actually sends and sees on a sign-in host, measured against a
// local fixture standing in for one via ORIVON_TEST_SIGN_IN_HOSTS
// (src/main/shell/sign-in-identity-test-seam.ts) -- never a real Google
// host. Never touches accounts.google.com or any other Google host.
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { launchElectron, closeElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, waitFor } from './smoke-helpers.mjs'

/** Waits up to 10 s for the shell window: launchElectron() can resolve before
 * the chrome view's target is attached, so the first look may find none. */
async function findChromeRetrying (app: import('playwright').ElectronApplication): Promise<ReturnType<typeof findChrome>> {
  const ok = await waitFor(async () => app.windows().some((w: any) => w.url().endsWith('/renderer/index.html')), 10_000)
  if (!ok) throw new Error('chrome view never appeared within 10s')
  return findChrome(app)
}

interface HeaderServer { port: number, close: () => void, documentHeaders: () => http.IncomingHttpHeaders | undefined, hits: string[], redirectTo: (location: string) => void }

/** `/leave` answers 302 to wherever `redirectTo` says, the way a sign-in host sends a tab on once it is done. */
async function startHeaderServer (rootDelayMs = 0): Promise<HeaderServer> {
  let last: http.IncomingHttpHeaders | undefined
  let leaveTo = '/'
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/') last = req.headers
    if (req.url === '/leave') {
      res.writeHead(302, { location: leaveTo }).end()
      return
    }
    res.setHeader('content-type', 'text/html')
    const body = '<!doctype html><title>fixture</title><body>fixture-ok</body>'
    if (req.url === '/' && rootDelayMs > 0) setTimeout(() => res.end(body), rootDelayMs)
    else res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, close: () => { server.close() }, documentHeaders: () => last, hits, redirectTo: (location) => { leaveTo = location } }
}

/** How long a submit gets to show up as a tab before the helper tries once more. */
const SUBMIT_GRACE_MS = 5000

/** Submits the address bar, and once more after SUBMIT_GRACE_MS if no tab whose URL contains `needle` exists: the
 * first submit can land before the chrome view has wired its form handler. Every submit starts a navigation, so
 * submitting again at each poll would send a slow host the same GET several times. */
async function navigateTo (app: import('playwright').ElectronApplication, chrome: any, url: string, needle: string): Promise<void> {
  let lastSubmit = 0
  const appeared = await waitFor(async () => {
    if (app.windows().some((w: any) => w.url().includes(needle))) return true
    if (Date.now() - lastSubmit >= SUBMIT_GRACE_MS) {
      lastSubmit = Date.now()
      await chrome.evaluate((u: string) => {
        const input = document.querySelector('#address') as HTMLInputElement
        input.value = u
        input.dispatchEvent(new Event('focus'))
        const form = document.querySelector('#address-form') as HTMLFormElement
        form.dispatchEvent(new Event('submit', { cancelable: true }))
      }, url)
    }
    return false
  }, 30_000)
  if (!appeared) throw new Error(`no tab matching ${needle} after retrying the address bar`)
}

async function pageReport (tab: any): Promise<{ userAgent: string, hasUserAgentData: boolean, brands: number }> {
  return await evaluateRetrying(tab, () => ({
    userAgent: navigator.userAgent,
    hasUserAgentData: 'userAgentData' in navigator,
    brands: (navigator as any).userAgentData?.brands?.length ?? 0
  }))
}

describe('the Firefox sign-in identity, against local fixtures only', () => {
  // The three parts of the identity: the request headers
  // (sign-in-identity-headers.ts), navigator.userAgent
  // (sign-in-identity-tab.ts) and the absence of navigator.userAgentData
  // (src/preload/sign-in-identity.ts), and their absence off the host.
  it('gives the configured host Firefox headers, navigator.userAgent and no userAgentData, and leaves an unlisted host on Chrome', async () => {
    const signInFixture = await startHeaderServer()
    const plainFixture = await startHeaderServer()
    const app = await launchElectron({
      env: {
        ORIVON_TEST_SIGN_IN_HOSTS: `127.0.0.1:${signInFixture.port}`,
        // Owner rule: no test may make sound.
        PULSE_SERVER: 'unix:/nonexistent'
      },
      args: ['--alsa-output-device=null']
    })
    try {
      const chrome = await findChromeRetrying(app)

      // An unlisted host first, so its request headers are not touched by a
      // tab that has been on a sign-in host.
      await navigateTo(app, chrome, `http://127.0.0.1:${plainFixture.port}/`, String(plainFixture.port))
      const plainTab = app.windows().find((w: any) => w.url().includes(String(plainFixture.port)))
      if (plainTab === undefined) throw new Error('plain fixture tab not found')
      const plainReport = await pageReport(plainTab)
      expect(plainReport.userAgent).toMatch(/Chrome\/\d+\.0\.0\.0/)
      expect(plainReport.userAgent).not.toMatch(/firefox/i)
      expect(plainReport.hasUserAgentData).toBe(true)
      expect(plainReport.brands).toBeGreaterThan(0)
      expect(plainFixture.documentHeaders()?.['user-agent']).toMatch(/Chrome\/\d+\.0\.0\.0/)

      await navigateTo(app, chrome, `http://127.0.0.1:${signInFixture.port}/`, String(signInFixture.port))
      const signInTab = app.windows().find((w: any) => w.url().includes(String(signInFixture.port)))
      if (signInTab === undefined) throw new Error('sign-in fixture tab not found')
      const signInReport = await pageReport(signInTab)
      expect(signInReport.userAgent).toMatch(/^Mozilla\/5\.0 \(.+\) Gecko\/20100101 Firefox\/\d+\.\d+$/)
      expect(signInReport.userAgent).not.toMatch(/chrome/i)
      expect(signInReport.hasUserAgentData).toBe(false)
      const signInHeaders = signInFixture.documentHeaders()
      expect(signInHeaders?.['user-agent']).toMatch(/^Mozilla\/5\.0 \(.+\) Gecko\/20100101 Firefox\/\d+\.\d+$/)
      expect(Object.keys(signInHeaders ?? {}).filter((name) => name.startsWith('sec-ch-ua'))).toEqual([])

      // Leaving the host restores the page-visible identity.
      await navigateTo(app, chrome, `http://127.0.0.1:${plainFixture.port}/?again=1`, 'again=1')
      expect(await waitFor(async () => {
        const tab = app.windows().find((w: any) => w.url().includes('again=1'))
        return tab !== undefined && (await pageReport(tab)).userAgent.includes('Chrome/')
      }, 15_000)).toBe(true)
      const restoredTab = app.windows().find((w: any) => w.url().includes('again=1'))
      expect((await pageReport(restoredTab)).hasUserAgentData).toBe(true)
      expect((await pageReport(restoredTab)).brands).toBe(plainReport.brands)
    } finally {
      signInFixture.close()
      plainFixture.close()
      await closeElectron(app)
    }
  }, 30_000)
  // A server redirect across the sign-in boundary fires no did-start-navigation. Swapping the user
  // agent from will-redirect makes Chromium cancel the redirect and reload the last committed page,
  // which sends the same redirect again: the tab loads forever.
  it('lets a server redirect leave a sign-in host, and enter one, without reloading the page it came from', async () => {
    // A slow first response keeps the tab on its old page past the address-bar helper's first poll, so a helper
    // that submitted again at the first poll would send a second GET / and the count below would be 2.
    const signInFixture = await startHeaderServer(1500)
    const plainFixture = await startHeaderServer()
    const app = await launchElectron({
      env: {
        ORIVON_TEST_SIGN_IN_HOSTS: `127.0.0.1:${signInFixture.port}`,
        PULSE_SERVER: 'unix:/nonexistent'
      },
      args: ['--alsa-output-device=null']
    })
    try {
      const chrome = await findChromeRetrying(app)
      const tabAt = (needle: string): any => app.windows().find((w: any) => w.url().includes(needle))
      const settled = async (needle: string): Promise<boolean> => await waitFor(async () => {
        const tab = tabAt(needle)
        return tab !== undefined && await tab.evaluate(() => document.readyState === 'complete').catch(() => false)
      }, 15_000)

      // Leaving: the sign-in page is served as Firefox, and its redirect sends the tab to a plain host.
      signInFixture.redirectTo(`http://127.0.0.1:${plainFixture.port}/landed`)
      await navigateTo(app, chrome, `http://127.0.0.1:${signInFixture.port}/`, String(signInFixture.port))
      expect(await settled(String(signInFixture.port))).toBe(true)
      expect((await pageReport(tabAt(String(signInFixture.port)))).userAgent).toContain('Firefox/')
      await tabAt(String(signInFixture.port)).evaluate(() => { location.href = '/leave' })
      expect(await settled('/landed')).toBe(true)
      expect(plainFixture.hits.filter((hit) => hit === '/landed')).toHaveLength(1)
      expect(signInFixture.hits.filter((hit) => hit === '/')).toHaveLength(1)
      expect(await waitFor(async () => (await pageReport(tabAt('/landed'))).userAgent.includes('Chrome/'), 15_000)).toBe(true)
      expect((await pageReport(tabAt('/landed'))).userAgent).not.toMatch(/firefox/i)

      // Entering: a plain page's redirect lands on the sign-in host, which must not reload the plain page first.
      plainFixture.redirectTo(`http://127.0.0.1:${signInFixture.port}/entered`)
      await navigateTo(app, chrome, `http://127.0.0.1:${plainFixture.port}/?enter=1`, 'enter=1')
      expect(await settled('enter=1')).toBe(true)
      await tabAt('enter=1').evaluate(() => { location.href = '/leave' })
      expect(await settled('/entered')).toBe(true)
      expect(signInFixture.hits.filter((hit) => hit === '/entered')).toHaveLength(1)
      expect(plainFixture.hits.filter((hit) => hit === '/leave')).toHaveLength(1)
      expect(plainFixture.hits.filter((hit) => hit === '/?enter=1')).toHaveLength(1)
      expect(await waitFor(async () => (await pageReport(tabAt('/entered'))).userAgent.includes('Firefox/'), 15_000)).toBe(true)
    } finally {
      signInFixture.close()
      plainFixture.close()
      await closeElectron(app)
    }
  }, 90_000)
})
