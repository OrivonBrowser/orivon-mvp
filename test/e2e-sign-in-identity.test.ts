// What a tab actually sends and sees on a sign-in host, measured against a
// local fixture standing in for one via ORIVON_TEST_SIGN_IN_HOSTS
// (src/main/shell/sign-in-identity-test-seam.ts) -- never a real Google
// host. Never touches accounts.google.com or any other Google host.
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { launchElectron, closeElectron } from './launch-electron.mjs'
import { findChrome, waitFor } from './smoke-helpers.mjs'

/** launchElectron()'s own wait for a shell window can return early under a
 * slow GPU-context retry at startup (measured: `BaseWindow.getAllWindows()`
 * evaluated over CDP rejects transiently before the render process's target
 * is attached, and the wait reads that rejection as "the process is gone" --
 * its own doc comment's documented risk). Confirmed independent of this
 * file's own code: a bare `launchElectron({})` with no navigation shows the
 * same `windows: []` immediately after resolving, then a real shell window
 * within a couple of seconds. Retried here rather than fixed in
 * launch-electron.mjs, which every other e2e file also depends on. */
async function findChromeRetrying (app: import('playwright').ElectronApplication): Promise<ReturnType<typeof findChrome>> {
  const ok = await waitFor(async () => app.windows().some((w: any) => w.url().endsWith('/renderer/index.html')), 10_000)
  if (!ok) throw new Error('chrome view never appeared within 10s')
  return findChrome(app)
}

async function startHeaderServer (): Promise<{ port: number, close: () => void, documentHeaders: () => http.IncomingHttpHeaders | undefined }> {
  let last: http.IncomingHttpHeaders | undefined
  const server = http.createServer((req, res) => {
    if (req.url === '/') last = req.headers
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>fixture</title><body>fixture-ok</body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, close: () => { server.close() }, documentHeaders: () => last }
}

async function navigate (chrome: any, url: string): Promise<void> {
  await chrome.evaluate((u: string) => {
    const input = document.querySelector('#address') as HTMLInputElement
    input.value = u
    input.dispatchEvent(new Event('focus'))
    const form = document.querySelector('#address-form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
  }, url)
}

async function pageReport (tab: any): Promise<{ userAgent: string, hasUserAgentData: boolean }> {
  return await tab.evaluate(() => ({
    userAgent: navigator.userAgent,
    hasUserAgentData: 'userAgentData' in navigator
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
      await navigate(chrome, `http://127.0.0.1:${plainFixture.port}/`)
      expect(await waitFor(async () => app.windows().some((w: any) => w.url().includes(String(plainFixture.port))))).toBe(true)
      const plainTab = app.windows().find((w: any) => w.url().includes(String(plainFixture.port)))
      if (plainTab === undefined) throw new Error('plain fixture tab not found')
      const plainReport = await pageReport(plainTab)
      expect(plainReport.userAgent).toMatch(/Chrome\/\d+\.0\.0\.0/)
      expect(plainReport.userAgent).not.toMatch(/firefox/i)
      expect(plainReport.hasUserAgentData).toBe(true)
      expect(plainFixture.documentHeaders()?.['user-agent']).toMatch(/Chrome\/\d+\.0\.0\.0/)

      await navigate(chrome, `http://127.0.0.1:${signInFixture.port}/`)
      expect(await waitFor(async () => app.windows().some((w: any) => w.url().includes(String(signInFixture.port))))).toBe(true)
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
      await navigate(chrome, `http://127.0.0.1:${plainFixture.port}/?again=1`)
      expect(await waitFor(async () => {
        const tab = app.windows().find((w: any) => w.url().includes('again=1'))
        return tab !== undefined && (await pageReport(tab)).userAgent.includes('Chrome/')
      })).toBe(true)
      const restoredTab = app.windows().find((w: any) => w.url().includes('again=1'))
      expect((await pageReport(restoredTab)).hasUserAgentData).toBe(true)
    } finally {
      signInFixture.close()
      plainFixture.close()
      await closeElectron(app)
    }
  }, 30_000)
})
