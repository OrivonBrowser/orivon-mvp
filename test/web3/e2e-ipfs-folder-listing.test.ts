// An `ipfs://` folder with no index.html opens as a listing of its files, as a public gateway shows one: a
// sub-folder link opens that folder's listing, and a file in it downloads under its own name. Every block the
// listing needs comes through the verifier like any content.
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, DEFAULT_ACTION_TIMEOUT_MS, launchElectron } from '../support/launch-electron.mjs'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { openInternalPage, removeDir, scratchDir, stubSystem } from '../library/downloads-fixture.js'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 90_000
const PACKAGE = new Uint8Array(300_000).map((_, i) => (i * 17) % 251)
const ARCHIVE = new Uint8Array(1_000).map((_, i) => (i * 3) % 251)

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const rowsOf = async (page: Page): Promise<string[]> => await page.locator('tr.row .name').allTextContents()
const click = async (page: Page, href: string): Promise<void> => {
  await page.evaluate((target) => { (document.querySelector(`a[href="${target}"]`) as HTMLElement).click() }, href)
}

it('lists a folder without an index.html, follows a sub-folder, and downloads a file under its own name', async () => {
  await runPhase('ipfs-folder-listing', async (check) => {
    const downloads = await scratchDir('orivon-listing-')
    const gateway = await startFixtureGateway({
      release: {
        'Orivon-0.0.8-x86_64.AppImage': PACKAGE,
        'my package.zip': ARCHIVE,
        'docs/guide.txt': 'the guide',
        'docs/more/deep.txt': 'deep'
      }
    })
    const root = gateway.roots['release']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        },
        seedProfile: async (dir: string) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': downloads } })) }
      })
      const running = app
      await stubSystem(running)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${root}`)
      const origin = `https://${root}.ipfs.orivon`
      expect(await waitFor(() => findViewShowing(running, chrome, `${origin}/`) !== undefined, 60_000)).toBe(true)
      const listing = findViewShowing(running, chrome, `${origin}/`) as Page
      await listing.waitForSelector('tr.row')
      check('the heading names the folder', (await listing.locator('h1').textContent()) === 'Index of /')
      check('folders come first, then files by name', JSON.stringify(await rowsOf(listing)) === JSON.stringify(['docs/', 'Orivon-0.0.8-x86_64.AppImage', 'my package.zip']))
      check('a file shows the size read from its own node', (await listing.locator('tr.row', { hasText: 'AppImage' }).locator('.size').textContent()) === '300.0 kB')
      check('the listing is not the Nothing here page', !(await listing.content()).includes('Nothing here'))

      await click(listing, 'docs/')
      expect(await waitFor(() => findViewShowing(running, chrome, `${origin}/docs/`) !== undefined, 60_000)).toBe(true)
      const docs = findViewShowing(running, chrome, `${origin}/docs/`) as Page
      await docs.waitForSelector('tr.row')
      check('a sub-folder opens its own listing, with a way up', (await docs.locator('h1').textContent()) === 'Index of /docs/' && (await docs.locator('a[href="../"]').count()) === 1)
      check('the sub-folder lists its entries', JSON.stringify(await rowsOf(docs)) === JSON.stringify(['more/', 'guide.txt']))

      await click(docs, '../')
      expect(await waitFor(() => findViewShowing(running, chrome, `${origin}/`) !== undefined && findViewShowing(running, chrome, `${origin}/docs/`) === undefined, 60_000)).toBe(true)
      const back = findViewShowing(running, chrome, `${origin}/`) as Page
      await back.waitForSelector('tr.row')

      // A package that runs code is held under a temporary name until the person answers; its row carries the name it will keep.
      await click(back, 'Orivon-0.0.8-x86_64.AppImage')
      const list = await openInternalPage(running, chrome, 'downloads')
      await list.waitForSelector('.download')
      expect(await waitFor(async () => (await list.locator('.download .dl-name').allTextContents()).includes('Orivon-0.0.8-x86_64.AppImage'), 60_000)).toBe(true)

      await click(back, 'my%20package.zip')
      // Waiting for the file under this exact name is the check: a name taken from the encoded link would be `my%20package.zip`.
      expect(await waitFor(async () => (await stat(join(downloads, 'my package.zip')).catch(() => ({ size: -1 }))).size === ARCHIVE.length, 60_000)).toBe(true)
      check('the downloaded bytes are the file', Buffer.from(ARCHIVE).equals(await readFile(join(downloads, 'my package.zip'))))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      await removeDir(downloads)
    }
  })
}, TEST_TIMEOUT_MS)
