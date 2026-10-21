// Zoom in the running shell: a site's level is set with the keys, the mouse
// wheel or the chip, shows on every tab on that site, is written to disk and
// read back at launch, and a page with no site is never zoomed.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, pressCommand } from '../support/e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const servers: Server[] = []
let siteOrigin = ''
let otherOrigin = ''

async function serve (): Promise<string> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><p>a site</p>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  servers.push(server)
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

beforeAll(async () => {
  siteOrigin = await serve()
  otherOrigin = await serve()
})

afterAll(async () => {
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

async function launched (seed?: (dir: string) => Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seed === undefined ? {} : { seedProfile: seed }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const factorAt = async (app: ElectronApplication, urlPart: string): Promise<number | null> =>
  await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))?.getZoomFactor() ?? null, urlPart)

// What the page itself sees: a zoomed page has a narrower viewport in CSS pixels, which a stored factor alone does not prove.
async function viewportWidthAt (app: ElectronApplication, urlPart: string): Promise<number | null> {
  const page = app.windows().find((candidate) => candidate.url().includes(urlPart))
  return page === undefined ? null : await evaluateRetrying(page, () => window.innerWidth)
}

const chip = async (chrome: Page): Promise<string | null> =>
  await evaluateRetrying(chrome, () => { const el = document.querySelector<HTMLElement>('#zoom-chip'); return el === null || el.hidden ? null : el.textContent })

async function seedFiles (dir: string, files: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(content))
}

