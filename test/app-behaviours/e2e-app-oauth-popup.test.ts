// A sign-in that opens the provider in a popup: a tab runs `window.open` on a click, the popup goes to a provider on
// another origin, the provider sends it back to the page's callback address with a code, and the callback page hands
// the code to the page that opened it and closes. The callback reports twice, through `window.opener.postMessage` when
// it has an opener and through a same-origin BroadcastChannel always, and records which of the two reached the page.
//
// What holds today: a popup an app opens straight at its own callback keeps its opener, and a website's popup keeps it
// through the provider. A popup an app opens at a provider on another origin and that comes back to the app's own
// origin has no opener when it arrives (the shell rebuilds it as an app tab on the way, which cuts the link), so the
// code reaches the app only through the channel. docs/open-questions.md A415 asks which of the two is wanted.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-oauth-popup.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { tabIds, waitFor } from '../support/smoke-helpers.mjs'

const STATE = 'state-7f3a'
const CODE = 'code-91b2'

/** A page's own scripts are files: an installed app's served policy refuses inline script. */
const MAIN_SCRIPT = `window.results = []
const record = (via, data) => { if (data && data.type === 'oauth') window.results.push({ via, code: data.code, state: data.state, hadOpener: data.hadOpener }) }
window.addEventListener('message', (event) => { if (event.origin === location.origin) record('opener', event.data) })
new BroadcastChannel('oauth').addEventListener('message', (event) => { record('channel', event.data) })
document.getElementById('signin').addEventListener('click', () => {
  window.open(document.getElementById('signin').dataset.target, 'oauth', 'width=500,height=600')
})
`
const CALLBACK_SCRIPT = `const params = new URLSearchParams(location.search)
const message = { type: 'oauth', code: params.get('code'), state: params.get('state'), hadOpener: window.opener !== null }
if (window.opener) window.opener.postMessage(message, location.origin)
new BroadcastChannel('oauth').postMessage(message)
window.close()
`

let provider: FixtureServer
const providerSeen: string[] = []
const servers: AppServer[] = []
let shell: ElectronApplication
let chrome: Page

beforeAll(async () => {
  provider = await startServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    providerSeen.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/authorize') {
      // The provider approves at once and sends the popup back with a code, the way a signed-in session does.
      response.writeHead(302, { location: `${url.searchParams.get('redirect_uri') ?? ''}?code=${CODE}&state=${url.searchParams.get('state') ?? ''}` })
      response.end()
    } else html(response, '<!doctype html><title>provider</title>', 404)
  })
  const launched = await launchShell()
  shell = launched.app
  chrome = launched.chrome
}, 120_000)
afterAll(async () => {
  if (shell !== undefined) await closeElectron(shell)
  await Promise.all(servers.map(async (server) => { await server.close() }))
  await provider.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Result { readonly via: string, readonly code: string, readonly state: string, readonly hadOpener: boolean }

/** Opens a page on a fresh origin (an installed app when `installed`), clicks its sign-in button, waits for the popup's `reports` messages and its close, and returns what the page heard. */
async function signIn (options: { installed: boolean, viaProvider: boolean, reports: number }): Promise<{ results: readonly Result[], popupClosed: boolean }> {
  const server = await startAppServer({
    '/': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>app</title><body><button id="signin">sign in</button><script src="/main.js"></script>' },
    '/main.js': { type: 'text/javascript', body: MAIN_SCRIPT },
    '/callback': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>callback</title><body>signing in</body><script src="/callback.js"></script>' },
    '/callback.js': { type: 'text/javascript', body: CALLBACK_SCRIPT }
  })
  servers.push(server)
  if (options.installed) await grantApp(shell, server.origin, appManifest('oauth-popup', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
  const view = await visit(shell, chrome, `${server.origin}/`)
  const callback = `${server.origin}/callback`
  const target = options.viaProvider ? `${provider.origin}/authorize?state=${STATE}&redirect_uri=${encodeURIComponent(callback)}` : `${callback}?code=${CODE}&state=${STATE}`
  await view.evaluate((url) => { (document.getElementById('signin') as HTMLElement).dataset['target'] = url }, target)
  const tabsBefore = (await tabIds(chrome)).length
  await view.click('#signin')
  const read = async (): Promise<Result[]> => await view.evaluate(() => (window as unknown as { results: Result[] }).results)
  expect(await waitFor(async () => (await read()).length >= options.reports), 'the page heard from the popup').toBe(true)
  const popupClosed = await waitFor(async () => (await tabIds(chrome)).length === tabsBefore)
  return { results: await read(), popupClosed }
}

it('[app:oauth-popup-reaches-the-app-by-channel] an installed app opens a provider in a popup, the provider sends it back to the app\'s callback page, and the app receives the code and state there through a same-origin channel, after which the popup closes', async () => {
  const before = providerSeen.length
  const { results, popupClosed } = await signIn({ installed: true, viaProvider: true, reports: 1 })
  expect(providerSeen.length, 'the popup reached the provider').toBe(before + 1)
  // Today the callback page has no opener on arrival (A415), so the channel is the only way the code gets back.
  expect(results, 'one report, by the channel').toEqual([{ via: 'channel', code: CODE, state: STATE, hadOpener: false }])
  expect(popupClosed, 'the popup closed itself').toBe(true)
}, QA_TEST_TIMEOUT_MS)

it('[app:oauth-popup-own-callback-keeps-opener] an installed app\'s popup opened straight at the app\'s own callback page keeps window.opener, and the code reaches the app through it as well as through the channel', async () => {
  const { results, popupClosed } = await signIn({ installed: true, viaProvider: false, reports: 2 })
  expect([...results].sort((a, b) => a.via.localeCompare(b.via))).toEqual([
    { via: 'channel', code: CODE, state: STATE, hadOpener: true },
    { via: 'opener', code: CODE, state: STATE, hadOpener: true }
  ])
  expect(popupClosed, 'the popup closed itself').toBe(true)
}, QA_TEST_TIMEOUT_MS)

it('a website\'s popup that goes through the provider and comes back to the website keeps window.opener, and the code reaches the page through it', async () => {
  const { results, popupClosed } = await signIn({ installed: false, viaProvider: true, reports: 2 })
  expect([...results].sort((a, b) => a.via.localeCompare(b.via))).toEqual([
    { via: 'channel', code: CODE, state: STATE, hadOpener: true },
    { via: 'opener', code: CODE, state: STATE, hadOpener: true }
  ])
  expect(popupClosed, 'the popup closed itself').toBe(true)
}, QA_TEST_TIMEOUT_MS)
