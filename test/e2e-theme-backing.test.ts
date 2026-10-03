// The colour a view or the window shows before a page has painted, in each theme. Lifting Playwright's light
// pin (launch-electron.mjs's `scheme`) is what lets these checks see the dark theme at all; the backing
// colours are read through view-background-test-hook.ts and BaseWindow.getBackgroundColor(), since a settled
// screenshot cannot catch a frame that lasts a moment.

import pngjs from 'pngjs'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setScheme } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './qa-helpers.js'
import { waitFor } from './smoke-helpers.mjs'

const DASHBOARD_BACKGROUND = '#394244'
const WHITE = '#ffffff'
const INTERNAL = { light: '#f4f4f8', dark: '#17181c' }

/** A frame's reported presentation time is when it was due on the screen, a few milliseconds (8.6 at most in 12 measured
 * rounds) ahead of the moment the page can be told of it. */
const PRESENTED_SLACK_MS = 20

type Shell = { orivonShell: { openInternal: (page: string) => void } }

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((_req, res) => {
    html(res, '<!doctype html><meta charset="utf-8"><title>Fixture page</title><body>Plain page with no background of its own</body>')
  })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const dashboardId = (app: ElectronApplication): Promise<number | undefined> =>
  app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/newtab/'))?.id)

const recorded = (app: ElectronApplication, id: number): Promise<string | undefined> =>
  app.evaluate((_e, wcId: number) => (globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds?.get(wcId)?.toLowerCase(), id)

const windowBackground = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase() ?? '')

const scheme = (page: Page): Promise<string> =>
  page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

it('a dark launch shows dark in the chrome and in a tab opened later; the default launch shows light', async () => {
  const dark = await launchShell({ scheme: 'dark' })
  try {
    expect(await scheme(dark.chrome)).toBe('dark')
    const tab = await visit(dark.app, dark.chrome, `${server.origin}/`)
    expect(await scheme(tab)).toBe('dark')
  } finally {
    await closeElectron(dark.app)
  }
  const plain = await launchShell()
  try {
    expect(await scheme(plain.chrome)).toBe('light')
  } finally {
    await closeElectron(plain.app)
  }
}, QA_TEST_TIMEOUT_MS)

for (const mode of ['light', 'dark'] as const) {
  it(`in ${mode}: the dashboard tab's backing follows the page it is going to, and the window behind the views follows the tab shown`, async () => {
    const { app, chrome } = await launchShell({ scheme: mode })
    try {
      let id: number | undefined
      expect(await waitFor(async () => { id = await dashboardId(app); return id !== undefined && (await recorded(app, id)) !== undefined })).toBe(true)
      const dash = id as number
      expect(await recorded(app, dash)).toBe(DASHBOARD_BACKGROUND)
      expect(await windowBackground(app)).toBe(DASHBOARD_BACKGROUND)

      // What the view holds the moment each main-frame navigation starts, read after the shell's own listeners ran.
      await app.evaluate(({ webContents }, wcId: number) => {
        const wc = webContents.fromId(wcId)
        const g = globalThis as unknown as { __orivonDevViewBackgrounds?: Map<number, string>, __startColours?: string[] }
        g.__startColours = []
        wc?.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) g.__startColours?.push(`${details.url}|${g.__orivonDevViewBackgrounds?.get(wcId)?.toLowerCase() ?? ''}`)
        })
      }, dash)
      const startColours = (): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __startColours: string[] }).__startColours)

      const siteUrl = `${server.origin}/`
      await visit(app, chrome, siteUrl)
      expect((await startColours()).find((c) => c.startsWith(siteUrl))).toBe(`${siteUrl}|${WHITE}`)
      expect(await recorded(app, dash)).toBe(WHITE)
      expect(await waitFor(async () => (await windowBackground(app)) === WHITE)).toBe(true)

      await chrome.click('#back')
      expect(await waitFor(async () => (await dashboardId(app)) === dash)).toBe(true)
      const toDashboard = (await startColours()).find((c) => c.includes('/newtab/'))
      expect(toDashboard?.endsWith(`|${DASHBOARD_BACKGROUND}`)).toBe(true)
      expect(await waitFor(async () => (await recorded(app, dash)) === DASHBOARD_BACKGROUND)).toBe(true)
      expect(await waitFor(async () => (await windowBackground(app)) === DASHBOARD_BACKGROUND)).toBe(true)

      await chrome.evaluate((n) => { (window as unknown as Shell).orivonShell.openInternal(n) }, 'history')
      expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL[mode])).toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
}

