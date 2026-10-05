// A286/A284: served .eth content carries frame-ancestors 'self' (server.ts's
// SERVED_CONTENT_CSP), and this proves Chromium actually enforces it, not
// just that Orivon sends the header. Modeled on e2e-eth-partition.test.ts's
// fixture-gateway-plus-plain-server shape.
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from './support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './support/e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'

const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>framing fixture</title><body>framing</body>',
  'framed.html': '<!doctype html><meta charset="utf-8"><title>framed</title><body>framed</body>'
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 4 + APP_CLOSE_RACE_MS + 80_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface ProbeOutcome {
  readonly found: boolean
  readonly frames: readonly string[]
  readonly blocked?: boolean
  readonly committed?: boolean
  readonly failed?: { errorCode: number, errorDescription: string, validatedURL: string }
}

/**
 * Creates an iframe in the page at `pageUrl` (through webContents.executeJavaScript,
 * the same as the page's own script would) with `src` set to `targetUrl`,
 * then races two main-process signals until one settles or `timeoutMs` runs out:
 * - `did-fail-load` (isMainFrame: false) for that url -- a frame-ancestors
 *   refusal is a navigation that fails before it commits, and this is
 *   Electron's own documented way to observe that;
 * - `targetUrl` appearing, committed, in `webContents.mainFrame.frames` --
 *   polling alone cannot distinguish "blocked" from "hasn't finished
 *   loading yet", so it is read only as the SUCCESS signal, raced against
 *   the failure one, never on its own.
 */
async function probeFrame (app: ElectronApplication, pageUrl: string, targetUrl: string, timeoutMs: number): Promise<ProbeOutcome> {
  return await app.evaluate(async ({ webContents }, args) => {
    const { pageUrl, targetUrl, timeoutMs } = args
    const wc = webContents.getAllWebContents().find((c) => c.getURL() === pageUrl)
    if (wc === undefined) return { found: false, frames: [] }
    const settled = await new Promise<{ blocked?: boolean, committed?: boolean, failed?: { errorCode: number, errorDescription: string, validatedURL: string } }>((resolve) => {
      let done = false
      const finish = (result: { blocked?: boolean, committed?: boolean, failed?: { errorCode: number, errorDescription: string, validatedURL: string } }): void => {
        if (done) return
        done = true
        clearInterval(poll)
        clearTimeout(timer)
        wc.removeListener('did-fail-load', onFail)
        resolve(result)
      }
      const onFail = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean): void => {
        if (!isMainFrame && validatedURL.startsWith(targetUrl)) finish({ blocked: true, failed: { errorCode, errorDescription, validatedURL } })
      }
      wc.on('did-fail-load', onFail)
      const poll = setInterval(() => {
        if (wc.mainFrame.frames.some((f) => f.url === targetUrl)) finish({ committed: true })
      }, 100)
      const timer = setTimeout(() => { finish({}) }, timeoutMs)
      void wc.executeJavaScript(`(() => {
        const frame = document.createElement('iframe')
        frame.src = ${JSON.stringify(targetUrl)}
        document.body.appendChild(frame)
      })()`)
    })
    return { found: true, frames: wc.mainFrame.frames.map((f) => f.url), ...settled }
  }, { pageUrl, targetUrl, timeoutMs })
}

it("refuses to frame served .eth content from another origin, though the site's own path may frame itself", async () => {
  await runPhase('eth-framing', async (check) => {
    const gateway = await startFixtureGateway({ framing: SITE })
    const root = gateway.roots['framing']!
    const framer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>framer</title><body>framer</body>') })
    await new Promise<void>((resolve) => { framer.listen(0, '127.0.0.1', resolve) })
    const framerUrl = `http://127.0.0.1:${String((framer.address() as AddressInfo).port)}/`
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'framing.eth': `ipfs://${root}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')

      // Case A: a plain site's page frames the .eth site -- refused.
      await navigateToFixture(app, framerUrl, 'framer')
      const blocked = await probeFrame(app, framerUrl, 'https://framing.eth/', 8_000)
      check('the framer tab was found in the main process', blocked.found, JSON.stringify(blocked))
      check("frame-ancestors 'self' blocked it: did-fail-load fired for the subframe before it could commit", blocked.blocked === true, JSON.stringify(blocked))
      check('the .eth origin never committed as a child frame', blocked.committed !== true, JSON.stringify(blocked.frames))

      // Case B: the .eth site frames its own path -- allowed.
      await navigateToFixture(app, 'https://framing.eth/', 'framing fixture')
      const framedUrl = 'https://framing.eth/framed.html'
      const selfFramed = await probeFrame(app, 'https://framing.eth/', framedUrl, 8_000)
      check('the .eth tab was found in the main process, for the same-origin case', selfFramed.found, JSON.stringify(selfFramed))
      check("framing its own path committed: frame-ancestors 'self' allows same-origin framing", selfFramed.committed === true, JSON.stringify(selfFramed))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      framer.close()
    }
  })
}, TEST_TIMEOUT_MS)
