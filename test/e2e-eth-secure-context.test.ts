// A dev-mode `.eth` tab must be a SECURE CONTEXT, so an app opened by the
// name a port's README gives is the same app as one opened at the loopback
// URL.
//
// Without `--unsafely-treat-insecure-origin-as-secure` the page's origin is
// plain `http:` on a non-loopback host, which Chromium refuses to treat as
// potentially trustworthy however the name resolves. That costs the page
// `navigator.clipboard`, `crypto.subtle`, `crypto.randomUUID` and service
// workers outright -- not denied, ABSENT -- while the identical bundle at
// `127.0.0.1` keeps all four, because Chromium exempts loopback by host.
// This file asserts the divergence is closed.
//
// NO HERMETIC_RESOLVER HERE, deliberately: eth-resolver.ts appends its own
// `--host-resolver-rules` built from the names file, and a second copy of
// that switch on the command line is not additive. The names file is the
// only mapping this test needs, and every name in it points at loopback.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { evaluateRetrying } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'

const HOST = '127.0.0.1'
// 8872-8882 are taken by the fixture apps and their servers.
const PORT = 8884
const ETH_NAME = 'clipboardprobe.eth'
// Trailing slash: compared against what the address bar and the view's own
// url() report after navigation, which Chromium normalises to one.
const ORIGIN = `http://${ETH_NAME}/`
const TITLE = 'eth secure context fixture'

const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title><body>probe</body>`

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 3 + APP_CLOSE_RACE_MS + 30_000

it('serves a dev .eth name as a secure context, so the page keeps the APIs the loopback URL has', async () => {
  await runPhase('eth-secure-context', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let server: Server | undefined
    const dir = mkdtempSync(join(tmpdir(), 'orivon-eth-e2e-'))
    try {
      const namesFile = join(dir, 'names.json')
      writeFileSync(namesFile, JSON.stringify({ [ETH_NAME]: PORT }))

      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE)
      })
      await new Promise<void>((resolve) => { server?.listen(PORT, HOST, resolve) })
      check(`a plain page is served at ${HOST}:${String(PORT)}, which the names file maps ${ETH_NAME} to`, true)

      app = await launchElectron({
        appPath: '.',
        env: { ORIVON_DEV_ORIGINS: '1', ORIVON_ETH_NAMES_FILE: namesFile }
      })

      const view = await navigateToFixture(app, ORIGIN, TITLE)
      check(`the fake name resolved and the page loaded at ${ORIGIN}`, true)

      const environment = await evaluateRetrying(view, () => ({
        isSecureContext: window.isSecureContext,
        clipboard: typeof navigator.clipboard,
        subtle: typeof crypto.subtle,
        randomUUID: typeof crypto.randomUUID
      }))

      check(`window.isSecureContext is true (got ${String(environment.isSecureContext)})`, environment.isSecureContext === true)
      check(`navigator.clipboard exists (got ${String(environment.clipboard)})`, environment.clipboard === 'object')
      check(`crypto.subtle exists (got ${String(environment.subtle)})`, environment.subtle === 'object')
      check(`crypto.randomUUID exists (got ${String(environment.randomUUID)})`, environment.randomUUID === 'function')

      expect(environment).toEqual({
        isSecureContext: true,
        clipboard: 'object',
        subtle: 'object',
        randomUUID: 'function'
      })
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