it('a change of scheme at run time moves the window behind the views with the tab shown', async () => {
  const { app, chrome } = await launchShell({ scheme: 'light' })
  try {
    await chrome.evaluate((n) => { (window as unknown as Shell).orivonShell.openInternal(n) }, 'history')
    expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL.light)).toBe(true)
    await setScheme(app, 'dark')
    expect(await waitFor(async () => (await windowBackground(app)) === INTERNAL.dark)).toBe(true)
    expect(await scheme(chrome)).toBe('dark')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

type NewTabShell = { orivonShell: { newTab: () => void } }

for (const mode of ['light', 'dark'] as const) {
  it(`in ${mode}: opening a new tab never shows the window or the view in a colour other than the dashboard's, and its first paint carries the picture`, async () => {
    const { app, chrome } = await launchShell({ scheme: mode })
    try {
      const dashboards = (): Promise<number[]> =>
        app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getURL().includes('/newtab/')).map((wc) => wc.id))
      expect(await waitFor(async () => (await dashboards()).length === 1)).toBe(true)
      const [first] = await dashboards()

      // Every colour the window and any dashboard view holds, sampled every millisecond from before the tab exists
      // until its page has loaded: a flash lasts a few frames, so the settled state cannot show it.
      await app.evaluate(({ BaseWindow, webContents }) => {
        const g = globalThis as unknown as { __seen: Set<string>, __seenTimer?: NodeJS.Timeout, __orivonDevViewBackgrounds?: Map<number, string> }
        g.__seen = new Set()
        g.__seenTimer = setInterval(() => {
          const win = BaseWindow.getAllWindows()[0]
          if (win === undefined) return
          g.__seen.add(`window ${win.getBackgroundColor().toLowerCase()}`)
          for (const wc of webContents.getAllWebContents()) {
            const colour = g.__orivonDevViewBackgrounds?.get(wc.id)
            if (colour !== undefined && (wc.getURL() === '' || wc.getURL().includes('/newtab/'))) g.__seen.add(`view ${colour.toLowerCase()}`)
          }
        }, 1)
      })
      await chrome.evaluate(() => { (window as unknown as NewTabShell).orivonShell.newTab() })
      expect(await waitFor(async () => (await dashboards()).length === 2)).toBe(true)
      const fresh = (await dashboards()).find((id) => id !== first) as number
      const loaded = await app.evaluate(async ({ webContents }, id: number) => {
        const wc = webContents.fromId(id)
        for (let i = 0; i < 2_000 && wc !== undefined && (wc.isLoading() || wc.getURL() === ''); i++) await new Promise((r) => { setTimeout(r, 5) })
        return wc?.isLoading() === false
      }, fresh)
      expect(loaded).toBe(true)
      const seen = await app.evaluate(() => {
        const g = globalThis as unknown as { __seen: Set<string>, __seenTimer?: NodeJS.Timeout }
        if (g.__seenTimer !== undefined) clearInterval(g.__seenTimer)
        return [...g.__seen].sort()
      })
      expect(seen).toEqual([`view ${DASHBOARD_BACKGROUND}`, `window ${DASHBOARD_BACKGROUND}`])

      // The page itself: its own background is the backing colour, and the fixed layer behind it carries a small copy
      // of the picture inlined in the stylesheet, so the first paint shows the picture instead of a flat colour
      // until the full file is decoded.
      const pages = app.windows().filter((p) => p.url().includes('/newtab/'))
      expect(pages.length).toBe(2)
      for (const page of pages) {
        const style = await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement)
          const layer = getComputedStyle(document.documentElement, '::before')
          return { colour: css.backgroundColor, layerColour: layer.backgroundColor, layerImage: layer.backgroundImage }
        })
        expect(style.colour).toBe('rgb(57, 66, 68)')
        // The wash covers this colour, which composites to the backing colour (#394244): see the pixel check below.
        expect(style.layerColour).toBe('rgb(118, 138, 134)')
        expect(style.layerImage).toContain('data:image/webp')
        // Before the stylesheet is applied the document's canvas is the browser's own dark or white, one frame of
        // near-black under a dark scheme: an inline rule ahead of the stylesheet link paints the same colour then.
        // A single frame cannot be asserted here; it was checked once with a frame capture, and this keeps its cause out.
        const inlineFirst = await page.evaluate(() => {
          const rule = document.head.querySelector('style')
          const sheet = document.head.querySelector('link[rel="stylesheet"]')
          return rule !== null && sheet !== null && (rule.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && /^html\s*\{\s*background:\s*#394244/i.test(rule.textContent ?? '')
        })
        expect(inlineFirst).toBe(true)
      }

      // What the page composites to before any picture layer has decoded: only the wash over the flat base
      // colour. The computed style cannot say (the wash sits over the layer's base), so the pixel is read, with
      // the picture layers taken off. It must equal the colour the shell painted the view with, or the view's
      // colour would step to a darker one in the frame before the picture.
      // A view that is off the screen cannot paint, and its capture waits out its timeout; the page that was in front
      // can still be captured for as long as the new tab holds it, so one or two pages are read.
      let read = 0
      for (const page of pages) {
        await page.evaluate(() => {
          const wash = getComputedStyle(document.documentElement, '::before').backgroundImage.split('), url(')[0] ?? ''
          const style = document.createElement('style')
          style.textContent = `html::before { background-image: ${wash}) !important; }`
          document.head.append(style)
        })
        const shot = await page.screenshot({ clip: { x: 4, y: 4, width: 1, height: 1 }, timeout: 4_000 }).catch(() => null)
        if (shot === null) continue
        read++
        const png = pngjs.PNG.sync.read(shot)
        expect(Math.abs((png.data[0] ?? 0) - 0x39)).toBeLessThanOrEqual(2)
        expect(Math.abs((png.data[1] ?? 0) - 0x42)).toBeLessThanOrEqual(2)
        expect(Math.abs((png.data[2] ?? 0) - 0x44)).toBeLessThanOrEqual(2)
      }
      expect(read).toBeGreaterThanOrEqual(1)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
}

it('a new tab keeps the page in front on the screen until its own page has been presented, and its view is below that page meanwhile', async () => {
  const { app, chrome } = await launchShell({ scheme: 'light' })
  try {
    const dashboards = (): Promise<number[]> =>
      app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getURL().includes('/newtab/')).map((wc) => wc.id))
    expect(await waitFor(async () => (await dashboards()).length === 1)).toBe(true)
    let front = (await dashboards())[0] as number
    let known = await dashboards()

    // Three new tabs in a row, each over the one before: how long the renderer takes varies from tab to tab.
    for (let round = 0; round < 3; round++) {
      // Each millisecond: is the page in front still attached, and is the new tab's view above or below it. The new
      // page's `dom-ready` is stamped from its own event, so the order is not read off the product's signal.
      await app.evaluate(({ app: electronApp, BaseWindow, webContents }, { frontId, knownIds }: { frontId: number, knownIds: number[] }) => {
        type Stamp = { oldGone?: number, ready?: number, newAbove?: boolean, newBelow?: boolean, newId?: number }
        const g = globalThis as unknown as { __stamp: Stamp, __stampTimer?: NodeJS.Timeout }
        g.__stamp = {}
        electronApp.on('web-contents-created', (_event, wc) => {
          wc.once('dom-ready', () => { if (!knownIds.includes(wc.id) && wc.getURL().includes('/newtab/')) g.__stamp.ready ??= Date.now() })
        })
        g.__stampTimer = setInterval(() => {
          const win = BaseWindow.getAllWindows()[0]
          if (win === undefined) return
          const newId = g.__stamp.newId ?? webContents.getAllWebContents().find((wc) => !knownIds.includes(wc.id) && wc.getURL().includes('/newtab/'))?.id
          if (newId === undefined) return
          g.__stamp.newId = newId
          const kids = win.contentView.children.map((child) => (child as unknown as { webContents?: { id: number } }).webContents?.id)
          const old = kids.indexOf(frontId)
          const fresh = kids.indexOf(newId)
          if (old === -1) { g.__stamp.oldGone ??= Date.now(); return }
          if (fresh === -1) return
          if (fresh > old) g.__stamp.newAbove = true
          else g.__stamp.newBelow = true
        }, 1)
      }, { frontId: front, knownIds: known })
      await chrome.evaluate(() => { (window as unknown as NewTabShell).orivonShell.newTab() })
      expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __stamp: { oldGone?: number } }).__stamp.oldGone)) !== undefined)).toBe(true)
      const stamp = await app.evaluate(() => {
        const g = globalThis as unknown as { __stamp: { oldGone?: number, ready?: number, newAbove?: boolean, newBelow?: boolean, newId?: number }, __stampTimer?: NodeJS.Timeout }
        if (g.__stampTimer !== undefined) clearInterval(g.__stampTimer)
        return g.__stamp
      })
      expect(stamp.newBelow).toBe(true)
      expect(stamp.newAbove).not.toBe(true)
      expect(stamp.ready).toBeDefined()
      expect(stamp.oldGone as number).toBeGreaterThanOrEqual(stamp.ready as number)

      // The page in front must not have left before the new page's first content was presented (the renderer's own
      // first-contentful-paint, taken when the frame is on the screen), or the flat colour showed between the two.
      // The page is read after the fact, for how long ago it was presented, so the two clocks (the renderer's and the
      // main process's) are never compared with each other, only durations are, and the time the answer took is given
      // to the product, so the check only fails when the page in front certainly left first.
      const asked = Date.now()
      const sincePresented = await app.evaluate(({ webContents }, newId: number) => {
        const wc = webContents.fromId(newId)
        return wc?.executeJavaScript('(() => { const e = performance.getEntriesByName("first-contentful-paint")[0]; return e === undefined ? null : performance.now() - e.startTime })()') ?? null
      }, stamp.newId as number)
      expect(sincePresented, `round ${String(round)}: the new page had reported no first content when the page in front left`).not.toBeNull()
      expect(asked - (stamp.oldGone as number)).toBeLessThanOrEqual((sincePresented as number) + PRESENTED_SLACK_MS)
      front = stamp.newId as number
      known = await dashboards()
    }
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
