// An installed app that holds no grant is asked for a site permission as a website is, and the person's answer is kept;
// an installed app that holds grants has the permissions of its manifest and is never asked by a prompt. Both are served
// from the loader's cache, and the page asks for the same thing: the person's location.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-site-permissions.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, findViewShowing, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { serveApp } from '../node-runtime/pinned-app.js'

const BARE = 'https://app-site-permissions-bare-e2e.orivon.test'
const GRANTED = 'https://app-site-permissions-granted-e2e.orivon.test'

const PAGE = '<!doctype html><title>site permissions</title><body><button id="geo">geo</button><script src="/app.js"></script></body>'
const SCRIPT = `window.__r = {}
document.getElementById('geo').addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition(() => { window.__r.geo = 'position' }, (e) => { window.__r.geo = 'code' + e.code })
})`

let app: ElectronApplication
let chrome: Page

const manifestOf = (id: string, capabilities: Manifest['capabilities']): Manifest => ({ orivonApiVersion: 0, id: `app.orivon.behaviour.${id}`, name: `Behaviour ${id}`, version: '1.0.0', entry: 'index.html', capabilities })
const files = { '/index.html': new TextEncoder().encode(PAGE), '/app.js': new TextEncoder().encode(SCRIPT) }
const promptShown = async (): Promise<boolean> => await popoverShown(app, 'overlay=site-prompt')
const promptPage = (): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=site-prompt') && !w.isClosed()).at(-1)

beforeAll(async () => {
  const launched = await launchShell()
  app = launched.app
  chrome = launched.chrome
  expect(await serveApp(app, BARE, manifestOf('site-permissions-bare', {}), null, files)).toEqual({ granted: true, registered: true })
  const connect = ['site-permissions.test:9']
  expect(await serveApp(app, GRANTED, manifestOf('site-permissions-granted', { net: { tcp: { connect } } }), 'tcp.connect', files, connect)).toEqual({ granted: true, registered: true })
}, 180_000)

afterAll(async () => {
  await app.close().catch(() => {})
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function open (origin: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, `${origin}/`)
  expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${origin}/`) !== undefined)).toBe(true)
  const page = findViewShowing(app, chrome, `${origin}/`) as Page
  await page.waitForLoadState('load')
  return page
}

const result = async (page: Page): Promise<unknown> => {
  expect(await waitFor(async () => await page.evaluate(() => (window as unknown as { __r: Record<string, unknown> }).__r.geo !== undefined))).toBe(true)
  return await page.evaluate(() => (window as unknown as { __r: Record<string, unknown> }).__r.geo)
}

it('[app:installed-app-without-grants-is-asked-as-a-website] an installed app that holds no grant is asked for a site permission, and its answer is kept', async () => {
  const view = await open(BARE)
  expect(await promptShown()).toBe(false)
  await view.click('#geo')
  expect(await waitFor(async () => await promptShown())).toBe(true)
  const prompt = promptPage() as Page
  expect(await prompt.locator('.origin').allTextContents()).toEqual([BARE])
  expect(await prompt.locator('.sp-text').allTextContents()).toEqual(['wants to know your location'])
  await prompt.waitForSelector('.site-prompt:not(.arming)')
  await prompt.click('.btn-row .btn:text-is("Block")')
  expect(await result(view)).toBe('code1')

  await view.reload()
  await view.waitForLoadState('load')
  await view.click('#geo')
  expect(await result(view)).toBe('code1')
  await delay(300)
  expect(await promptShown()).toBe(false)
}, QA_TEST_TIMEOUT_MS)

it('[app:installed-app-without-grants-is-asked-as-a-website] an installed app that holds grants has its manifest\'s permissions and is never asked by a prompt', async () => {
  const view = await open(GRANTED)
  await view.click('#geo')
  expect(await result(view)).toBe('code1')
  expect(await promptShown()).toBe(false)
}, QA_TEST_TIMEOUT_MS)
