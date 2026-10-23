// A page on one .eth name embeds files straight from other .eth names that no tab has opened: a stylesheet,
// two images, a script and two fetch() calls from each, all requested while the page loads. Every one must load
// on the first launch, however many connections the page opens at once to a name the browser has not yet
// made a TLS session with.
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 90_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const PIXEL = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

/** The other names, each a site of its own with the same files. */
const NAMES = ['pic0', 'pic1', 'pic2', 'pic3']

const hostPage = (): string => `<!doctype html><meta charset="utf-8"><title>first name host</title>
${NAMES.map((name) => `<link rel="stylesheet" href="https://${name}.eth/s.css">`).join('\n')}
<body>
${NAMES.map((name) => `<img class="a" src="https://${name}.eth/p.png"><img class="b" src="https://${name}.eth/p.png?second">`).join('\n')}
${NAMES.map((name) => `<script src="https://${name}.eth/s.js"></script>`).join('\n')}
<script>
window.__out = {}
const names = ${JSON.stringify(NAMES)}
Promise.all(names.flatMap((name) => ['data.txt', 'data.txt?second'].map((path) => {
  // no-cors: the answer is opaque, so only whether the connection worked is read
  return fetch('https://' + name + '.eth/' + path, { mode: 'no-cors' }).then((r) => r.type, (e) => 'ERR ' + String(e))
}))).then((types) => { window.__out.fetches = types; window.__done = true })
</script></body>`

/** What loaded, by name: a stylesheet applies when its name's own variable is set. */
interface Outcome { css: string[], images: number, scripts: number, fetches: string[] }

async function readOutcome (view: Page): Promise<Outcome> {
  await view.waitForFunction(() => (globalThis as { __done?: boolean }).__done === true, undefined, { timeout: 30_000 })
  await view.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 30_000 })
  return await view.evaluate((names) => {
    const out = (globalThis as { __out?: { fetches?: string[] } }).__out ?? {}
    const sheets = [...document.styleSheets].map((sheet) => sheet.href ?? '')
    const applied = names.filter((name) => getComputedStyle(document.body).getPropertyValue(`--${name}`).trim() === 'yes' && sheets.some((href) => href.startsWith(`https://${name}.eth/`)))
    return {
      css: applied,
      images: [...document.images].filter((image) => image.naturalWidth === 1).length,
      scripts: names.filter((name) => (globalThis as Record<string, unknown>)[`loaded_${name}`] === 'yes').length,
      fetches: out.fetches ?? []
    }
  }, NAMES)
}

it('loads every file a page requests at once from .eth names that no tab has opened', async () => {
  await runPhase('eth-subresource-first-name', async (check) => {
    const sites: Record<string, Record<string, string | Uint8Array>> = { host: { 'index.html': hostPage() } }
    for (const name of NAMES) sites[name] = { 'p.png': PIXEL, 's.css': `body{--${name}:yes}`, 's.js': `window.loaded_${name} = "yes"`, 'data.txt': 'pic-data' }
    const gateway = await startFixtureGateway(sites)
    let app: ElectronApplication | undefined
    try {
      const fixtures: Record<string, string> = { 'host.eth': `ipfs://${gateway.roots['host']!}` }
      for (const name of NAMES) fixtures[`${name}.eth`] = `ipfs://${gateway.roots[name]!}`
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify(fixtures),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')
      const view = await navigateToFixture(running, 'https://host.eth/', 'first name host')
      const got = await readOutcome(view)
      check(`every name's stylesheet loads and applies (${JSON.stringify(got.css)})`, got.css.length === NAMES.length)
      check(`every image loads (${String(got.images)} of ${String(NAMES.length * 2)})`, got.images === NAMES.length * 2)
      check(`every script loads and runs (${String(got.scripts)} of ${String(NAMES.length)})`, got.scripts === NAMES.length)
      check(`every fetch is answered (${JSON.stringify(got.fetches)})`, got.fetches.length === NAMES.length * 2 && got.fetches.every((type) => type === 'opaque'))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