it('zooms a site with the keys and the chip, shows it on every tab of the site, and writes it down', async () => {
  const { app, chrome } = await launched()
  try {
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    await clickAddressBarRetrying(chrome, `${siteOrigin}/one`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/one` })).ok).toBe(true)
    expect(await chip(chrome)).toBeNull()

    await pressCommand(app, `${siteOrigin}/one`, 'zoom.in')
    expect(await waitFor(async () => Math.abs((await factorAt(app, `${siteOrigin}/one`) ?? 0) - 1.1) < 0.001)).toBe(true)
    expect(await waitFor(async () => await chip(chrome) === '110%')).toBe(true)
    await pressCommand(app, `${siteOrigin}/one`, 'zoom.out')
    await pressCommand(app, `${siteOrigin}/one`, 'zoom.out')
    expect(await waitFor(async () => await chip(chrome) === '90%')).toBe(true)

    // Another tab on the same site shows the same level, another site does not.
    await pressCommand(app, `${siteOrigin}/one`, 'tab.new')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    await clickAddressBarRetrying(chrome, `${siteOrigin}/two`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/two` })).ok).toBe(true)
    expect(await waitFor(async () => Math.abs((await factorAt(app, `${siteOrigin}/two`) ?? 0) - 0.9) < 0.001)).toBe(true)
    await clickAddressBarRetrying(chrome, `${otherOrigin}/`)
    expect((await waitForTab(chrome, { address: `${otherOrigin}/` })).ok).toBe(true)
    expect(await waitFor(async () => await factorAt(app, `${otherOrigin}/`) === 1)).toBe(true)
    expect(await chip(chrome)).toBeNull()

    expect(await waitFor(async () => {
      try { return (JSON.parse(await readFile(join(userData, 'zoom.json'), 'utf8')) as { levels: Record<string, number> }).levels[siteOrigin] === 90 } catch { return false }
    })).toBe(true)

    // The chip puts the site back to actual size, on both of its tabs and in the file.
    await clickAddressBarRetrying(chrome, `${siteOrigin}/two`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/two` })).ok).toBe(true)
    expect(await waitFor(async () => await chip(chrome) === '90%')).toBe(true)
    await chrome.click('#zoom-chip')
    expect(await waitFor(async () => await factorAt(app, `${siteOrigin}/two`) === 1)).toBe(true)
    expect(await waitFor(async () => await chip(chrome) === null)).toBe(true)
    expect(await waitFor(async () => {
      try { return Object.keys((JSON.parse(await readFile(join(userData, 'zoom.json'), 'utf8')) as { levels: Record<string, number> }).levels).length === 0 } catch { return false }
    })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// Chromium zooms on Ctrl and the wheel everywhere but macOS: there the system has its own scroll zoom and Ctrl is the
// context-menu key (WebContentsImpl::HandleWheelEvent), so a wheel turn reaches no zoom handler on that system.
it.skipIf(process.platform === 'darwin')('steps a site with Ctrl and the mouse wheel', async () => {
  const { app, chrome } = await launched()
  try {
    await clickAddressBarRetrying(chrome, `${siteOrigin}/wheel`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/wheel` })).ok).toBe(true)

    const full = await viewportWidthAt(app, `${siteOrigin}/wheel`)
    // A wheel event sent before the page has painted is dropped, so it is sent again until one is heard. One that
    // was heard but is slow shows the chip before the second is sent.
    for (let attempt = 0; attempt < 4 && await chip(chrome) === null; attempt += 1) {
      await app.evaluate(({ webContents }, part) => {
        const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))
        target?.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: -120, wheelTicksY: 1, modifiers: ['control'] })
      }, `${siteOrigin}/wheel`)
      await waitFor(async () => await chip(chrome) !== null, 2500)
    }

    expect(await waitFor(async () => await chip(chrome) === '110%')).toBe(true)
    // One turn is one step for the page as well: the native wheel zoom stacks nothing on top of it.
    const narrowed = await viewportWidthAt(app, `${siteOrigin}/wheel`)
    await delay(400)
    expect(await viewportWidthAt(app, `${siteOrigin}/wheel`)).toBe(narrowed)
    expect(Math.abs((narrowed ?? 0) - (full ?? 0) / 1.1)).toBeLessThanOrEqual(1)
    expect(Math.abs((await factorAt(app, `${siteOrigin}/wheel`) ?? 0) - 1.1)).toBeLessThan(0.001)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a site at the level saved for it, others at the default, and the new-tab page at actual size', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await seedFiles(dir, {
      'zoom.json': { version: 1, levels: { [siteOrigin]: 150 } },
      'settings.json': { version: 1, values: { 'appearance.defaultZoom': '125' } }
    })
  })
  try {
    // The first tab is the new-tab page.
    expect(await waitFor(async () => await factorAt(app, '/newtab/') === 1)).toBe(true)
    expect(await chip(chrome)).toBeNull()

    await clickAddressBarRetrying(chrome, `${siteOrigin}/saved`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/saved` })).ok).toBe(true)
    expect(await waitFor(async () => Math.abs((await factorAt(app, `${siteOrigin}/saved`) ?? 0) - 1.5) < 0.001)).toBe(true)
    expect(await waitFor(async () => await chip(chrome) === '150%')).toBe(true)

    await clickAddressBarRetrying(chrome, `${otherOrigin}/default`)
    expect((await waitForTab(chrome, { address: `${otherOrigin}/default` })).ok).toBe(true)
    expect(await waitFor(async () => Math.abs((await factorAt(app, `${otherOrigin}/default`) ?? 0) - 1.25) < 0.001)).toBe(true)
    expect(await chip(chrome)).toBeNull()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('scales the pixels of the page, not only the stored factor, and keeps the level per site', async () => {
  const { app, chrome } = await launched()
  try {
    await clickAddressBarRetrying(chrome, `${siteOrigin}/pixels`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/pixels` })).ok).toBe(true)
    const full = await viewportWidthAt(app, `${siteOrigin}/pixels`)
    expect(full).toBeGreaterThan(400)

    await pressCommand(app, `${siteOrigin}/pixels`, 'zoom.in')
    await pressCommand(app, `${siteOrigin}/pixels`, 'zoom.in')
    expect(await waitFor(async () => await chip(chrome) === '125%')).toBe(true)
    expect(await waitFor(async () => Math.abs((await viewportWidthAt(app, `${siteOrigin}/pixels`) ?? 0) - (full ?? 0) / 1.25) <= 1)).toBe(true)

    // The level is the site's own: a second page of it opens narrowed, another site opens at full width.
    await clickAddressBarRetrying(chrome, `${siteOrigin}/pixels-again`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/pixels-again` })).ok).toBe(true)
    expect(await waitFor(async () => Math.abs((await viewportWidthAt(app, `${siteOrigin}/pixels-again`) ?? 0) - (full ?? 0) / 1.25) <= 1)).toBe(true)
    await clickAddressBarRetrying(chrome, `${otherOrigin}/pixels`)
    expect((await waitForTab(chrome, { address: `${otherOrigin}/pixels` })).ok).toBe(true)
    expect(await waitFor(async () => await viewportWidthAt(app, `${otherOrigin}/pixels`) === full)).toBe(true)

    // Actual size gives the page its full width back.
    await clickAddressBarRetrying(chrome, `${siteOrigin}/pixels`)
    expect((await waitForTab(chrome, { address: `${siteOrigin}/pixels` })).ok).toBe(true)
    await pressCommand(app, `${siteOrigin}/pixels`, 'zoom.reset')
    expect(await waitFor(async () => await viewportWidthAt(app, `${siteOrigin}/pixels`) === full)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
