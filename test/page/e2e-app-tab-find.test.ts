// Mod+F in a registered app's tab: the key reaches the app first. An app that handles it keeps it, and the
// browser's find bar stays shut; an app that does not leaves the press unhandled, and the bar opens.
//
// The fixture origin is registered through the developer-only grant hook before navigating, as
// e2e-page-buffer.test.ts does: the app-tab flag is fixed when the tab's view is built.
//
// RUN THIS WITH:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/page/e2e-app-tab-find.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { pressKey, waitForKeyboardAt, pressCommand } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../../src/contracts/index.js'
import { delay, evaluateRetrying, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

/** An external script, never inline: a registered app's own policy admits none. */
const HANDLER = `window.__seen = 0
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) { window.__seen += 1; event.preventDefault() }
})`
const OBSERVER = `window.__seen = 0
document.addEventListener('keydown', (event) => { if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) window.__seen += 1 })`

/** Stops the press from bubbling to `window` without handling it: a page that did nothing with the key. */
const STOPPER = `window.__seen = 0
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) { window.__seen += 1; event.stopPropagation() }
})`

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((request, response) => {
    if (request.url === '/handler.js' || request.url === '/observer.js' || request.url === '/stopper.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(request.url === '/handler.js' ? HANDLER : request.url === '/stopper.js' ? STOPPER : OBSERVER)
      return
    }
    const script = request.url === '/handled' ? '/handler.js' : request.url === '/stopped' ? '/stopper.js' : '/observer.js'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>find fixture</title><script src="${script}"></script><body>some words to find</body>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.find-key-e2e',
    name: 'Find key e2e fixture',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } }
  }
}

/** Registers `origin` with an empty grant, so its tab is an app tab and still holds no capability. */
async function register (app: ElectronApplication, origin: string): Promise<boolean> {
  return await app.evaluate(async (_electron, request: DevGrantRequest) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    await hook(request)
    return true
  }, { origin, manifest: manifest(), capability: 'tcp.connect', patterns: [] } satisfies DevGrantRequest)
}

const findShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=find')

it('opens the browser find bar for a Mod+F the app did not use, and leaves one the app handled alone', async () => {
  const { app, chrome } = await launchShell()
  try {
    expect(await register(app, server.origin)).toBe(true)

    const plain = await visit(app, chrome, `${server.origin}/`)
    await pressCommand(app, `${server.origin}/`, 'find.open')
    // The page saw the key, so the browser did not take it.
    expect(await waitFor(async () => (await evaluateRetrying(plain, () => (window as unknown as { __seen: number }).__seen)) === 1)).toBe(true)
    expect(await waitFor(async () => await findShown(app))).toBe(true)
    expect(await waitForKeyboardAt(app, 'overlay=find')).toBe(true)
    await pressKey(app, 'overlay=find', 'Escape')
    expect(await waitFor(async () => !(await findShown(app)))).toBe(true)

    const handled = await visit(app, chrome, `${server.origin}/handled`)
    await pressCommand(app, `${server.origin}/handled`, 'find.open')
    expect(await waitFor(async () => (await evaluateRetrying(handled, () => (window as unknown as { __seen: number }).__seen)) === 1)).toBe(true)
    // An absence cannot be polled for: settle past the preload's own hand-off, then read once.
    await delay(1000)
    expect(await findShown(app)).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens the browser find bar when the app stops the press from bubbling but does not handle it', async () => {
  const { app, chrome } = await launchShell()
  try {
    expect(await register(app, server.origin)).toBe(true)
    const stopped = await visit(app, chrome, `${server.origin}/stopped`)
    await pressCommand(app, `${server.origin}/stopped`, 'find.open')
    expect(await waitFor(async () => (await evaluateRetrying(stopped, () => (window as unknown as { __seen: number }).__seen)) === 1)).toBe(true)
    expect(await waitFor(async () => await findShown(app))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
