// A page can never reach a port a local node holds. The node keeps what it fetched, so a page that could time
// its answers would learn which sites this computer has opened. An ordinary build chooses the ports when
// Settings asks where IPFS is read from; a stand-in server takes the IPFS node's port, and a page in a tab asks
// it, and asks a control server beside it. Only the control answers; the stand-in never sees the page.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import type { Page } from 'playwright'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const listen = async (server: Server, port = 0): Promise<number> => {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

const answering = (seen: string[]): Server => createServer((request, response) => {
  seen.push(`${request.headers['sec-fetch-site'] ?? 'direct'} ${request.url ?? ''}`)
  response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }).end('ok')
})

it('cancels a page\'s request to the port the IPFS node holds, and no other loopback request', async () => {
  await runPhase('local-node-port-gate', async (check) => {
    const pageServer = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>port gate fixture</title><body>page</body>') })
    const controlSeen: string[] = []
    const control = answering(controlSeen)
    const standInSeen: string[] = []
    const standIn = answering(standInSeen)
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      const pagePort = await listen(pageServer)
      const controlPort = await listen(control)
      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3') })
      let settings: Page | undefined
      await waitFor(() => { settings = running.windows().find((w) => w.url().startsWith('orivon://settings')); return settings !== undefined })
      if (settings === undefined) throw new Error('Settings did not open')
      const servers = settings.locator('#row-web3-servers .value')
      let listed = ''
      await waitFor(async () => { listed = (await servers.textContent().catch(() => '')) ?? ''; return /IPFS node, on this computer: http:\/\/127\.0\.0\.1:\d+/.test(listed) }, 15_000)
      const nodePort = Number(/IPFS node, on this computer: http:\/\/127\.0\.0\.1:(\d+)/.exec(listed)?.[1])
      check(`Settings names the port the IPFS node holds (${String(nodePort)})`, Number.isInteger(nodePort))
      await listen(standIn, nodePort)

      await clickAddressBarRetrying(chrome, `http://127.0.0.1:${String(pagePort)}/`)
      const shown = await waitForTab(chrome, { title: 'port gate fixture' })
      check('a page is open in a tab', shown.ok)
      const view = findViewShowing(app, chrome, `http://127.0.0.1:${String(pagePort)}/`)
      if (view === undefined) throw new Error('no view shows the fixture page')

      const attempt = async (url: string): Promise<'answered' | 'failed'> => await view.evaluate(async (target: string) => {
        try {
          await fetch(target, { mode: 'no-cors', cache: 'no-store' })
          return 'answered'
        } catch {
          return 'failed'
        }
      }, url)
      const toControl = await attempt(`http://127.0.0.1:${String(controlPort)}/page`)
      const toNode = await attempt(`http://127.0.0.1:${String(nodePort)}/health`)
      const toNodeByName = await attempt(`http://localhost:${String(nodePort)}/health`)
      check(`the page reached the control server (${toControl}) and not the node's port (${toNode}, ${toNodeByName})`, toControl === 'answered' && toNode === 'failed' && toNodeByName === 'failed')
      await new Promise((resolve) => setTimeout(resolve, 500))
      check(`the stand-in saw nothing from the page (${JSON.stringify(standInSeen)}), and the control saw the page (${JSON.stringify(controlSeen)})`, standInSeen.length === 0 && controlSeen.length > 0)
      expect(toControl === 'answered' && toNode === 'failed' && toNodeByName === 'failed' && standInSeen.length === 0).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app, APP_CLOSE_RACE_MS)
      for (const server of [pageServer, control, standIn]) server.close()
    }
  })
}, TEST_TIMEOUT_MS)
